# Session → SimpleX bridge

People write to a Session ID. You read and answer them in SimpleX, for example in a hidden profile.

```
Session contact ──Session──▶ [ bridge on your Mac ] ──SimpleX──▶ your (hidden) SimpleX profile
                ◀──────────                         ◀───────────
```

The bridge holds its own Session identity and its own SimpleX profile. It forwards every Session message into one SimpleX chat and sends your answers back. If the Mac is off or asleep, nothing is lost: Session keeps messages for about 14 days, and SimpleX relays hold your replies until the bridge is back.

## Status

Early and personal-scale: it bridges one person's Session account to their own SimpleX profile. Tested so far:

| Platform | Status |
|---|---|
| macOS on Intel (macOS 15) | Tested and in daily use |
| macOS on Apple Silicon | Should work, not yet tested |
| Linux | Should work (see below), not yet tested |
| Tor mode | Tested against a simulated Tor; not yet run with real Tor |

Issues and pull requests are welcome, especially reports from untested platforms.

## Install (macOS)

1. Put this folder somewhere permanent, e.g. `~/session-simplex-bridge` (the background service runs from here).
2. In Terminal:

   ```bash
   cd ~/session-simplex-bridge
   ./install.sh
   ```

   To forward overnight too, keep the Mac awake while it's plugged in:

   ```bash
   KEEP_AWAKE=1 ./install.sh
   ```

   The installer gets [Bun](https://bun.sh) and the official `simplex-chat` command-line client. If `simplex-chat` needs OpenSSL, the installer puts that one library in `bin/lib`; Homebrew itself isn't needed. On Apple Silicon it uses Homebrew's prebuilt package. On Intel Macs, which Homebrew no longer builds for, it compiles the library from OpenSSL's official source (a few minutes; needs Apple's Command Line Tools). Both downloads are checked against a known SHA-256. Then it asks two questions:
   - **New Session ID or existing one.** A new one is recommended. If you import an account that's also logged in on your phone, messages appear on the phone too.
   - **Display name** your Session contacts will see (optional).

3. **Pair it with your SimpleX profile.** The installer ends with a QR code.
   - In SimpleX, open the hidden profile: in the chat list, type its password into the search field, then switch to it.
   - Tap **+** → **Scan / paste link** and scan the code (or paste the link printed below it).
   - The bridge greets you in a new chat called **Session** and shows its Session ID. Share that ID with people.

   The link works once. Show it again with `bun run pair`.

SimpleX may keep hidden profiles quiet. If you want alerts for bridged messages, check that profile's notification setting.

## Using it

- Every Session message appears in the **Session** chat, labelled with the sender, e.g. `Anna Müller · anna`.
- **Reply to someone:** quote (swipe on) one of their messages and write your answer.
- **A message without a quote** goes to the current chat. The first person who writes becomes the current chat; quoting someone or `/to` switches it. Messages from anyone who isn't the current chat show `↩︎ quote to reply`.
- **Photos, files and voice messages** work both ways (Session accepts up to 10 MB).
- **✅ on your message** means it was delivered to Session. If sending fails, the bridge retries for 24 hours, then tells you.

| Command | What it does |
|---|---|
| `/to <name or Session ID> [text]` | Switch the current chat (and optionally send). A full Session ID starts a new conversation. |
| `/who` | Show the current chat |
| `/list` | All Session contacts the bridge knows |
| `/name <name> <new name>` | Rename a contact's short name |
| `/id` | The Session ID people can write to |
| `/status` | Queues and last successful Session check |
| `/help` | Show help |

To send a message that starts with `/`, write `//`.

Only the SimpleX profile you paired can control the bridge; anything else sent to it is ignored.

## Tor

By default the bridge sends **all** its traffic through Tor and fails closed. If Tor isn't connected, nothing goes out: messages wait (Session keeps them about 14 days) and are delivered once Tor is back.

- `install.sh` downloads the official Tor Expert Bundle (just the `tor` program) from torproject.org, checked against a pinned SHA-256. The bridge runs it as a child process with its own data folder. Tor stops when the bridge stops.
- **SimpleX:** the CLI is started with `--socks-proxy … --socks-mode always --host-mode onion`, so every relay and file connection goes through Tor, using the relays' `.onion` addresses where they have one.
- **Session:** every request the Session library makes is forced through a local proxy that only talks to Tor's SOCKS port, with hostnames resolved by Tor. This applies even to requests that don't ask for a proxy. The seed-node request, which Session.js makes over plain HTTP, is upgraded to HTTPS with the seeds' pinned certificates (as Session Desktop does), so a Tor exit relay can't hand you a fake node list.
- `/status` shows whether Tor is connected.

What Tor doesn't hide: Session's service nodes (and the Tor exit in front of them) still see which Session ID is being checked and when. That's how Session works for every client, but they don't learn your IP. Message contents stay end-to-end encrypted.

Options when installing:

| | |
|---|---|
| `TOR_SOCKS=127.0.0.1:9050 ./install.sh` | Use a Tor you already run (e.g. Tor Browser: `127.0.0.1:9150`, only while it's open) |
| `BRIDGE_TOR=off ./install.sh` | No Tor, connect directly (your IP is visible) |
| `UPDATE_TOR=1 ./install.sh` | Download the Tor bundle again (to update, change the version and hashes in `scripts/fetch-tor.ts`) |

## Day to day

| Task | Command |
|---|---|
| Watch the log | `tail -f ~/Library/Logs/session-simplex-bridge.log` |
| Restart | `launchctl kickstart -k gui/$(id -u)/local.session-simplex-bridge` |
| Pair a different SimpleX profile | `bun run pair --reset` |
| Show the recovery phrase (back it up!) | `security find-generic-password -s session-simplex-bridge -a session-mnemonic -w` |
| Update SimpleX CLI | `UPDATE_SIMPLEX=1 ./install.sh` |
| Remove (keep data) | `./uninstall.sh` |
| Remove everything | `./uninstall.sh --purge` |

The bridge starts automatically at login and restarts if it crashes.

## What to know about privacy

- **The bridge breaks end-to-end encryption by design.** Messages are decrypted on your Mac and re-encrypted for the other network. Anyone who controls your Mac can read them.
- **What's stored:** the Session recovery phrase and the SimpleX database passphrase are in your login Keychain. The SimpleX database is encrypted. Bridge state (contact names and IDs, queued messages until they're delivered) is in `~/Library/Application Support/session-simplex-bridge`, readable only by your user. Forwarded files are deleted once they're uploaded. The log never contains message text.
- **Your IP address: everything goes through Tor.** See "Tor" below. Neither Session nor SimpleX servers see your IP, and nothing on your Mac looks up their hostnames.
- **Your SimpleX profiles stay separate.** The bridge only knows the one chat with you. It can't see which profile it's in, or that the profile is hidden.
- **Unofficial library:** the Session side uses [Session.js](https://sessionjs.github.io/docs/), a third-party library. If Session changes its protocol, the bridge can stop working until Session.js is updated (`bun update`).

## Running on a Linux server instead

Same code, no launchd. Install [Bun](https://bun.sh) and the `simplex-chat` CLI for your platform (put it at `bin/simplex-chat` or set `SIMPLEX_BIN`). Then:

```bash
bun install
bun run setup     # secrets go to a 0600 file in ~/.local/share/session-simplex-bridge
bun run start     # run under systemd or similar
bun run pair      # in a second terminal, to show the QR code
```

Settings (environment variables): `BRIDGE_DATA_DIR`, `SIMPLEX_BIN`, `SIMPLEX_PORT` (default 5225), `SIMPLEX_BOT_NAME` (default "Session"), `POLL_INTERVAL_MS` (default 5000), `BRIDGE_SECRETS` (`keychain` or `file`), `BRIDGE_TOR` (`on`/`off`), `TOR_SOCKS`, `TOR_BIN`, `TOR_SOCKS_PORT` (default 9250). Get the Tor binary with `bun run scripts/fetch-tor.ts bin/tor` (Linux x86_64) or point `TOR_SOCKS` at your system Tor.

## How it works

- `src/main.ts` starts everything. `src/simplex.ts` runs the `simplex-chat` CLI as a child process and talks to it over its local WebSocket API (localhost only). `src/bridge.ts` holds the forwarding logic.
- Every message is written to disk before it's forwarded, so a crash or a sleeping Mac doesn't lose it. Session.js remembers which Session messages were already seen, so nothing is forwarded twice after a restart.
- Pairing uses a one-time SimpleX invitation. The bridge accepts only the contact that connects through that exact invitation.

## License

MIT, see [LICENSE](LICENSE).

This repository contains only the bridge's own code. The installer downloads the third-party pieces on your machine, under their own licenses: the [SimpleX Chat CLI](https://github.com/simplex-chat/simplex-chat) (AGPL-3.0), [Tor](https://www.torproject.org) (BSD-3-Clause), [OpenSSL](https://github.com/openssl/openssl) (Apache-2.0, Intel Macs only, built locally), and the npm packages listed in `package.json`. The bridge talks to the SimpleX CLI over its local WebSocket API and doesn't link to it.

Not affiliated with the Session or SimpleX Chat projects.
