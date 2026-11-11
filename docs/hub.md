# Hub Spec

Status: Draft
Last updated: 2026-11-08

## 1. Overview

The hub is an optional, centrally run service that lets BBSes run behind
firewalls and makes them discoverable. It combines two separate functions:

| Function | What it does | AT-specific? |
|---|---|---|
| **Tunnel relay** | Accepts outbound tunnels from BBSes and routes public HTTPS traffic to them | No. Ordinary networking; build on existing tunnel software (frp, rathole, bore, chisel). |
| **Identity & directory** | Authenticates sysops by AT identity, issues BBS handles, indexes BBS listings, events, and status | Yes |

The hub does **not** need to host user accounts (run a PDS). Sysops and users
authenticate with whatever AT account they already have.

### 1.1 The hub handles inbound traffic only

Firewalls block incoming connections, not outgoing ones. Every AT interaction
a BBS needs is outgoing (OAuth token exchange with users' account servers,
writing to its own account, reading the network), so **BBSes talk to AT and
Bluesky directly; the hub never sits between them.**

The hub relays only traffic that must reach the BBS from outside:

| Inbound traffic | Origin |
|---|---|
| Terminal sessions (WebSocket) | Users |
| OAuth callback and client metadata | Users' browsers and account servers |
| Verifier webhooks | Payment or verification providers |
| Graphics and 3D assets the BBS offers to the hub's shared space | The hub, and through it users' clients (§4, §5.3) |

A BBS with its own public address or tunnel loses nothing AT-related by not
using the hub; it gives up only the directory listing and a hub-issued handle.

### 1.2 Relationship to AT servers

The hub is a standalone service, not an add-on to an existing AT server.
The AT reference servers have no plugin mechanism; the protocol is extended by
running independent services that interoperate over the network. The hub
connects to Bluesky's infrastructure only as a client (e.g. reading
Jetstream).

If the project later hosts BBS accounts itself ([publishing.md](publishing.md)
§7), a standard PDS runs as a **separate** service alongside the hub, routed by
hostname behind one reverse proxy:

```
reverse proxy (443)
  ├── pds.hub.example   → PDS
  └── *.hub.example     → hub
```

A BBS is never locked to the hub: it serves plain HTTPS/WebSocket locally
([transport.md](transport.md)), so a sysop can switch to their own tunnel or
another hub at any time. The hub software should be runnable by anyone.

```
[BBS on sysop's machine] ──outbound tunnel (authenticated as BBS's DID)──> [Hub]
                                                                             ▲
                            https://coolbbs.hub.example  (allowed endpoints only)
                                                                             │
                                                                   [User's browser/client]
```

## 2. Sysop registration

1. The sysop runs the BBS software and chooses "connect to hub."
2. The BBS performs a browser handoff for AT OAuth against the hub (base
   `atproto` scope), authenticating the **sysop's** DID.
3. The sysop chooses a BBS name, which becomes the subdomain
   (`coolbbs.hub.example`).
4. The hub issues a **tunnel token** bound to the BBS record and the sysop's
   DID. Later the tunnel also proves the BBS's own DID, and published
   agreements follow; the stages are in
   [hub_development_plan.md](hub_development_plan.md), H3.
5. The hub may require sysop attestations before allowing registration, using
   the same model as [attestation.md](attestation.md) (e.g. `sysop-approval`,
   `stripe-card`). Hub bans are keyed by sysop DID.

A BBS may also have its own AT account ([publishing.md](publishing.md) §2).
The hub can issue that account a handle under the hub domain (e.g.
`@coolbbs.hub.example`), which acts as proof that it is the BBS registered at
that subdomain.

## 3. Routing

- Wildcard DNS: `*.hub.example` → hub.
- TLS certificates, either:
  - **on-demand** (default): the hub obtains a certificate for each BBS
    subdomain on first use, using ordinary HTTP validation, after checking the
    name is registered. Works with any DNS provider that allows a wildcard
    record; or
  - **wildcard**: one certificate for `*.hub.example`, which requires a DNS
    provider with an API for DNS-01 validation.
- The hub selects the target tunnel by the request's `Host` header.
- If the BBS's tunnel is not connected, the hub returns a status page using
  the BBS's latest status ([publishing.md](publishing.md) §3.3).

## 4. Allowed endpoints

To keep the hub from becoming general web hosting (and attractive for
phishing or malware), it forwards **only** the BBS endpoints defined in
[transport.md](transport.md) §2.1. Paths below are logical; for ENiGMA½ the
OAuth, handoff, and verifier routes live under `/_enig/atproto/`,
`/_enig/handoff/`, and `/_enig/verify/`
([enigma_integration.md](enigma_integration.md) §3.3), and the hub forwards
those prefixes only.

| Path | Forwarded? | Notes |
|---|---|---|
| `/` | No | Served by the hub: BBS info page plus the **hub-provided web terminal** |
| `/.well-known/atproto-did` | No | Served by the hub: returns the BBS account's DID for handle verification (§4.1) |
| `/ws` | Yes | Terminal WebSocket |
| `/peer` | Yes | BBS-to-BBS peering WebSocket ([networking.md](networking.md) §2) |
| `/oauth/client-metadata.json` | Yes | Response validated as JSON |
| `/oauth/callback` | Yes | Responses limited to redirects or minimal pages |
| `/login/<code>` | Yes | Browser handoff landing |
| `/signin`, `/signout` | Yes | The BBS's own web sign-in page (ENiGMA½: `/_enig/signin`, `/_enig/signout`); the cookie it sets is the BBS's, for its own subdomain |
| `/cb/<verifier-id>/...` | Yes | Verifier callbacks and webhooks |
| `/assets/...` | Yes | Graphics and 3D assets the BBS offers to the shared space (§5.3): images, ANSI art, glTF/GLB, VRM. Only allowed content types, within size limits; the hub caches them so they stay available while the BBS is offline |
| Anything else | No | 404 |

Serving the web terminal from the hub means users always run a known client,
and a BBS cannot serve arbitrary pages under the hub domain. The hub serves
a pinned release of enig-term, configured to connect to the BBS's `/ws`.

### 4.1 Handle verification

AT verifies a handle such as `@coolbbs.hub.example` by either a DNS TXT
record at `_atproto.coolbbs.hub.example` or an HTTPS request to
`https://coolbbs.hub.example/.well-known/atproto-did`, expecting the account's
DID.

- The hub answers `/.well-known/atproto-did` **itself** from its registration
  records. It is never forwarded to the BBS, so a BBS cannot claim a
  different DID, and verification works while the BBS is offline.
- Returns 404 if the BBS has no AT account registered.
- DNS TXT records are an acceptable alternative, but the HTTPS method avoids
  managing a DNS record per BBS under the wildcard domain.
- When a BBS registration is removed or reassigned, the hub stops serving the
  old DID immediately.

## 5. Directory

- The hub indexes BBS public records from the AT network (via Jetstream),
  filtered to the project's record types ([publishing.md](publishing.md) §3),
  plus the Bluesky posts of registered BBS accounts.
- Any other directory can be built from the same public records; the hub's
  directory is not privileged. Apps can also skip the hub and read the
  records from the AT network directly.
- **Interfaces:** a web page at the hub's root first. A terminal interface
  (a BBS-style front door with menus and a BBS list) is planned for later;
  its design is open.

### 5.1 What visitors see

| Item | Source |
|---|---|
| BBSes connected now | The hub's own tunnel state (§6). BBSes not using the hub have only their declared status, plus an optional reachability check |
| Name, description, how to connect, banner | `listing` record |
| Rules and membership requirements | `listing` record (`rules`, `admission`); directory can filter by admission policy |
| Status and notices | `status` and `observedStatus` records |
| Stats | `stats` record, or live counts sent over the tunnel; **every stat off by default**, enabled per stat by the sysop ([publishing.md](publishing.md) §3.5) |
| Advertisements | `ad` records, rotated by the hub with expiry and fairness between BBSes |
| Upcoming events | Community calendar-event records |
| Recent public posts and updates | The BBS account's Bluesky posts, including bridged boards |

ANSI art is shown wherever a record carries it (banners, ads), using the web
terminal's renderer, with the plain-text fallback otherwise
([publishing.md](publishing.md) §3.7).

The hub could also publish recent BBS updates as a Bluesky custom feed, so
Bluesky users can follow them in their normal app (see the
`bluesky-social/feed-generator` starter).

### 5.2 API for apps

For non-browser clients (a desktop or VR app, another directory). JSON is
the format, as in AT's own APIs; graphics are never embedded in it.

1. **Lookups (XRPC).** JSON queries under a `did:web` for the hub, named
   with AT's verb-first convention (e.g.
   `nexus.cyberspace.hub.listLeaves`, `getLeaf`). Long lists are paged
   with cursors; responses are cacheable (ETags), so apps download only
   what changed. AT clients can call them directly or via their account
   server's service proxying (`atproto-proxy` header, with service auth).
2. **Graphics by URL.** The JSON links to files the app downloads once and
   caches. ANSI art is offered both as the original file (so an app can
   render it itself, e.g. as a VR texture at its own resolution, including
   animation) and as a pre-rendered PNG ([publishing.md](publishing.md)
   §3.7).
3. **Snapshot.** The whole directory as one compressed file, one JSON object
   per line, refreshed every few minutes, for an app's first load.
4. **Live updates (later).** A WebSocket stream of changes (status, posts,
   BBSes connecting) for apps that stay open, in the style of Jetstream.

Binary formats (CBOR, Protocol Buffers) were considered and not chosen: the
text is small once compressed, images dominate the bytes, and JSON keeps the
API usable from any AT library.

References: the atproto.com specs (Lexicon, XRPC, service proxying, service
auth) and the `bluesky-social/feed-generator` starter.

### 5.3 Social space (future, possibly a separate project)

A shared space attached to the hub where people appear as avatars while
they use BBSes or other connected services, reachable from VR headsets and
desktop apps. The longer-range design (stages, transport policy, avatars,
hub federation) is in [Cyberspace Framework vision](https://github.com/zerosquaredio/cyberspace-framework/blob/main/docs/vision.md).

- Identity is the person's AT DID, as everywhere else in the project.
- Clients download avatars and environment graphics from the hub (or from
  the person's own AT account). Assets a BBS contributes (its room, sign,
  or decorations) reach the hub over the BBS's tunnel (`/assets/`, §4),
  so a home-based BBS can contribute them without opening any port; the
  hub serves them to clients from its cache. The tunnel is the default. A
  BBS with its own public address may instead name a direct `https://`
  URL for its assets, if that is more efficient (large files, a CDN); the
  hub then fetches from there, with the same type and size checks, and
  still serves clients from its cache, so clients never depend on the BBS
  being up or reveal their addresses to it.
- In-room chat, person-to-person messages, and possibly voice. The hub
  works like a co-working space even without 3D (vision §8): IRC-like
  text with ephemeral history, and voice with one big room by default.
  Hub services for it: chat (an IRCv3 server or our own), STUN and TURN
  for direct calls and their fallback (also used by Overte domains and
  web clients, [overte_evaluation.md](overte_evaluation.md) §4.2), and a
  media server (SFU) for larger voice rooms. Rough sizing is in §8.1.
- A **live model** of the space (vision §8.3): a small core every hub
  publishes, plus named extensions that fall back to core types, so any
  view works on any hub.
- **Presence is opt-in.** Showing that someone is "hanging out", or which
  BBS they are on, is member activity, so it follows the same rule as
  triggered posts ([publishing.md](publishing.md) §5): off unless the person
  turns it on.
- Prefer adapting existing open-source social VR software to building one.
  None of the candidates supports AT login today, so that integration is
  ours to write in every case.
- **Start from something we fully control and can fork** (decided
  2026-11-07): the core 3D layer must let us replace its login with AT
  identity and run every part of it ourselves. Closed platforms can still
  appear as optional leaves.

Shortlist from an initial survey (2026-11-04; not yet verified hands-on):

| Candidate | Why | Costs |
|---|---|---|
| **Hubs Community Edition** (Hubs Foundation; MPL-2.0) | Released regularly in 2026; runs in any browser and on Quest via WebXR; room chat and spatial voice; avatars and scenes (glTF/GLB) served from our own server | Server is Elixir and needs Kubernetes; login is email-only, so AT OAuth means patching its server (an unmerged OpenID Connect PR is a template); no direct messages |
| **Overte** (High Fidelity descendant; Apache-2.0) | Strongest open desktop and PC VR option; released October 2026 | Large C++ codebase; no browser or Quest client; AT login means changing its account server |
| **Build on Networked-Aframe or Hyperfy** (MIT / GPL-3.0) | Cleanest identity design (AT OAuth and DIDs from the start); Node, like ENiGMA½ | Most work; voice via LiveKit or Janus; chat and DMs built by us |

**Current favorite: Overte**, for its visual quality (a native renderer
using the PC's graphics card, versus Hubs' browser and standalone-headset
limits). It needs no browser or standalone Quest support if it isn't the
only way in: Overte would be the high-detail client, and the hub's web page
a simple 2D view of who is around, both reading the same presence data and
avatars from people's AT accounts. Next steps: try the Overte client on
Windows in a public world; then run its server on the VM (Docker) to see how
its accounts work and where AT login fits. VRM avatar support is to be
checked.

**Decided 2026-11-08:** Overte for worlds and the native client, with a
browser and WebXR client forked from Vircadia's web SDK joining the same
domains over the WebRTC support Overte's domain server still has. Details,
the identity and networking approach (a hub-run metaverse server and ICE
server), and next steps are in [overte_evaluation.md](overte_evaluation.md).
The Vircadia ruled out below is its new platform; its older web SDK is the
part we reuse.

Ruled out for now: Vircadia (rewrite not production-ready), JanusWeb
(stagnant), Third Room (paused since 2023, but a good design reference for
identity, chat, and DMs on a federated network), iR Engine (CPAL license,
unclear ownership), Webaverse (appears dead), OpenSimulator (old stack,
non-glTF avatars).

Resonite (Yellow Dog Man Studios) is polished, with a busy community, but
not a candidate for the core: its source is closed, and accounts, contacts,
messaging, saved items and the world directory run on the company's cloud.
So its login can't be replaced with AT identity, and hubs can't run its
directory themselves. Its headless server software is available only to
Patreon supporters, and is downloaded and logged in with Steam and
Resonite accounts (checked 2026-11-07). It could still be an optional leaf:
a Resonite world listed in the hub directory, with a visitor's AT identity
linked through a browser handoff that the world checks with a web request.

Related work:

- **Avatars:** VRM 1.0 (built on glTF 2.0), with plain GLB as the fallback.
- **at3d.app:** an early draft of AT record types for 3D identity, including
  VRM avatars stored in the person's own AT account, models, scenes, and
  world discovery. No presence record. Worth following or helping shape
  rather than defining our own avatar records.
- **WorldMesh:** a small three.js project with a pull request adding AT
  login; useful as reference code only.
- No AT record type exists for live presence or rooms; presence would be a
  hub service, with any published records under `nexus.cyberspace.hub.*`.

### 5.4 Ratings and themes

Leaves, rooms and assets each have themes and a rating (raised
2026-11-08; direction, not yet designed in detail). They are kept apart
because they do different jobs:

- **Themes** (hacking, anime, politics, furry, retro, …) are free tags,
  loose and unofficial, made up by communities and changing over time:
  the listing's `tags` ([publishing.md](publishing.md) §3.1), and tags on
  asset records. They are for finding and filtering, never for access
  control.
- **Rating** is a short fixed list, because access depends on it:

  | Rating | Meaning | AT labels that imply it |
  |---|---|---|
  | `general` | All ages | none |
  | `mature` | Graphic or disturbing content, non-sexual nudity | `graphic-media`, `nudity` |
  | `adult` | Sexual content | `sexual`, `porn` |

  The mapping to AT labels is a first draft.

**Use AT labels rather than our own scheme.** Records can carry
self-labels their author attaches, and independent labeler services label
other people's content; Bluesky's apps already honor both. Asset records
carry self-labels, and the leaf listing carries its rating as one.

**A thing's rating is the highest of:**

1. its own self-labels;
2. labels on it from labelers the hub trusts;
3. the rating of the leaf (or room) it comes from.

So an unlabelled asset from an adult leaf counts as adult: a missing label
never lets something through.

**Hub policy** (the hub admin's settings):

- Allowed ratings, for the hub as a whole and for each space.
- Themes to prefer, allow only, or block, for a hub keeping to a theme.
  Soft: they decide what's shown and offered, and can't be exact, since
  tags are loose.
- Labelers to trust, possibly including the hub's own.
- Which leaves' `verified-adult` attestations it accepts
  ([attestation.md](attestation.md) §8).

**Defaults:** every published asset from every connected leaf may be
used, except that the common space is `general`. Spaces rated `mature` or
`adult` admit only visitors with an age attestation the hub accepts.
Visitors who aren't signed in see only `general` spaces, directory
entries and assets.

**Adult leaves on a general hub** can still connect. They appear in the
directory to visitors allowed to see them, with their room hidden, or
shown with a plain sign, elsewhere; their assets never reach spaces rated
below them.

**Presence counts too.** Showing that someone is on an adult leaf reveals
something about them even if no adult content is shown. Presence is
opt-in already (§5.3); in addition, presence on a leaf is shown only in
spaces rated at or above that leaf.

Labels are honest by default, and the hub can't inspect everything, so
the rest is reporting, labelers, and the hub admin blocking an asset or a
leaf.

## 6. Status monitoring

The hub can observe whether each BBS's tunnel is connected. Because a crashed
BBS cannot report its own outage, the hub publishes **observed status** from
its own AT account ([publishing.md](publishing.md) §3.3).

**Part-time BBSes are normal** (decided 2026-11-07). A BBS run from a home
VM, a spare machine, or someone's own computer need not be up all the time,
like the dial-up boards that opened only in the evening. Its registration,
handle, and space on the hub stay while it is away. Its page, directory
entry, and (later) its place in the social space show whether it is
connected now, when it was last seen, and its regular hours if the sysop
publishes them (the listing's `hours`, [publishing.md](publishing.md) §3.1).
Being offline is not an outage: only a board that is down during its own
hours, or has no hours, is shown as unexpectedly down.

The hub supports both ways of running a BBS:

- **Hosted (co-located):** on a server with a public address, reached
  directly or through the hub's front door.
- **Home-based:** behind a home firewall, reaching the hub by its outbound
  tunnel. The tunnel is the baseline and needs no open ports. A sysop may
  also open ports themselves, for example SSH or telnet for callers who
  prefer them, and list those in the BBS's `endpoints`
  ([publishing.md](publishing.md) §3.1); that is optional. Anything the
  hub itself needs from the BBS, including assets for the shared space,
  goes over the tunnel.

## 7. Trust and privacy

- **The hub can read traffic in v1.** TLS terminates at the hub (the hub
  holds the certificates, on-demand or wildcard). This must be stated plainly to sysops and users, as with
  Cloudflare Tunnel.
- Future options for end-to-end privacy:
  - TLS passthrough by SNI, with each BBS holding its own certificate.
  - End-to-end encryption inside the tunnel between client and BBS.
- The hub stores: sysop DIDs, BBS registrations, tunnel tokens, and its
  directory index. It does not store BBS content.

## 8. Operational concerns

- **Single point of failure:** every BBS on a hub goes dark if the hub does.
  Mitigations are portability to other tunnels and other hubs running the
  same software.
- **Abuse handling:** reporting, BBS suspension, and sysop bans by DID. Blocking
  people in the common space, and who moderates it, are in the vision,
  §8.7.
- **Rate limits** on connections and bandwidth per BBS.
- **Bandwidth:** terminal traffic is small, so per-BBS cost should be low.
- **Legal exposure:** the hub serves other people's content under its domain;
  needs terms of service and an abuse contact.

### 8.1 Sizing (provisional)

**Estimates, not measurements** (2026-11-09). Replace them with measured
figures from the load-test tool (vision §4.4). The reference server is a
small VPS: about 4 shared vCPU, 8 GB RAM, 75 GB disk, 400–500 Mbps
unmetered (OVH VPS-1 class).

How group calls are carried decides most of the cost:

| Approach | How it works | Load |
|---|---|---|
| Peer-to-peer (mesh) | Everyone sends to everyone | Each person uploads N−1 copies; fine for 2–4 people |
| SFU (Selective Forwarding Unit) | Each person uploads one stream; the server forwards copies without decoding them, and can skip muted people or send a lower quality to slow connections | Server bandwidth, little CPU |
| MCU / mixer | The server decodes, mixes and re-encodes one stream per listener | Heavy server CPU; each person downloads one stream |

Hub voice rooms use an SFU (such as LiveKit); calls between two people go
peer-to-peer, with TURN only when a direct path fails. Overte's audio mixer
works like an MCU (spatial audio mixed per listener), so it is CPU-bound.

Positional (3D) audio doesn't need server-side mixing. For the 2D map and
web 3D views, the SFU forwards each listener only the nearest or loudest
few speakers (say 3–6), along with their positions, and each device
positions them locally (the browser's Web Audio panner). Server CPU stays
low and each person's download stays roughly constant however large the
crowd. Overte mixes on the server mainly to keep downloads to one stream
for big crowds and slow connections; that tradeoff is Overte's, not one
positional audio requires.

| Space | Audio | Server cost |
|---|---|---|
| Hub voice rooms | SFU; everyone hears the room | Low |
| 2D map, web 3D views | SFU forwarding the nearest or loudest speakers, positioned on each device | Low |
| Overte worlds | Overte's own mixer, per world | High; its own server |

| Service | Cost per active user | Rough capacity on the reference server |
|---|---|---|
| Control plane, tunnels, directory, edge | Small; BBS traffic passes through | Hundreds of BBSes |
| Text chat and presence | Negligible | Thousands of people |
| Voice (SFU) | ~40 kbps up, ~40 kbps down per other speaker | A room of 10 uses ~4 Mbps; 100+ people across rooms. Steady CPU timing limits it before bandwidth does |
| Video calls (SFU) | 0.3–2.5 Mbps per stream | A room of 10 uses ~25–50 Mbps; about 10 rooms. **The first real limit** |
| Overte world | Audio mixing CPU; avatar data ~50–200 kbps per person | About 15–30 people in one world |
| 3D downloads (models, textures, avatars) | Tens to hundreds of MB per first visit | Can fill the bandwidth at busy times; serve from object storage or a CDN |

Risks that matter more than raw size:

- **Shared vCPU and real-time audio.** Other tenants on the same host
  cause jitter (crackling voice) even when CPU use looks low. Voice and 3D
  want dedicated cores.
- **UDP and DDoS filtering.** Voice and Overte use UDP. A VPS provider's
  anti-DDoS filtering can interfere with it; test early.
- **A sysop's home upload** limits what their own BBS contributes (assets,
  a BBS-hosted room) before the hub does.

Growth path: scale by splitting services across servers, not by buying one
larger machine. Start with the hub, text chat and a voice SFU on one small
server. Give each Overte world its own server (Overte runs one server
process per world anyway), and put 3D files on object storage. Move the
SFU to dedicated-core servers when video or large rooms arrive. The
control plane stays small and doesn't need to move.

## 9. Open questions

- Which tunnel implementation to build on.
- Whether the hub should also offer to be the OAuth client on behalf of BBSes
  (simpler for sysops, but the hub then sees every user's identity), instead
  of each BBS having its own `client_id`.
- Subdomain naming rules (reserved names, reclaiming abandoned names).
- Whether to support custom domains for BBSes behind the hub.
- Design of the terminal front door (§5): how the directory, banners, and
  ads are shown in a terminal. The hub would run a small BBS-style app.
- ~~Which open-source social VR software to adapt for the social space.~~
  Overte (decided 2026-11-08, §5.3).
- What counts as an "active" BBS (recent posts, users online, or connected).
- Objects with their own code (vision §8.8): whether a hub runs foreign
  code at all, and if so the fuel budget per object; how a BBS serves as
  an object's backend through its tunnel; per-object bandwidth and update
  limits; rules on compute groups (mining) and on relaying media.
