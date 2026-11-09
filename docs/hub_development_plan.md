# Hub Development Plan

Status: Draft
Last updated: 2026-11-08

This plan breaks the hub ([hub.md](hub.md)) into features and milestones. The
hub lives in this repo under `hub/` and is independent of the BBS software;
it works with any BBS that serves HTTPS and WebSocket, ENiGMA½ included. The
BBS-side work is in [development_plan.md](development_plan.md).

## 1. Principles

- **Reuse, don't build, the tunnel.** Tunneling is solved networking. Use an
  existing, maintained tunnel server and client, and write only the parts that
  are specific to us: registration, AT identity, routing policy, directory, and
  status.
- **Small, boring deployment.** One VPS, a handful of containers, SQLite until
  proven insufficient.
- **Allowlist by default.** The hub forwards only the BBS endpoints listed in
  [hub.md](hub.md) §4. Everything else is answered by the hub or returns 404.
- **No lock-in.** Nothing a BBS does for the hub prevents it from switching to
  its own tunnel or another hub. The hub software is runnable by anyone.
- **Honest about trust.** TLS terminates at the hub in v1, so the hub operator
  can read traffic. This is stated plainly to sysops and users.

## 2. Architecture

```
                          ┌───────────────────────── Hub VPS ─────────────────────────┐
 users ── HTTPS/WSS ──>   │  Edge (Caddy)  ──>  Tunnel server (frps)  <── tunnel ──── │ ── BBS agent (frpc)
 *.hub.cyberspace.nexus   │  on-demand TLS      per-BBS routing                       │    on sysop's machine
                          │  allowlist                │                               │
                          │      │                    │ auth hooks                    │
                          │      └──────>  Control plane (hub app)  <─────────────────┤
                          │                registration, registry, handles,           │
                          │                pages, status, directory                   │
                          │                     │            │                        │
                          └─────────────────────┼────────────┼────────────────────────┘
                                                │            │
                                   AT OAuth (sysops)    Jetstream (directory),
                                                        hub AT account (status)
```

| Component | Role | Implementation |
|---|---|---|
| **Edge** | Public HTTPS on 443; TLS for `*.hub.cyberspace.nexus`; routes by host and path; enforces the endpoint allowlist; rate limits | **Caddy** with **on-demand TLS**: a certificate per BBS subdomain on first use, via HTTP validation, after Caddy asks the control plane whether the name is registered. Needs only a wildcard DNS record, no DNS API. Wildcard certificates (DNS-01) remain an option for hubs whose DNS provider has an API. |
| **Tunnel server** | Accepts outbound tunnels from BBS agents and forwards requests down them | **frp** (`frps`), to be confirmed by spike H0.2 |
| **Tunnel agent** | Runs next to the BBS; connects out to the hub; forwards to the BBS's local web and WebSocket ports | **frp** (`frpc`) with a generated config |
| **Control plane** | Sysop registration (AT OAuth), BBS registry, tunnel tokens, handle verification, hub pages, observed status, directory, admin tools | **TypeScript** (Node.js), using the official AT libraries |
| **Database** | Registrations, tokens (hashed), status, directory index | **SQLite** |

### 2.1 Why these choices

- **TypeScript for the control plane:** it is almost entirely AT work (OAuth,
  Jetstream, writing records), and the official AT libraries are TypeScript.
- **frp for tunnels:** mature, self-hostable, supports subdomain-based HTTP
  routing, path-based routing within a subdomain (`locations`), WebSocket, and
  a **server plugin API** that calls out to our control plane to approve logins
  and proxies. That hook is what lets the control plane enforce "this token
  may only serve this subdomain, with only these paths." Alternatives if the
  spike fails: rathole, chisel, or a custom tunnel over WebSocket.
- **Caddy in front:** keeps TLS and the allowlist in one well-understood
  place, independent of the tunnel software.

### 2.2 Repo layout

```
hub/
  control/    control plane (TypeScript)
  deploy/     Caddy, frps, and compose files for the VPS
  agent/      frpc config templates and a setup script for sysops
  test/       end-to-end tests
```

## 3. Configuration model

Hub configuration (`hub/deploy/hub.yaml`, proposed):

```yaml
domain: hub.cyberspace.nexus       # BBSes get <name>.hub.cyberspace.nexus
tls:
  mode: onDemand                 # onDemand (HTTP validation) or wildcard (DNS-01)
  askUrl: http://control:8080/tls/allowed   # Caddy asks before issuing a certificate
  dnsProvider: ""                # wildcard mode only
tunnel:
  frpsBindPort: 7000             # agents connect here (outbound from the BBS)
  allowedPaths:                  # forwarded to BBSes; see hub.md §4
    - /ws
    - /peer
    - /_enig/atproto/
    - /_enig/handoff/
    - /_enig/signin
    - /_enig/signout
    - /_enig/verify/
    - /assets/
registration:
  open: true                     # anyone with an AT account may register
  reservedNames: [www, api, admin, hub, status, mail]
  maxBbsPerSysop: 3
atproto:
  oauthClientUrl: https://hub.cyberspace.nexus/oauth/client-metadata.json
  hubAccountDid: ""              # hub's own AT account, publishes observed status
limits:
  requestsPerMinutePerBbs: 600
  bandwidthMbPerDayPerBbs: 2048
webTerminal:
  enigTermVersion: ""            # pinned release, verified by SHA-256
```

BBS side (generated for the sysop at registration): an `frpc` config with the
hub address, the BBS's tunnel token, and its two local targets (ENiGMA½ web
and WebSocket ports; [enigma_integration.md](enigma_integration.md) §6).

## 4. Features

### H0. Groundwork

| | |
|---|---|
| Implements | VPS; DNS records `hub` and `*.hub` → VPS in Gandi LiveDNS for `cyberspace.nexus`; three spikes: **H0.1** Caddy on-demand TLS with an `ask` endpoint; **H0.2** frp evaluation (subdomain and path routing, WebSocket, server plugin hooks able to reject a proxy that claims another subdomain or a disallowed path); **H0.3** Jetstream consumer filtered to our record types |
| Depends on | VPS. Gandi LiveDNS accepts wildcard records and has an API, so DNS-01 wildcard certificates are also possible later. |
| Done when | A throwaway test BBS (§6; never the personal dev VM) is reachable at `test.hub.cyberspace.nexus` through frp with a valid certificate; an unregistered name gets no certificate; the frp plugin hook can veto a proxy |

### H1. Edge and routing

| | |
|---|---|
| Implements | Caddy with on-demand TLS (certificates only for registered names); host-based routing to frps; the endpoint allowlist from [hub.md](hub.md) §4; WebSocket passthrough with keepalive; per-BBS rate limits; 404 for everything else |
| Depends on | H0 |
| Done when | Allowed paths reach the BBS; all other paths return 404 without touching the tunnel; WebSocket sessions survive idle periods |

### H2. Tunnel server and agent

| | |
|---|---|
| Implements | `frps` with authentication delegated to the control plane through the server plugin (tokens validated, subdomain and paths enforced); `frpc` config templates for ENiGMA½; agent setup script; reconnection behavior |
| Depends on | H0.2 |
| Done when | A BBS's agent connects with its token, can serve only its own subdomain and allowed paths, and reconnects automatically after network loss or hub restart |

### H3. Sysop registration and BBS registry

| | |
|---|---|
| Implements | Hub web page "Register a BBS": sysop signs in with AT OAuth (base `atproto` scope); chooses a name (reserved-name and format rules); hub stores the registration keyed to the sysop's DID and issues a tunnel token (shown once, stored hashed); token rotation and revocation; admin CLI (list, suspend, delete) |
| Depends on | H2 |
| Done when | A sysop can register, receive a working agent config, rotate the token, and delete the BBS; names can't be claimed twice; admin CLI can suspend a BBS |

Note: before H3 exists, HM1 registers BBSes with the admin CLI only.

**How a BBS proves itself to the hub, in stages** (2026-11-08; the
specs described three different ways):

1. **Tunnel token** (HM1, HM2): the sysop registers with their own AT
   login and gets a token; the tunnel presents it. Simple, and enough
   to start.
2. **The BBS's own DID** (with H4): the registration also records the
   BBS account's DID, and the tunnel additionally proves it with AT
   service auth, so the hub knows the BBS itself, not only its sysop
   ([vision](https://github.com/zerosquaredio/cyberspace-framework/blob/main/docs/vision.md)
   §6.1). Needs the board account to hold a permission for it
   ([development_plan.md](development_plan.md) §6).
3. **Published agreements** (later): the hub's offer and the BBS's
   request and agreement records (vision §4.1) replace the hub's
   private registration as the public statement of the relationship.

### H4. Handle verification

| | |
|---|---|
| Implements | `/.well-known/atproto-did` answered by the hub for each subdomain from the registry ([hub.md](hub.md) §4.1); registering the BBS's own AT account DID |
| Depends on | H3 |
| Done when | A BBS account can set its handle to `name.hub.cyberspace.nexus` and Bluesky verifies it; deleting the registration stops verification immediately |

### H5. Hub-served pages

| | |
|---|---|
| Implements | Per-BBS info page at `/` (name, description, status, connect button); pinned enig-term release served by the hub and pointed at `wss://name.hub.cyberspace.nexus/ws`; offline page when the tunnel is down, showing when the BBS was last seen and its regular hours (listing `hours`), since part-time boards are normal ([hub.md](hub.md) §6) |
| Depends on | H1, H3; H6 for live status |
| Done when | Users can open `https://name.hub.cyberspace.nexus`, see the BBS, and connect in the browser; enig-term files match the pinned SHA-256 |

Coordinate with BBS-side F14 (web sign-in, built 2026-11-07): the sign-in
callback and cookie belong to the BBS, so the info page links to the BBS's
own sign-in route, `/_enig/signin` (with `/_enig/signout`), now on the
allowlist. One thing to settle with F10: after signing in, the BBS sends
the browser to its own copy of enig-term (`/_enig/ws-term/`), which the
hub doesn't forward. Either the BBS gets a setting for where to send the
browser, or the hub answers that path with its own enig-term.

### H6. Observed status

| | |
|---|---|
| Implements | Track agent connect and disconnect (frp server plugin events or frps admin API); publish `observedStatus` records from the hub's AT account ([publishing.md](publishing.md) §3.3); feed the offline page |
| Depends on | H2; hub AT account; record type names (`nexus.cyberspace.*`) |
| Done when | Stopping a BBS's agent updates its observed status within a minute, publicly readable on AT |

### H7. Directory

| | |
|---|---|
| Implements | Jetstream consumer indexing BBS listing, status, and event records; directory web page (search, tags, status, upcoming events); later, the same data as XRPC methods under the hub's `did:web` ([hub.md](hub.md) §5) |
| Depends on | H0.3; BBS-side F9 publishing listings |
| Done when | A BBS that publishes a listing appears in the directory within minutes, with current status and events |

### H8. Operations and moderation

| | |
|---|---|
| Implements | Abuse reporting form and contact; suspend BBS and ban sysop DID; quotas and bandwidth limits; logging without content; metrics and alerting; database backups; terms of service and privacy notice (including the TLS-termination disclosure) |
| Depends on | H3 |
| Done when | Required before public launch: an abusive BBS can be suspended within minutes, logs contain no message content, and backups restore cleanly |

### H9. Sysop admission requirements

| | |
|---|---|
| Implements | Optional verification before a sysop may register (approval queue, payment), reusing the attestation model ([attestation.md](attestation.md)) |
| Depends on | H3 |
| Done when | The hub operator can require approval or verification for new registrations |

### H10. End-to-end privacy (later)

TLS passthrough by SNI, or end-to-end encryption inside the tunnel, so the hub
can't read traffic ([hub.md](hub.md) §7). Research item.

### H11. Hosted accounts (later)

A PDS running beside the hub to create BBS AT accounts automatically at
registration ([hub.md](hub.md) §1.2, [publishing.md](publishing.md) §7).
The same PDS can create **user** accounts, so "sign up at the hub" gives
someone a real, portable AT account (handle like `alice.hub.example`)
without going to Bluesky
([vision](https://github.com/zerosquaredio/cyberspace-framework/blob/main/docs/vision.md)
§6.3). Sysops of hosted BBS accounts still hold their DID's rotation key
(vision §6.1).

### H12. User profiles and vouched identities (split, 2026-11-08)

Now part of the first slice of the common space: profiles are H13, and
vouched identities are part of H14. The original notes are kept below.

- **Profiles:** a small hub profile per user, keyed by DID and created at
  first AT login. No separate hub registration and no passwords.
- **Leaf-vouched identities:** accept short-lived statements signed by a
  registered BBS's DID ("this session is user 42, `alice`, on coolbbs"), and
  show those users as `alice@coolbbs`, so password-only users can take part
  in the common space in a limited way (vision §6.4). Opt-in on both sides:
  the sysop chooses whether their BBS vouches at all, and the hub admin
  chooses which BBSes' vouched users to accept and what they may do, per
  feature (for example chat but not voice). Needs a small BBS-side piece to
  issue the statements, off by default.

Groundwork for the common space (vision stage 2); scheduled with it.

### The common space, first slice (H13 to H18)

Decided 2026-11-08
([vision](https://github.com/zerosquaredio/cyberspace-framework/blob/main/docs/vision.md)
§3.2): after the directory and tunnels, the next thing built is a small
2D common space, before any 3D. Each service is a switch in the hub's
config, off by default; they run as their own processes beside the
control plane, behind the same edge. The BBS side is F18 and F19
([development_plan.md](development_plan.md)).

### H13. User sign-in and profiles

| | |
|---|---|
| Implements | People (not only sysops) sign in to the hub with AT OAuth, identity scope only; a small profile keyed by DID, created at first sign-in, with their presence setting (off by default). No separate registration, no passwords |
| Depends on | H3 (the hub's OAuth client) |
| Done when | A person signs in, sees their profile, and can turn presence on and off |

### H14. Presence

| | |
|---|---|
| Implements | Who is on the hub and on which leaf, from two sources (vision §8.6): the hub's own pages (a signed-in person opening a BBS from them), and reports from BBSes (F18), signed as the BBS, including vouched users without AT accounts (`alice@coolbbs`) where the hub admin accepts them from that BBS. Reports arriving through a BBS are shown as such (`alice via coolbbs`) until the person confirms that BBS at the hub. Consent: shown only with the person's setting on; the rating rule ([hub.md](hub.md) §5.4) |
| Depends on | H13; F18 for reports; a way for a BBS to prove itself (H3's stages: the tunnel's own channel first) |
| Done when | Someone who opened a board from the hub page, and someone who connected to a board by SSH, both appear, and disappear when they leave or turn presence off; a BBS can't report a user as on another BBS |

### H15. Chat

| | |
|---|---|
| Implements | One room for the hub, text only, ephemeral: a short scrollback, nothing stored; a rolling in-memory buffer of a few minutes so a report can carry what was just said (vision §8). Starts with a spike: an IRCv3 server (Ergo) behind a WebSocket gateway, or our own small service |
| Depends on | H13, H14 |
| Done when | People from a browser and from a BBS (F19) talk in the same room; restarting the service leaves no history |

### H16. The live model

| | |
|---|---|
| Implements | The core live model (vision §8.3) as a WebSocket stream: entities (people, BBSes, the room), presence, groups, links. A first draft of its schema under the development names (`nexus.cyberspace.dev.space.*`), versioned; the hub's services and model version listed in its offer record later. Only what each viewer may see is sent to them |
| Depends on | H14, H15; H6 and H7 for BBSes and their status |
| Done when | A client that connects gets the current state, then changes as they happen; a person with presence off never appears in it |

### H17. First views

| | |
|---|---|
| Implements | A 2D map on the hub's web page, drawn from the live model: BBSes (connected or not), who is around, who is talking; and the hub's side of the ANSI view that BBSes show as a door (F19) |
| Depends on | H16 |
| Done when | Two people using different BBSes see each other on the map and chat, one from a browser and one from inside a BBS terminal |

### H18. Blocking and moderation of the common space

| | |
|---|---|
| Implements | The basics (vision §8.7): muting someone for yourself; the hub admin blocking an AT user by DID, a vouched user, or all of a BBS's vouched users, for a room or the whole space, for a time or for good; a BBS withholding its own members (F18); reports that carry the rolling buffer; a record of moderation actions. The first moderation model is hub-moderated; shared and each-leaf-its-own come after |
| Depends on | H14, H15; H8 for the reporting form and admin tools |
| Done when | A blocked person can't appear or speak in the space however they connect, and is told who blocked them; a muted person disappears only for whoever muted them |

## 5. Milestones

| Milestone | Features | Outcome |
|---|---|---|
| **HM0** Groundwork | H0 | Domain, VPS, and spikes done; tunnel choice confirmed |
| **HM1** Reachable | H1, H2, minimal H3 (admin CLI) | A throwaway test ENiGMA½ (§6; never the personal dev VM) is reachable at `test.hub.cyberspace.nexus`, with AT login working through the hub |
| **HM2** Self-service | H3, H4, H5 | Sysops register themselves, get handles, and users connect in the browser |
| **HM3** Discovery | H6, H7 | Observed status and a public directory |
| **HM4** Public launch | H8 | Operations and moderation in place; open to outside sysops |
| **HM5** Common space, first slice | H13 to H18 | Sign-in, presence, one chat room, the live model, a 2D map and an ANSI view, with basic blocking. Built on the test hub; needs HM3, not HM4, but must be in place (with H18) before a public hub turns it on |
| Later | H9, H10, H11 | Sysop verification, end-to-end privacy, hosted accounts |

### 5.1 Dependencies on the BBS plan

| Hub milestone | Needs from [development_plan.md](development_plan.md) |
|---|---|
| HM1 | F3 (AT login) and F10 (running behind a tunnel) to demonstrate end to end; reachability alone needs neither |
| HM2 | F9 (BBS account) for handles; F14 routes for web sign-in |
| HM3 | F9 listing and status records; record type names |
| HM5 | F18 (presence reports) and F19 (the ANSI view) |

## 6. Testing

- **Local:** control plane unit tests; frps and frpc in containers on the VM
  with Caddy's internal CA instead of public certificates.
- **Staging:** the real domain on the VPS. The personal dev VM is never
  exposed to the internet, not even through a tunnel, so the test BBSes
  are:
  - **hosted:** an ENiGMA½ container on the VPS (the F10 test board);
  - **home-based:** an ENiGMA½ in a throwaway VM or container, used for
    nothing else, that only connects outward to the hub. Later, the
    ready-made images (development plan F17).

  End-to-end tests: connect through enig-term, AT login, allowlist
  enforcement, agent reconnect, status changes, and a part-time board:
  stop the home-based board's agent and check its page still exists,
  shows it offline with when it was last seen, and its hours.
- **Security tests:** an agent trying to claim another subdomain or a
  disallowed path is refused; non-allowlisted paths never reach a BBS.

## 7. Deployment

- One small VPS running Caddy, frps, and the control plane via Docker Compose,
  with SQLite on a persistent volume and scheduled backups.
- Ports: 443 (users), the frps bind port (agents), SSH for administration.
- Terminal traffic is light, so a modest VPS should carry many BBSes;
  bandwidth limits protect against file-transfer-heavy boards.

## 8. Open questions

- **Tunnel software:** frp, pending spike H0.2. If its plugin hooks can't
  enforce subdomain and path ownership, fall back to rathole/chisel plus
  enforcement in Caddy, or a custom tunnel.
- ~~**Public domain.**~~ The hub uses `hub.cyberspace.nexus` (decided
  2026-11-06, before any BBS has a handle). BBS handles
  (`name.hub.cyberspace.nexus`) depend on the hub domain, so it should not
  change once BBSes register.
- **Hub as OAuth client for BBSes**, instead of each BBS having its own
  ([hub.md](hub.md) §9). Currently assumed no.
- **SSH through the hub** (not in v1; frp can forward TCP, but it needs a
  port per BBS or SNI-style routing).
- **Multiple hubs:** whether hubs federate (shared directory) or stay
  independent. Direction in the vision, §10.
- **The common space beyond the first slice** (voice, more rooms, the
  other moderation models, assets and avatars) has no features here
  yet; the order is in the vision, §3.2.
- **Ratings** ([hub.md](hub.md) §5.4): the directory (H7) should filter by
  the listing's `rating` from the start, even before there are spaces.
- **Cost model:** free for all, donation-supported, or paid tiers for heavy
  use.
