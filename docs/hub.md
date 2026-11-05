# Hub Spec

Status: Draft
Last updated: 2026-11-04

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
   DID.
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
OAuth, handoff, and verifier routes live under `/_enig/atproto/` and
`/_enig/verify/` ([enigma_integration.md](enigma_integration.md) §3.3), and
the hub forwards those prefixes only.

| Path | Forwarded? | Notes |
|---|---|---|
| `/` | No | Served by the hub: BBS info page plus the **hub-provided web terminal** |
| `/.well-known/atproto-did` | No | Served by the hub: returns the BBS account's DID for handle verification (§4.1) |
| `/ws` | Yes | Terminal WebSocket |
| `/peer` | Yes | BBS-to-BBS peering WebSocket ([networking.md](networking.md) §2) |
| `/oauth/client-metadata.json` | Yes | Response validated as JSON |
| `/oauth/callback` | Yes | Responses limited to redirects or minimal pages |
| `/login/<code>` | Yes | Browser handoff landing |
| `/cb/<verifier-id>/...` | Yes | Verifier callbacks and webhooks |
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
   `io.zerosquared.bbs.directory.listBbses`, `getBbs`). Long lists are paged
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
desktop apps.

- Identity is the person's AT DID, as everywhere else in the project.
- Clients download avatars and environment graphics from the hub (or from
  the person's own AT account).
- In-room chat, person-to-person messages, and possibly voice.
- **Presence is opt-in.** Showing that someone is "hanging out", or which
  BBS they are on, is member activity, so it follows the same rule as
  triggered posts ([publishing.md](publishing.md) §5): off unless the person
  turns it on.
- Prefer adapting existing open-source social VR software to building one.
  None of the candidates supports AT login today, so that integration is
  ours to write in every case.

Shortlist from an initial survey (2026-11-04; not yet verified hands-on):

| Candidate | Why | Costs |
|---|---|---|
| **Hubs Community Edition** (Hubs Foundation; MPL-2.0) | Released regularly in 2026; runs in any browser and on Quest via WebXR; room chat and spatial voice; avatars and scenes (glTF/GLB) served from our own server | Server is Elixir and needs Kubernetes; login is email-only, so AT OAuth means patching its server (an unmerged OpenID Connect PR is a template); no direct messages |
| **Overte** (High Fidelity descendant; Apache-2.0) | Strongest open desktop and PC VR option; released October 2026 | Large C++ codebase; no browser or Quest client; AT login means changing its account server |
| **Build on Networked-Aframe or Hyperfy** (MIT / GPL-3.0) | Cleanest identity design (AT OAuth and DIDs from the start); Node, like ENiGMA½ | Most work; voice via LiveKit or Janus; chat and DMs built by us |

Ruled out for now: Vircadia (rewrite not production-ready), JanusWeb
(stagnant), Third Room (paused since 2023, but a good design reference for
identity, chat, and DMs on a federated network), iR Engine (CPAL license,
unclear ownership), Webaverse (appears dead), Resonite (core is closed),
OpenSimulator (old stack, non-glTF avatars).

Related work:

- **Avatars:** VRM 1.0 (built on glTF 2.0), with plain GLB as the fallback.
- **at3d.app:** an early draft of AT record types for 3D identity, including
  VRM avatars stored in the person's own AT account, models, scenes, and
  world discovery. No presence record. Worth following or helping shape
  rather than defining our own avatar records.
- **WorldMesh:** a small three.js project with a pull request adding AT
  login; useful as reference code only.
- No AT record type exists for live presence or rooms; presence would be a
  hub service, with any published records under `io.zerosquared.bbs.*`.

## 6. Status monitoring

The hub can observe whether each BBS's tunnel is connected. Because a crashed
BBS cannot report its own outage, the hub publishes **observed status** from
its own AT account ([publishing.md](publishing.md) §3.3).

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
- **Abuse handling:** reporting, BBS suspension, and sysop bans by DID.
- **Rate limits** on connections and bandwidth per BBS.
- **Bandwidth:** terminal traffic is small, so per-BBS cost should be low.
- **Legal exposure:** the hub serves other people's content under its domain;
  needs terms of service and an abuse contact.

## 9. Open questions

- Which tunnel implementation to build on.
- Whether the hub should also offer to be the OAuth client on behalf of BBSes
  (simpler for sysops, but the hub then sees every user's identity), instead
  of each BBS having its own `client_id`.
- Subdomain naming rules (reserved names, reclaiming abandoned names).
- Whether to support custom domains for BBSes behind the hub.
- Design of the terminal front door (§5): how the directory, banners, and
  ads are shown in a terminal. The hub would run a small BBS-style app.
- Which open-source social VR software to adapt for the social space (§5.3).
- What counts as an "active" BBS (recent posts, users online, or connected).
