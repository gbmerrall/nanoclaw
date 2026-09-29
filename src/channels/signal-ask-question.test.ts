/**
 * Signal's ask_question fallback.
 *
 * Signal renders no interactive cards. Before this path existed, `deliver()`
 * read only `content.text` and never looked at `message.kind`, so an approval
 * card — whose payload has no `text` key — matched neither the text nor the
 * attachment branch. It returned `undefined` without throwing, which meant
 * `requestApproval`'s catch never fired: the pending_approvals row stayed
 * `pending` with a null platform_message_id, the admin saw nothing, and the
 * requesting agent was never told. A silent drop, no error anywhere.
 *
 * These tests drive the real adapter against a loopback socket speaking
 * signal-cli's newline-delimited JSON-RPC, rather than mocking node:net. That
 * way the send path, the notification path, and the reply interception are all
 * the production code — a regression that reintroduces the silent drop goes
 * red here.
 */
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter, ChannelSetup, InboundMessage } from './adapter.js';
import { createSignalAdapter, optionToCommand } from './signal.js';

const ACCOUNT = '+15555550123';
const ADMIN = '+15555550999';

/** Approval card options, matching APPROVAL_OPTIONS in modules/approvals/primitive.ts. */
const APPROVAL_OPTIONS = [
  { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve', style: 'primary' },
  { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject', style: 'danger' },
  { label: 'Reject with reason…', selectedLabel: '📝 Rejected (awaiting reason)', value: 'reject_with_reason' },
];

interface FakeDaemon {
  server: Server;
  port: number;
  /** Every `send` RPC the adapter issued, in order. */
  sent: Array<Record<string, unknown>>;
  /** Push a signal-cli `receive` notification at the adapter. */
  push(envelope: Record<string, unknown>): void;
  close(): Promise<void>;
}

async function startFakeDaemon(): Promise<FakeDaemon> {
  const sent: Array<Record<string, unknown>> = [];
  let client: Socket | null = null;
  let timestamp = 1700000000000;

  const server = createServer((socket) => {
    client = socket;
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let idx = buffer.indexOf('\n');
      while (idx !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) {
          const req = JSON.parse(line);
          if (req.method === 'send') sent.push(req.params);
          socket.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { timestamp: ++timestamp } }) + '\n');
        }
        idx = buffer.indexOf('\n');
      }
    });
    socket.on('error', () => {
      /* client teardown races the test's close(); nothing to do */
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  return {
    server,
    port,
    sent,
    push(envelope) {
      client?.write(JSON.stringify({ jsonrpc: '2.0', method: 'receive', params: { envelope } }) + '\n');
    },
    close() {
      client?.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * A Note-to-Self envelope: how an install whose SIGNAL_ACCOUNT is the
 * operator's own number actually receives operator messages. signal-cli
 * reports these as syncMessage.sentMessage addressed to our own account,
 * never as a dataMessage — the shape that made a dataMessage-only
 * interception silently never fire on a real install.
 */
function noteToSelfEnvelope(text: string): Record<string, unknown> {
  return {
    source: ACCOUNT,
    sourceNumber: ACCOUNT,
    syncMessage: {
      sentMessage: { message: text, destination: ACCOUNT, destinationNumber: ACCOUNT, timestamp: Date.now() },
    },
  };
}

/** A signal-cli inbound DM envelope carrying `text` from ADMIN. */
function dmEnvelope(text: string): Record<string, unknown> {
  return {
    source: ADMIN,
    sourceNumber: ADMIN,
    sourceName: 'Admin',
    dataMessage: { message: text, timestamp: Date.now() },
  };
}

describe('optionToCommand', () => {
  it('slugs a plain label', () => {
    expect(optionToCommand('Approve')).toBe('/approve');
  });

  it('collapses whitespace', () => {
    expect(optionToCommand('Reject with reason')).toBe('/reject-with-reason');
  });

  // The approval card's third button is literally "Reject with reason…". The
  // whitespace-only slug the other native adapters use would yield
  // "/reject-with-reason…", which an admin cannot type on a phone keyboard.
  it('drops trailing punctuation so the command stays typable', () => {
    expect(optionToCommand('Reject with reason…')).toBe('/reject-with-reason');
  });
});

describe('signal ask_question delivery', () => {
  let daemon: FakeDaemon;
  let adapter: ChannelAdapter;
  let actions: Array<{ questionId: string; value: string; userId: string }>;
  let inbound: Array<{ platformId: string; msg: InboundMessage }>;

  beforeEach(async () => {
    daemon = await startFakeDaemon();
    actions = [];
    inbound = [];

    adapter = createSignalAdapter({
      cliPath: 'signal-cli',
      account: ACCOUNT,
      tcpHost: '127.0.0.1',
      tcpPort: daemon.port,
      manageDaemon: false,
      signalDataDir: '/tmp/nanoclaw-signal-test',
      maxInlineAttachmentBytes: 1024,
    });

    const setup: ChannelSetup = {
      onInbound: async (platformId, _threadId, msg) => {
        inbound.push({ platformId, msg });
      },
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: (questionId, value, userId) => {
        actions.push({ questionId, value, userId });
      },
    };

    await adapter.setup(setup);
  });

  afterEach(async () => {
    await adapter.teardown?.();
    await daemon.close();
  });

  it('sends an ask_question card as text instead of dropping it', async () => {
    const msgId = await adapter.deliver(ADMIN, null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'appr-test-1',
        title: 'Install Packages Request',
        question: 'Orac wants to install python3.',
        options: APPROVAL_OPTIONS,
      },
    });

    expect(daemon.sent).toHaveLength(1);
    const body = daemon.sent[0].message as string;
    expect(body).toContain('Install Packages Request');
    expect(body).toContain('Orac wants to install python3.');
    expect(body).toContain('/approve');
    expect(body).toContain('/reject');
    expect(body).toContain('/reject-with-reason');

    // The row's platform_message_id comes from this return value; a null one
    // was the visible symptom of the silent drop.
    expect(msgId).toBeTruthy();
  });

  it('routes a slash-command reply to onAction without waking the agent', async () => {
    await adapter.deliver(ADMIN, null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'appr-test-2',
        title: 'Install Packages Request',
        question: 'Orac wants to install python3.',
        options: APPROVAL_OPTIONS,
      },
    });

    daemon.push(dmEnvelope('/approve'));
    await vi.waitFor(() => expect(actions).toHaveLength(1));

    expect(actions[0]).toEqual({ questionId: 'appr-test-2', value: 'approve', userId: ADMIN });

    // The owner DM is wired engage_pattern='.', so forwarding the reply as an
    // ordinary message would also hand the agent a bare "/approve".
    expect(inbound).toHaveLength(0);
  });

  it('forwards an ordinary message normally while a question is outstanding', async () => {
    await adapter.deliver(ADMIN, null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'appr-test-3',
        title: 'Install Packages Request',
        question: 'Orac wants to install python3.',
        options: APPROVAL_OPTIONS,
      },
    });

    daemon.push(dmEnvelope('what are you installing?'));
    await vi.waitFor(() => expect(inbound).toHaveLength(1));

    expect(actions).toHaveLength(0);
    expect((inbound[0].msg.content as { text: string }).text).toBe('what are you installing?');
  });

  it('answers each question once — a repeated command falls through to the agent', async () => {
    await adapter.deliver(ADMIN, null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'appr-test-4',
        title: 'Install Packages Request',
        question: 'Orac wants to install python3.',
        options: APPROVAL_OPTIONS,
      },
    });

    daemon.push(dmEnvelope('/reject'));
    await vi.waitFor(() => expect(actions).toHaveLength(1));
    expect(actions[0].value).toBe('reject');

    daemon.push(dmEnvelope('/reject'));
    await vi.waitFor(() => expect(inbound).toHaveLength(1));
    expect(actions).toHaveLength(1);
  });

  it("answers from Note to Self, where SIGNAL_ACCOUNT is the operator's own number", async () => {
    await adapter.deliver(ACCOUNT, null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'appr-test-nts',
        title: 'Install Packages Request',
        question: 'Orac wants to install cowsay.',
        options: APPROVAL_OPTIONS,
      },
    });

    daemon.push(noteToSelfEnvelope('/approve'));
    await vi.waitFor(() => expect(actions).toHaveLength(1));

    expect(actions[0].questionId).toBe('appr-test-nts');
    expect(actions[0].value).toBe('approve');
    expect(inbound).toHaveLength(0);
  });

  it('still forwards an ordinary Note-to-Self message to the agent', async () => {
    await adapter.deliver(ACCOUNT, null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'appr-test-nts2',
        title: 'Install Packages Request',
        question: 'Orac wants to install cowsay.',
        options: APPROVAL_OPTIONS,
      },
    });

    daemon.push(noteToSelfEnvelope('what is cowsay?'));
    await vi.waitFor(() => expect(inbound).toHaveLength(1));

    expect(actions).toHaveLength(0);
  });

  it('skips an ask_question with no title rather than sending a headless card', async () => {
    const msgId = await adapter.deliver(ADMIN, null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'appr-test-5',
        question: 'no title here',
        options: APPROVAL_OPTIONS,
      },
    });

    expect(msgId).toBeUndefined();
    expect(daemon.sent).toHaveLength(0);
  });
});
