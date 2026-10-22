#!/bin/bash
# Installs the Session → SimpleX bridge on macOS and starts it in the background.
# Re-running is safe: it updates dependencies and restarts the bridge.
#
#   ./install.sh                  normal install
#   KEEP_AWAKE=1 ./install.sh     also keep the Mac from sleeping while on power,
#                                 so messages are forwarded overnight
#   UPDATE_SIMPLEX=1 ./install.sh download the newest simplex-chat CLI again
#
# Network: by default ALL traffic goes through Tor (a bundled tor is downloaded).
#   TOR_SOCKS=127.0.0.1:9050 ./install.sh   use a Tor you already run instead
#   BRIDGE_TOR=off ./install.sh             no Tor: connect directly (shows your IP)
set -euo pipefail

cd "$(dirname "$0")"
DIR="$(pwd)"
LABEL="local.session-simplex-bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/session-simplex-bridge.log"
KEEP_AWAKE="${KEEP_AWAKE:-0}"
BRIDGE_TOR="${BRIDGE_TOR:-on}"
TOR_SOCKS="${TOR_SOCKS:-}"

if [ "$(uname)" != "Darwin" ]; then
  echo "This installer is for macOS. On Linux see README.md (\"Running on a Linux server\")."
  exit 1
fi

echo "==> Bun"
BUN="$(command -v bun || true)"
if [ -z "$BUN" ] && [ -x "$HOME/.bun/bin/bun" ]; then BUN="$HOME/.bun/bin/bun"; fi
if [ -z "$BUN" ]; then
  echo "Installing Bun (https://bun.sh)…"
  curl -fsSL https://bun.sh/install | bash
  BUN="$HOME/.bun/bin/bun"
fi
echo "    $("$BUN" --version) at $BUN"

echo "==> SimpleX CLI"
case "$(uname -m)" in
  arm64) ASSET="simplex-chat-macos-aarch64" ;;
  x86_64) ASSET="simplex-chat-macos-x86-64" ;;
  *) echo "Unsupported CPU: $(uname -m)"; exit 1 ;;
esac
mkdir -p bin
if [ ! -x bin/simplex-chat ] || [ "${UPDATE_SIMPLEX:-0}" = "1" ]; then
  curl -fL --progress-bar -o bin/simplex-chat.download \
    "https://github.com/simplex-chat/simplex-chat/releases/latest/download/$ASSET"
  chmod +x bin/simplex-chat.download
  xattr -d com.apple.quarantine bin/simplex-chat.download 2>/dev/null || true
  mv bin/simplex-chat.download bin/simplex-chat
fi
# The macOS CLI is linked against Homebrew's OpenSSL. Instead of requiring Homebrew,
# put libcrypto in bin/lib and point the binary there.
LIBDIR="$DIR/bin/lib"
bundle_openssl() {
  local old
  old="$(otool -L bin/simplex-chat 2>/dev/null | awk '/libcrypto\.3\.dylib/ {print $1; exit}')"
  if [ -z "$old" ]; then
    old="$(printf '%s' "$1" | grep -o '/[^ ]*libcrypto\.3\.dylib' | head -1)"
  fi
  [ -n "$old" ] || return 1
  echo "    simplex-chat needs OpenSSL; bundling it (no Homebrew needed)"
  if [ ! -f "$LIBDIR/libcrypto.3.dylib" ]; then
    "$BUN" run scripts/fetch-openssl.ts "$LIBDIR" || return 1
  fi
  if [ "$old" != "@executable_path/lib/libcrypto.3.dylib" ] && xcode-select -p >/dev/null 2>&1; then
    install_name_tool -change "$old" "@executable_path/lib/libcrypto.3.dylib" bin/simplex-chat 2>/dev/null || true
  fi
  codesign -f -s - "$LIBDIR/libcrypto.3.dylib" >/dev/null 2>&1 || true
  codesign -f -s - bin/simplex-chat >/dev/null 2>&1 || true
}
run_cli() { DYLD_FALLBACK_LIBRARY_PATH="$LIBDIR" bin/simplex-chat -v 2>&1; }

if ! VERSION="$(run_cli)"; then
  if echo "$VERSION" | grep -q libcrypto || otool -L bin/simplex-chat 2>/dev/null | grep -q libcrypto; then
    bundle_openssl "$VERSION" || true
  fi
  if ! VERSION="$(run_cli)"; then
    echo "simplex-chat does not start:"
    echo "$VERSION" | head -5
    exit 1
  fi
fi
echo "    $VERSION"

echo "==> Dependencies"
"$BUN" install

echo "==> Tor"
TORBIN="$DIR/bin/tor/tor/tor"
run_tor() { DYLD_FALLBACK_LIBRARY_PATH="$DIR/bin/tor/tor" "$TORBIN" --version 2>&1 | head -1; }
if [ "$BRIDGE_TOR" = "off" ]; then
  echo "    Turned off (BRIDGE_TOR=off). The bridge connects directly and your IP is visible."
elif [ -n "$TOR_SOCKS" ]; then
  echo "    Using your existing Tor at $TOR_SOCKS"
else
  if [ ! -x "$TORBIN" ] || [ "${UPDATE_TOR:-0}" = "1" ]; then
    "$BUN" run scripts/fetch-tor.ts "$DIR/bin/tor"
  fi
  xattr -dr com.apple.quarantine bin/tor 2>/dev/null || true
  if ! TORV="$(run_tor)" || ! echo "$TORV" | grep -q "^Tor version"; then
    codesign -f -s - bin/tor/tor/*.dylib "$TORBIN" >/dev/null 2>&1 || true
    if ! TORV="$(run_tor)" || ! echo "$TORV" | grep -q "^Tor version"; then
      echo "    tor does not start:"
      echo "$TORV"
      exit 1
    fi
  fi
  echo "    $TORV (all traffic will go through Tor)"
fi

echo "==> Setup"
"$BUN" run src/setup.ts

echo "==> Background service"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
ARGS=""
if [ "$KEEP_AWAKE" = "1" ]; then
  ARGS="<string>/usr/bin/caffeinate</string><string>-s</string>"
fi
ARGS="$ARGS<string>$(xml "$BUN")</string><string>run</string><string>$(xml "$DIR/src/main.ts")</string>"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>$ARGS</array>
  <key>WorkingDirectory</key><string>$(xml "$DIR")</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$(xml "$LOG")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOG")</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>BRIDGE_TOR</key><string>$(xml "$BRIDGE_TOR")</string>
    <key>TOR_SOCKS</key><string>$(xml "$TOR_SOCKS")</string>
  </dict>
</dict>
</plist>
EOF
plutil -lint "$PLIST" >/dev/null

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
# Remove a service left by an earlier version under a different name.
for OLD in "$HOME"/Library/LaunchAgents/*.session-simplex-bridge.plist; do
  [ -e "$OLD" ] && [ "$OLD" != "$PLIST" ] || continue
  launchctl bootout "gui/$(id -u)" "$OLD" 2>/dev/null || true
  rm -f "$OLD"
done
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "    Running. Log: $LOG"
[ "$KEEP_AWAKE" = "1" ] && echo "    Keeps the Mac awake while it is on power."

echo "==> Pairing"
"$BUN" run src/pair.ts
