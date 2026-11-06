# Nexus Lounge Design Docs

**Nexus Lounge** is a terminal-style BBS (Bulletin Board Server) network that
uses the AT Protocol for identity. It is the first piece of the
[Cyberspace Framework](cyberspace_framework.md), a longer-range plan for a
shared, cyberpunk-styled space across BBSes, chats, games, and VR worlds.

## Names and domains

| Use | Value | Changeable? |
|---|---|---|
| Project name | Nexus Lounge | Yes |
| Record type names (NSIDs) | `io.zerosquared.bbs.*` | **No.** Shared by every BBS, hub, and directory |
| Test hub | `*.hub.zerosquared.io` | Yes; any hub can use its own domain |
| Public domain | Not yet chosen | Yes |

`zerosquared.io` is registered at Gandi; its DNS is hosted by WordPress.com.

## Architecture in brief

- **BBS:** [ENiGMA½](https://github.com/NuSkooler/enigma-bbs) with AT
  Protocol modules ([enigma_integration.md](enigma_integration.md)), run by a
  sysop, often behind a home firewall. Serves a terminal over WebSocket
  (enig-term in the browser) and optionally SSH. Uses AT for user login and
  for publishing its own public records, both via direct outbound HTTPS.
- **Hub (optional):** a standalone public server that relays *inbound*
  traffic (terminal sessions, OAuth callbacks, webhooks) to BBSes over tunnels
  the BBSes open outward, plus a directory, BBS handles, and observed status.
- **AT / Bluesky:** existing infrastructure. Nothing is added to it; the BBS
  and hub interoperate with it over the network as clients.

| Doc | Covers |
|---|---|
| [cyberspace_framework.md](cyberspace_framework.md) | The long-range vision: hubs and leaves, shared spaces, transport policy, leaf identity, avatars, federation |
| [development_plan.md](development_plan.md) | Features, delivery tracks (upstream / fork / mods / this repo), configuration model, milestones, PR sequence |
| [hub_development_plan.md](hub_development_plan.md) | Hub features H0–H11, architecture (Caddy, frp, TypeScript control plane), milestones, testing, deployment |
| [enigma_integration.md](enigma_integration.md) | How the specs map onto ENiGMA½: login type, routes, groups as attestations, transport, upstream strategy |
| [attestation.md](attestation.md) | User authentication (AT OAuth), credential binding, attestations, access policies, verifier plugins |
| [transport.md](transport.md) | HTTPS/WebSocket transport, tunnels and reachability, optional SSH, P2P backlog |
| [hub.md](hub.md) | Optional central hub: tunnel relay, sysop registration, routing, directory |
| [publishing.md](publishing.md) | The BBS's own AT account and public records: listing, events, status, announcements |
| [networking.md](networking.md) | BBS-to-BBS peering: shared boards, files, and games; clusters of BBSes acting as one |
| [at_communities.md](at_communities.md) | Where AT development happens: code hosting, shared schemas, community, developer references |

## Glossary

### Project terms

| Term | Meaning |
|---|---|
| **BBS** | **Bulletin Board Server**: this project's server, run by a sysop. (Traditionally "Bulletin Board System"; the server reading parallels AT's PDS.) |
| **Hub** | The optional public server that relays inbound traffic to BBSes over tunnels and provides the directory and BBS handles ([hub.md](hub.md)) |
| **Leaf** | Any endpoint people reach through a hub: a BBS today; later chats, games, VR worlds ([cyberspace_framework.md](cyberspace_framework.md)) |
| **Cyberspace Framework** | The long-range vision this project is the first piece of: a shared, cyberpunk-styled space across leaves and hubs ([cyberspace_framework.md](cyberspace_framework.md)) |
| **Sysop** | A person who runs a BBS. In ENiGMA½: root plus members of the `sysops` group |
| **Root** | User #1, permanently a sysop, with a few root-only powers (e.g. reading all private mail) |
| **Provisional user** | An authenticated user admitted with limited access until approved ([attestation.md](attestation.md) §5) |
| **ENiGMA½** | The open-source Node.js BBS software this project builds on |
| **enig-term** | ENiGMA½'s browser terminal (CP437 fonts, ANSI), connecting over WebSocket |
| **Attestation** | A record that a verifier vouched for a DID ([attestation.md](attestation.md) §4) |
| **Verifier** | A plugin that checks something about a user and issues attestations ([attestation.md](attestation.md) §6) |
| **Tunnel** | An outbound connection from a BBS that lets inbound traffic reach it without opening firewall ports ([transport.md](transport.md) §3) |

### AT Protocol terms

| Term | Meaning |
|---|---|
| **PDS** | **Personal Data Server**: hosts users' accounts, their data repositories, and their login (OAuth authorization server). Accounts can move between PDSes. |
| **DID** | Decentralized Identifier: an account's permanent ID (e.g. `did:plc:abc123`). Members are keyed by DID. |
| **Handle** | An account's human-readable name (e.g. `@alice.bsky.social`). Display only; can change. |
| **Repo** | An account's public, signed store of records, hosted on its PDS |
| **Lexicon** | A schema defining record types and API methods |
| **NSID** | Namespaced identifier for a Lexicon, a reversed domain (e.g. `io.zerosquared.bbs.listing`) |
| **XRPC** | AT's HTTPS-based API convention (`/xrpc/<NSID>`) |
| **Relay / firehose** | The relay aggregates repo changes from all PDSes into a stream, the firehose |
| **Jetstream** | A lightweight JSON version of the firehose |
| **AppView** | A service that indexes records from the firehose to serve an application (e.g. Bluesky's timelines) |
