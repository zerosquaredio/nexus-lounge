# BBS Design Docs

A terminal-style BBS that uses the AT Protocol for identity.

## Architecture in brief

- **BBS:** a standalone server run by a sysop, often behind a home firewall.
  Serves a terminal over HTTPS/WebSocket. Uses AT for user login and for
  publishing its own public records, both via direct outbound HTTPS.
- **Hub (optional):** a standalone public server that relays *inbound*
  traffic (terminal sessions, OAuth callbacks, webhooks) to BBSes over tunnels
  the BBSes open outward, plus a directory, BBS handles, and observed status.
- **AT / Bluesky:** existing infrastructure. Nothing is added to it; the BBS
  and hub interoperate with it over the network as clients.

| Doc | Covers |
|---|---|
| [attestation.md](attestation.md) | User authentication (AT OAuth), credential binding, attestations, access policies, verifier plugins |
| [transport.md](transport.md) | HTTPS/WebSocket transport, tunnels and reachability, optional SSH, P2P backlog |
| [hub.md](hub.md) | Optional central hub: tunnel relay, sysop registration, routing, directory |
| [publishing.md](publishing.md) | The BBS's own AT account and public records: listing, events, status, announcements |
