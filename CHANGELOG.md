# Changelog

## 0.3.0

- **Health alerts:** if Session can't be reached for 30 minutes, the bridge tells you in SimpleX (with the reason), reminds you every 6 hours, and sends "reachable again" afterwards. Time the Mac spends asleep isn't counted. `HEALTH_ALERT_MINUTES` changes the time, `0` turns it off.
- **Faster recovery from failed polls:** retries after 3, 6, 12, 24, then every 30 seconds (before: up to 2 minutes), and from the second failure on uses a fresh Tor circuit.
- **`bun run verify`:** checks the running bridge's real connections (bridge and SimpleX CLI may only talk to the local Tor port, Tor is the only one allowed outside) and asks check.torproject.org through the bridge's Tor.
- **Fix:** with Tor on, the bridge now refuses to start when `NO_PROXY` is set. Bun skips the proxy for hosts matching `NO_PROXY`, which would have bypassed Tor when starting the bridge by hand. The background service was never affected (launchd starts it with a clean environment).
- **Tests and CI:** `bun run test` covers the bridge logic, the health logic, the verify checks and the Tor kill switch (fail-closed, unresolved hostnames, pinned seed upgrade). GitHub Actions runs them on Linux and macOS, plus a type check.

## 0.2.0

- Tor-only mode for all traffic (Session and SimpleX), fail-closed, with a bundled Tor and pinned seed certificates.
- No Homebrew needed (OpenSSL is built or bundled by the installer).
- Rewritten README.

## 0.1.0

- First version: Session messages forwarded to one SimpleX chat, replies by quoting, files, offline catch-up, LaunchAgent.
