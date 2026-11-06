# Hub Development Plan

Status: Draft
Last updated: 2026-10-29

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
 *.hub.zerosquared.io     │  on-demand TLS      per-BBS routing                       │    on sysop's machine
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
| **Edge** | Public HTTPS on 443; TLS for `*.hub.zerosquared.io`; routes by host and path; enforces the endpoint allowlist; rate limits | **Caddy** with **on-demand TLS**: a certificate per BBS subdomain on first use, via HTTP validation, after Caddy asks the control plane whether the name is registered. Needs only a wildcard DNS record, no DNS API. Wildcard certificates (DNS-01) remain an option for hubs whose DNS provider has an API. |
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
domain: hub.zerosquared.io       # BBSes get <name>.hub.zerosquared.io
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
    - /_enig/verify/
registration:
  open: true                     # anyone with an AT account may register
  reservedNames: [www, api, admin, hub, status, mail]
  maxBbsPerSysop: 3
atproto:
  oauthClientUrl: https://hub.zerosquared.io/oauth/client-metadata.json
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
| Implements | VPS; DNS records `hub` and `*.hub` → VPS in WordPress.com's DNS settings for `zerosquared.io`; three spikes: **H0.1** Caddy on-demand TLS with an `ask` endpoint; **H0.2** frp evaluation (subdomain and path routing, WebSocket, server plugin hooks able to reject a proxy that claims another subdomain or a disallowed path); **H0.3** Jetstream consumer filtered to our record types |
| Depends on | VPS. **To confirm first:** WordPress.com accepts a wildcard record for `*.hub` (it currently has a catch-all that sends every subdomain to the website). Fallback: delegate `hub.zerosquared.io` with NS records to a DNS provider with an API. |
| Done when | A test BBS on the VM is reachable at `test.hub.zerosquared.io` through frp with a valid certificate; an unregistered name gets no certificate; the frp plugin hook can veto a proxy |

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

### H4. Handle verification

| | |
|---|---|
| Implements | `/.well-known/atproto-did` answered by the hub for each subdomain from the registry ([hub.md](hub.md) §4.1); registering the BBS's own AT account DID |
| Depends on | H3 |
| Done when | A BBS account can set its handle to `name.hub.zerosquared.io` and Bluesky verifies it; deleting the registration stops verification immediately |

### H5. Hub-served pages

| | |
|---|---|
| Implements | Per-BBS info page at `/` (name, description, status, connect button); pinned enig-term release served by the hub and pointed at `wss://name.hub.zerosquared.io/ws`; offline page when the tunnel is down |
| Depends on | H1, H3; H6 for live status |
| Done when | Users can open `https://name.hub.zerosquared.io`, see the BBS, and connect in the browser; enig-term files match the pinned SHA-256 |

Coordinate with BBS-side F14 (web sign-in): the sign-in callback and cookie
belong to the BBS, so the info page links to the BBS's own sign-in route,
which the allowlist must include once F14 defines it.

### H6. Observed status

| | |
|---|---|
| Implements | Track agent connect and disconnect (frp server plugin events or frps admin API); publish `observedStatus` records from the hub's AT account ([publishing.md](publishing.md) §3.3); feed the offline page |
| Depends on | H2; hub AT account; record type names (`io.zerosquared.bbs.*`) |
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

### H12. User profiles and vouched identities (later)

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

## 5. Milestones

| Milestone | Features | Outcome |
|---|---|---|
| **HM0** Groundwork | H0 | Domain, VPS, and spikes done; tunnel choice confirmed |
| **HM1** Reachable | H1, H2, minimal H3 (admin CLI) | The VM's ENiGMA½ is reachable at `test.hub.zerosquared.io`, with AT login working through the hub |
| **HM2** Self-service | H3, H4, H5 | Sysops register themselves, get handles, and users connect in the browser |
| **HM3** Discovery | H6, H7 | Observed status and a public directory |
| **HM4** Public launch | H8 | Operations and moderation in place; open to outside sysops |
| Later | H9, H10, H11, H12 | Sysop verification, end-to-end privacy, hosted accounts, user profiles and vouched identities |

### 5.1 Dependencies on the BBS plan

| Hub milestone | Needs from [development_plan.md](development_plan.md) |
|---|---|
| HM1 | F3 (AT login) and F10 (running behind a tunnel) to demonstrate end to end; reachability alone needs neither |
| HM2 | F9 (BBS account) for handles; F14 routes for web sign-in |
| HM3 | F9 listing and status records; record type names |

## 6. Testing

- **Local:** control plane unit tests; frps and frpc in containers on the VM
  with Caddy's internal CA instead of public certificates.
- **Staging:** the real domain on the VPS, with the VM's ENiGMA½ as the test
  BBS. End-to-end tests: connect through enig-term, AT login, allowlist
  enforcement, agent reconnect, status changes.
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
- **Public domain:** the test hub uses `hub.zerosquared.io`; a separate
  Nexus Lounge domain may replace it for public launch. Since BBS handles
  (`name.hub.zerosquared.io`) depend on the hub domain, moving hubs later means
  BBS accounts change handles; plan the switch before HM4 if it's coming.
- **Hub as OAuth client for BBSes**, instead of each BBS having its own
  ([hub.md](hub.md) §9). Currently assumed no.
- **SSH through the hub** (not in v1; frp can forward TCP, but it needs a
  port per BBS or SNI-style routing).
- **Multiple hubs:** whether hubs federate (shared directory) or stay
  independent.
- **Cost model:** free for all, donation-supported, or paid tiers for heavy
  use.
