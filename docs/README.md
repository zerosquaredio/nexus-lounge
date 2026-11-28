# Nexus Lounge Design Docs

**Nexus Lounge** is a terminal-style BBS (Bulletin Board Server) network that
uses the AT Protocol for identity. It is the first piece of the
[Cyberspace Framework](https://github.com/zerosquaredio/cyberspace-framework), a longer-range plan for a
shared, cyberpunk-styled space across BBSes, chats, games, and VR worlds.

## Names and domains

| Use | Value | Changeable? |
|---|---|---|
| Project name | Nexus Lounge | Yes |
| Record type names (NSIDs) | `nexus.cyberspace.*` ([vision](https://github.com/zerosquaredio/cyberspace-framework/blob/main/docs/vision.md) §2.2) | **No.** Shared by every BBS, hub, and directory |
| Test hub | `*.hub.cyberspace.nexus` | Yes; any hub can use its own domain |
| Public domain | Not yet chosen | Yes |

`cyberspace.nexus` is the Cyberspace Framework's domain, registered at Gandi
with DNS on Gandi LiveDNS. It is kept separate from personal domains so it
can be handed to a community later.

## Architecture in brief

- **BBS:** [ENiGMA½](https://github.com/NuSkooler/enigma-bbs) with AT
  Protocol modules ([enigma_integration.md](development/enigma_integration.md)), run by a
  sysop, often behind a home firewall. Serves a terminal over WebSocket
  (enig-term in the browser) and optionally SSH. Uses AT for user login and
  for publishing its own public records, both via direct outbound HTTPS.
- **Hub (optional):** a standalone public server that relays *inbound*
  traffic (terminal sessions, OAuth callbacks, webhooks) to BBSes over tunnels
  the BBSes open outward, plus a directory, BBS handles, and observed status.
- **AT / Bluesky:** existing infrastructure. Nothing is added to it; the BBS
  and hub interoperate with it over the network as clients.

The docs are in three folders: [development/](development/) for how it's
built and where it's going (plans, specs, research), [admin/](admin/) for
running a board or a hub, and [user/](user/) for people using boards and the
hub.

### Development

| Doc | Covers |
|---|---|
| [development_plan.md](development/development_plan.md) | Features, delivery tracks (upstream / fork / mods / this repo), configuration model, milestones, PR sequence |
| [hub_development_plan.md](development/hub_development_plan.md) | Hub features H0–H25, architecture (Caddy, frp, TypeScript control plane), milestones, testing, deployment |
| [hub.md](development/hub.md) | Optional central hub: tunnel relay, sysop registration, routing, directory |
| [live_model.md](development/live_model.md) | The hub's common space as a live stream: who is there, where, and who is together, for its map and the BBS door |
| [enigma_integration.md](development/enigma_integration.md) | How the specs map onto ENiGMA½: login type, routes, groups as attestations, transport, upstream strategy |
| [attestation.md](development/attestation.md) | User authentication (AT OAuth), credential binding, attestations, access policies, verifier plugins |
| [publishing.md](development/publishing.md) | The BBS's own AT account and public records: listing, events, status, announcements |
| [assets.md](development/assets.md) | Art and models from leaves, their members and users: records, publishing, the hub's checks and cache, permissions and remixing, identity and impersonation |
| [compute.md](development/compute.md) | Where live objects' work runs: portable WebAssembly programs with declared limits, places reporting capacity, the hub placing and moving programs (itself first, then people's own compute, groups, BBSes), driven 3D models, trust in results, people giving compute, storage, bandwidth and live data feeds and events (a weather station driving rain in a place, a bell that rings when a market opens) to everyone, with contributor awards |
| [settings_ui.md](development/settings_ui.md) | How people set settings and permissions: rules as sentences, presets, showing their effect, settings on each thing's own page, history, the web then terminals then in-world panels, typing, voice and agents with confirmation, trusted panels |
| [media_sources.md](development/media_sources.md) | Where free pictures, textures, models, sounds and fonts come from, and which licences may go into the project's own CC BY art |
| [trials.md](development/trials.md) | Every number and choice made without data, in one list: what it is now, where it's set, how to try it and who can, by stage; and what was found |
| [build_3d_slice.md](development/build_3d_slice.md) | Build spec for the first 3D slice (boards publish glTF models, the hub checks and serves them, a viewer in the gallery): the owner's decisions, the shapes, the checker, the work split |
| [build_live_object_slice.md](development/build_live_object_slice.md) | Build spec for the first live object (a WebAssembly program, run by the hub with fuel metering, that fetches the weather for a place from Open-Meteo through whitelisted sites and shows it as a badge on the map): decisions, shapes, the host interface, stages |
| [record_names.md](development/record_names.md) | The final names of the records the framework publishes, the permission sets boards and the hub ask for, the project account holding the schemas, and the switch from the development names |
| [resource_node.md](development/resource_node.md) | Leaves with no front end: storage, compute and agents run by sysops or anyone, under firewall-style permissions |
| [transport.md](development/transport.md) | HTTPS/WebSocket transport, tunnels and reachability, optional SSH, P2P backlog |
| [networking.md](development/networking.md) | BBS-to-BBS peering: shared boards, files, and games; clusters of BBSes acting as one |
| [overte_evaluation.md](development/overte_evaluation.md) | The 3D and VR choice: Overte worlds, a browser client from Vircadia's web SDK, and how identity and networking would fit |
| [known_bugs.md](development/known_bugs.md) | Bugs we know about and haven't fixed: what is known, workarounds, and where the fix belongs |
| [at_communities.md](development/at_communities.md) | Where AT development happens: code hosting, shared schemas, community, developer references |

### Running a board or hub

| Doc | Covers |
|---|---|
| [running_a_hub.md](admin/running_a_hub.md) | A hub admin's day to day: deploying and rolling back, registering, suspending and banning, moderating the common space, the hub's own AT account, and backups |
| [joining_a_hub.md](admin/joining_a_hub.md) | For sysops: putting a board on a hub, from nothing to listed (the fork, registering, the tunnel agent, the board's settings and its own account, leaving) |
| [bbs_account.md](admin/bbs_account.md) | Setting up a BBS's AT account and its handle under a hub: the steps, and how the check works |
| [related_tools.md](admin/related_tools.md) | Software around boards and the hub: ANSI art tools, and what the hub is built from |

### Using boards and the hub

| Doc | Covers |
|---|---|
| [where_your_art_lives.md](user/where_your_art_lives.md) | For anyone publishing art: where it's kept (the account, the board, the hub), the hub's limits, Bluesky's storage and write limits, and what they mean for large art later |

## Glossary

### Project terms

| Term | Meaning |
|---|---|
| **BBS** | **Bulletin Board Server**: this project's server, run by a sysop. (Traditionally "Bulletin Board System"; the server reading parallels AT's PDS.) |
| **Hub** | The optional public server that relays inbound traffic to BBSes over tunnels and provides the directory and BBS handles ([hub.md](development/hub.md)) |
| **Leaf** | Any endpoint people reach through a hub: a BBS today; later chats, games, VR worlds, and resource nodes with no front end ([resource_node.md](development/resource_node.md)) ([Cyberspace Framework vision](https://github.com/zerosquaredio/cyberspace-framework/blob/main/docs/vision.md)) |
| **Cyberspace Framework** | The long-range vision this project is the first piece of: a shared, cyberpunk-styled space across leaves and hubs ([Cyberspace Framework vision](https://github.com/zerosquaredio/cyberspace-framework/blob/main/docs/vision.md)) |
| **Sysop** | A person who runs a BBS. In ENiGMA½: root plus members of the `sysops` group |
| **Root** | User #1, permanently a sysop, with a few root-only powers (e.g. reading all private mail) |
| **Provisional user** | An authenticated user admitted with limited access until approved ([attestation.md](development/attestation.md) §5) |
| **ENiGMA½** | The open-source Node.js BBS software this project builds on |
| **enig-term** | ENiGMA½'s browser terminal (CP437 fonts, ANSI), connecting over WebSocket |
| **Attestation** | A record that a verifier vouched for a DID ([attestation.md](development/attestation.md) §4) |
| **Verifier** | A plugin that checks something about a user and issues attestations ([attestation.md](development/attestation.md) §6) |
| **Tunnel** | An outbound connection from a BBS that lets inbound traffic reach it without opening firewall ports ([transport.md](development/transport.md) §3) |

### AT Protocol terms

| Term | Meaning |
|---|---|
| **AT Protocol vs. Bluesky** | AT is the general network: identity, repos of records, and sync. Bluesky is one app on it, with its own record types (`app.bsky.*`); ours sit alongside them the same way. Records are public, so private and live traffic (Bluesky's DMs, our terminal sessions and chat) runs on separate services ([vision](https://github.com/zerosquaredio/cyberspace-framework/blob/main/docs/vision.md) §2.1) |
| **PDS** | **Personal Data Server**: hosts users' accounts, their data repositories, and their login (OAuth authorization server). Accounts can move between PDSes. |
| **DID** | Decentralized Identifier: an account's permanent ID (e.g. `did:plc:abc123`). Members are keyed by DID. |
| **Handle** | An account's human-readable name (e.g. `@alice.bsky.social`). Display only; can change. |
| **Repo** | An account's public, signed store of records, hosted on its PDS |
| **Lexicon** | A schema defining record types and API methods |
| **NSID** | Namespaced identifier for a Lexicon, a reversed domain (e.g. `nexus.cyberspace.leaf.listing`) |
| **XRPC** | AT's HTTPS-based API convention (`/xrpc/<NSID>`) |
| **Relay / firehose** | The relay aggregates repo changes from all PDSes into a stream, the firehose |
| **Jetstream** | A lightweight JSON version of the firehose |
| **AppView** | A service that indexes records from the firehose to serve an application (e.g. Bluesky's timelines) |

## License

Code is under the [BSD 2-Clause License](../LICENSE), matching ENiGMA½. Docs
are under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Running
your own BBS or hub, open or closed, is fine; improvements sent back are very
welcome ([CONTRIBUTING.md](../CONTRIBUTING.md)).
