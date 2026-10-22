#!/bin/bash
# Stops the bridge and removes the background service.
#   ./uninstall.sh          keep your data (Session identity, SimpleX database, contacts)
#   ./uninstall.sh --purge  also delete all data and the Keychain entries
set -euo pipefail

LABEL="local.session-simplex-bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DATA="$HOME/Library/Application Support/session-simplex-bridge"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
for OLD in "$HOME"/Library/LaunchAgents/*.session-simplex-bridge.plist; do
  [ -e "$OLD" ] || continue
  launchctl bootout "gui/$(id -u)" "$OLD" 2>/dev/null || true
  rm -f "$OLD"
done
echo "Bridge stopped and removed from login items."

if [ "${1:-}" = "--purge" ]; then
  echo
  echo "This deletes the bridge's Session identity. Unless you backed up the recovery"
  echo "phrase, nobody will be able to reach that Session ID again."
  read -r -p "Type DELETE to continue: " answer
  if [ "$answer" = "DELETE" ]; then
    rm -rf "$DATA"
    security delete-generic-password -s session-simplex-bridge -a session-mnemonic >/dev/null 2>&1 || true
    security delete-generic-password -s session-simplex-bridge -a simplex-db-key >/dev/null 2>&1 || true
    rm -f "$HOME/Library/Logs/session-simplex-bridge.log"
    echo "All bridge data deleted."
  else
    echo "Kept your data."
  fi
else
  echo "Your data is still in: $DATA"
fi
