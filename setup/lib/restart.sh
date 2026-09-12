#!/usr/bin/env bash
# Restart this checkout and require a response from a new host instance.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
# Always derive labels from this script's checkout, even when called elsewhere.
export NANOCLAW_PROJECT_ROOT="$root"
# shellcheck source=/dev/null
source "$here/install-slug.sh"

channel=""
if [ "$#" -gt 0 ]; then
  if [ "$#" -ne 2 ] || [ "$1" != "--channel" ] || [ -z "$2" ]; then
    echo "Usage: restart.sh [--channel <adapter-instance>]" >&2
    exit 64
  fi
  channel="$2"
fi
previous="$(node "$here/host-status.mjs" snapshot "$root" 2>/dev/null || true)"

restarted=false
case "$(uname -s)" in
  Darwin)
    if launchctl kickstart -k "gui/$(id -u)/$(launchd_label)" 2>/dev/null; then restarted=true; fi
    ;;
  Linux)
    unit="$(systemd_unit)"
    if systemctl --user cat "$unit" >/dev/null 2>&1; then
      systemctl --user restart "$unit"
      restarted=true
    elif systemctl cat "$unit" >/dev/null 2>&1; then
      if [ "$(id -u)" = 0 ]; then systemctl restart "$unit"; else sudo -n systemctl restart "$unit"; fi
      restarted=true
    fi
    ;;
esac

# Linux installs without a usable systemd user bus run through the generated
# nohup wrapper. Restart that exact checkout when no service manager accepted
# the request; otherwise channel installs would leave the old host running.
if [ "$restarted" = false ] && [ -x "$root/start-nanoclaw.sh" ]; then
  if "$root/start-nanoclaw.sh"; then
    restarted=true
  else
    echo "nanoclaw: nohup fallback restart failed" >&2
    exit 1
  fi
fi

if [ "$restarted" = false ]; then
  echo "nanoclaw: no installed service or nohup launcher to restart" >&2
  exit 1
fi

if [ -n "$channel" ]; then
  node "$here/host-status.mjs" wait "$root" --previous "$previous" --channel "$channel"
else
  node "$here/host-status.mjs" wait "$root" --previous "$previous"
fi
