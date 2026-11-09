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
| **Tunnel server** | Accepts outbound tunnels from BBS agents and forwards requests down them | **frp** (`frps`), confirmed by spike H0.2 |
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
  control/    control plane (TypeScript); also generates the Caddy, frps
              and per-BBS agent configs, so they can't drift apart
  test/       end-to-end tests
  deploy/     compose files for the VPS (later)
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
| Status | The three spikes are done locally (2026-11-08; results below): frp, Caddy's ask-first certificates, and Jetstream all confirmed. The public server, DNS and real certificates remain |
| Done when | A throwaway test BBS (§6; never the personal dev VM) is reachable at `test.hub.cyberspace.nexus` through frp with a valid certificate; an unregistered name gets no certificate; the frp plugin hook can veto a proxy |

**H0.2 result: frp confirmed** (2026-11-08; frp 0.72.0, run on the dev VM
on its loopback address only, in front of the test ENiGMA½).

What worked:

- **Routing** by subdomain and path, several local targets per BBS (the
  web port and the WebSocket port). Paths not claimed get a 404 from the
  tunnel server without reaching the BBS.
- **A terminal session over WebSocket** through `/ws`, held idle for 100
  seconds without dropping.
- **The approval hook** (frp's server plugin, an HTTP call to the control
  plane on every login and every proxy). A stand-in refused each of: a
  wrong token; another BBS's subdomain; the path `/`; no paths at all; a
  TCP proxy; a custom domain; a path with `..` in it. Nothing was opened
  for any of them.
- **It fails closed:** with the hook unreachable, new agents are refused,
  while tunnels already up keep serving.
- **Recovery:** the agent was back 2 seconds after the tunnel server
  restarted. The hook is told when a BBS's proxies close (for observed
  status, H6): at once for a clean stop or a killed agent, and within
  about 15 seconds for an agent that goes silent.

What frp doesn't do, so the edge (H1) or the generated agent config (H2)
must:

1. **Paths are matched as raw prefixes and passed on unchanged.**
   `/assets/../admin` matched `/assets/` and reached the BBS as written,
   where a web server could resolve it to `/admin`. The edge must refuse
   any path with dot segments, encoded slashes or backslashes before it
   reaches the tunnel. Prefix matching also means `/_enig/signinX` reaches
   the BBS; exact paths are the edge's job too.
2. **A visitor's own `X-Forwarded-For` is kept,** with the tunnel
   server's view appended. The edge must replace it, and the BBS's
   trusted-proxy setting must expect the extra hop (requests arrive from
   the agent on `127.0.0.1`).
3. **`X-Forwarded-Proto` is overwritten with `http`,** since the tunnel
   server speaks plain HTTP behind the edge. ENiGMA½ treats a WebSocket
   connection as secure only when it says `https`, and AT login needs a
   secure connection, so the generated agent config sets it
   (`requestHeaders.set.x-forwarded-proto = "https"`; checked).
4. **No path rewriting.** `/ws` arrives as `/ws`. ENiGMA½'s WebSocket
   server accepts any path, so this needs nothing.
5. **No per-BBS tokens of its own** (its built-in token is one shared
   secret). Each BBS's token travels as client metadata and the hook
   checks it, which works. To do in H2: make sure the agent's connection
   is encrypted and checks the hub's certificate, since the token crosses
   it.

For H2, the hook must allow only: proxy type `http`; no custom domains;
the BBS's own subdomain; a non-empty list of paths, each exactly on the
allowlist; and none of frp's other routing options (groups, routing by
HTTP user, host rewriting).

**H0.1 result: Caddy's ask-first certificates work** (2026-11-08; Caddy
2.11.9 on the dev VM's loopback address, in front of the frp setup above,
with Caddy's own test certificate authority in place of a public one).

- **Certificates only for registered names.** The first request for a
  registered BBS's name got a certificate, after Caddy asked the control
  plane. An unregistered name under the hub's domain, and a foreign
  domain, were both denied: the connection failed and no certificate was
  made. Caddy asks again on every attempt for a denied name (5 attempts,
  5 asks) and never again for a name it holds a certificate for, so the
  ask endpoint must be cheap, and the edge rate limited.
- **The whole chain works:** a browser-style request, and a terminal
  session over `wss://`, through Caddy, the tunnel, and the agent to the
  test BBS.
- **Caddy covers the gaps frp left** (above), with three things to get
  right in H1:
  1. *Odd paths are refused* (400) by a rule on the raw path: dot
     segments, doubled or encoded slashes, backslashes and encoded
     nulls. The query string is left alone, so an OAuth callback's
     encoded `iss` still passes.
  2. *Order matters.* Caddy runs `handle` blocks before a bare
     `respond`, so the rule must itself be the first `handle` block. My
     first attempt put it outside, and it silently never ran: `/assets//x`
     and a path with a backslash went through. H1's tests must include
     these cases, so a mistake like that can't pass unnoticed.
  3. *Forwarded headers.* Caddy drops a visitor's own `X-Forwarded-For`
     and sets the real one. It does not drop `X-Real-IP`, which ENiGMA½
     also reads, so the edge removes it. The BBS then sees the visitor's
     address followed by one hub-internal hop, arriving from the agent on
     loopback, which its trusted-proxy setting must allow for (F10).
- The hub answering `/` and `/.well-known/atproto-did` itself, and exact
  paths (`/_enig/signin` but not `/_enig/signinX`), work as path rules.

Not testable locally: real certificates by HTTP validation, which need
the public server and DNS.

**H0.3 result: Jetstream delivers our records** (2026-11-08). A consumer
subscribed with `wantedCollections=nexus.cyberspace.dev.leaf.*` on a
public Jetstream instance connected in under half a second, and received
the test BBS's status record about 230 ms after the BBS wrote it, with
the record's content. Notes for H7:

- Identity and account events for every account on the network arrive
  whatever the filter (about one every two seconds), and must be ignored.
- Rewriting a record with unchanged content produces no event, as
  expected, so the listing's "only when it changes" rule (F9) costs
  nothing here.
- Jetstream only carries what happens while connected (plus a short
  replay by cursor). For BBSes that published earlier, the relay's
  `com.atproto.sync.listReposByCollection` lists every account holding a
  given record type: asked for the listing type, it returned the test
  BBS. So the directory can fill itself at startup, then follow the
  stream.

**H0 is done as far as it can be locally.** Remaining for the public
server: DNS, and real certificates.

### Progress: HM1 working locally (2026-11-09)

The first code is in [`hub/`](../hub/README.md): the control plane
(`hub/control/`, TypeScript run directly by Node 24, with Node's own
SQLite: no runtime dependencies) and an end-to-end test (`hub/test/e2e.sh`).
On the dev VM, on `127.0.0.1` with Caddy's test CA, the whole chain works in
front of the test ENiGMA½: Caddy, frps and the agent run from configs the
hub generates, a terminal session opens over `wss://`, and the end-to-end
test's 44 checks pass, including ten dishonest agents. 39 unit tests.

Built: H1 and H2 as specified (with the spike findings above), and H3's
minimal form, the admin command line (`add`, `list`, `show`, `suspend`,
`resume`, `rotate-token`, `set-did`, `remove`, and the generated configs).
Also handle verification (H4's hub side) and connect/disconnect tracking
(the start of H6). Decided or found while building:

- **The hub's config is JSON,** not YAML: no parser to depend on.
- **Suspension** refuses logins, new routes and new certificates at once,
  but can't cut a tunnel that is already open: frp's agents send no
  heartbeats by default, and a dishonest agent could stop them. Restarting
  the tunnel server cuts it (every other BBS is back within seconds). A
  per-request check (frp's `NewWorkConn` hook) would cut it at once, but
  would make every visitor request depend on the control plane; not done.
- **A bug found end to end:** Node closes idle connections after 5
  seconds, while frps reuses them for up to 90, so now and then a hook
  call failed and frps refused an honest agent. The control plane now
  keeps idle connections for 120 seconds.
- **Checks to keep in H1's tests:** the BBS's own rate limits (ENiGMA½
  limits its sign-in page to 20 requests in 10 minutes) can make a
  test pass for the wrong reason; the end-to-end test probes the tunnel
  with `/ws`, which isn't limited.

**H3, self-registration, working locally** (2026-11-09). The hub's own
site (served at the hub's domain, behind the edge): a sysop signs in with
their AT account, registers a BBS by name and local ports, and gets its
token and agent config once; they can make a new token (the old one stops
at once) or remove a BBS, only their own. Tested live: a sysop signed in
with a real Bluesky account through an SSH tunnel, registered
`cyberspacebbs`, made a new token, and the agent config from the page
connected the test ENiGMA½ through the hub. 55 unit tests; the end-to-end
test still passes.

- **Sign-in asks for identity only** (the `atproto` scope), and the hub
  signs the AT session out as soon as it knows the DID, so it holds no AT
  tokens. Its own browser session is a random token, hashed, `HttpOnly`,
  `SameSite=Lax`, for 7 days.
- Forms are accepted only from the site's own origin; sign-in attempts are
  limited per address and changes per sysop; every page is `no-store`
  with a strict content security policy.
- **The registration policy:** `registration.open` (default on);
  `maxBbsPerSysop` (3). Sysop bans and approval come with H8 and H9.
- **Only the loopback client so far.** Signing in at a public `https://`
  address needs the hub's own client metadata and signing key, as the BBS
  has (F3); it comes with the public server, and the site says so plainly
  if configured for it.

**H5, a BBS's page and web terminal, working locally** (2026-11-09). At
`name.<domain>`, the hub serves the BBS's page (online now, or when it was
last seen) with "Connect in your browser", and its own copy of enig-term at
`/_enig/ws-term/`, the same path the BBS uses, so web sign-in's redirect
works through the hub unchanged. enig-term runs in the visitor's browser;
the hub only serves its files, and a `config.json` made per BBS, locked to
`wss://name.<domain>/ws`, which the edge forwards down that BBS's tunnel.
Tested in a browser: the page showed the test BBS online, and the hub's
enig-term connected through the tunnel to its login screen. 65 unit tests.

- **The release is pinned:** the hub reads the files once, serves only
  those, by exact path, and can refuse a copy that doesn't match a
  fingerprint (`webTerminal.digest`, printed by `web-terminal-digest`).
- **Its own security policy,** which the BBS doesn't send: scripts from
  the hub only, plus enig-term's one inline script by hash and
  WebAssembly; connections only to that BBS; no framing. No violations in
  the browser test.
- **Development trick:** a dev hub named `hub.localhost` lets a browser
  reach any `name.hub.localhost` through one SSH tunnel, since browsers
  send all of `*.localhost` to the local machine. The browser was given a
  session that accepts Caddy's test certificate, rather than trusting
  Caddy's test authority system-wide.
- **The description, hours and ways to connect** come from the BBS's
  listing, with the directory (H7). For one-click login through the hub,
  the BBS must know its public address, `https://name.<domain>` (F10).

**H7, the directory, working locally** (2026-11-09). The hub's own page
is now the directory: "BBSes on this hub" first (online or not, with what
their listings say), then "Elsewhere on the network", marked as listed by
their own accounts and not checked by the hub. Each BBS's page shows its
listing too. Tested against the real network: a sweep found the test BBS's
listing in about a second; with the hub running, the BBS republished its
listing and the change arrived through the stream 8 seconds later, linking
it to its registered name. 85 unit tests.

- **Gathering:** a first sweep asks a relay which accounts hold listings
  (`com.atproto.sync.listReposByCollection`), then fetches them a few at
  a time with pauses. After that a Jetstream, filtered to listing and
  status records, brings changes; the hub saves its place and resumes
  there after a restart. It sweeps again daily, and after any absence
  longer than the stream keeps. A sweep still fetches each listing
  (1 to 2 KB); only unchanged ones aren't rewritten.
- **`directory.scope`:** `network` (the default) or `hub`, which fetches
  only the hub's own BBSes' listings and follows only their accounts.
- **Linking a listing to a registered BBS needs both sides:** the sysop
  names the BBS's account (an optional field on registration, or later on
  their page; a handle is checked both ways against its DID document), and
  that account's listing names the BBS's hub address
  (`https://name.<domain>`). A sysop can't claim another BBS's listing,
  and a listing can't claim a hub name.
- **Anyone can publish a listing,** so every field is checked and cut to
  size, only `https`, `wss`, `ssh` and `telnet` addresses are kept,
  everything is escaped, and the admin can hide accounts
  (`directory hide DID`). Only the ratings in `directory.ratings` are
  shown (`general` by default, [hub.md](hub.md) §5.4).
- **Fetching from addresses others choose** (account servers named in DID
  documents, `did:web` hosts, handles): public `https://` servers only,
  checked when connecting, so DNS can't be switched to an internal address
  in between; size and time limited.
- **The hub's own address** now shows the directory; signing in moved to
  `/signin`.
- Not yet: events (the community calendar records), stats, ads, and ANSI
  banners; the API for apps (§5.2); a large hub's `hub` scope (the stream
  is given the accounts in its address, which keeps it to a few hundred).

Still open, for the public server:

- **The agent's connection.** Agents must use TLS (the tunnel server
  refuses them otherwise, tested), but don't yet check the hub's
  certificate, so the connection is encrypted but not authenticated.
  Options: give frps a real certificate and the agent its name to check;
  or run the tunnel over `wss://` through the edge on port 443, which also
  helps BBSes on networks that block other ports.
- **Cookies for the whole hub domain.** A BBS can send `Set-Cookie` with
  `Domain=hub.example`, which browsers would then send to every other
  BBS's subdomain. Either the hub's domain goes on the Public Suffix List
  (as `github.io` is), so browsers refuse such cookies, or the edge drops
  them.
- **Stale tunnel records.** If frps stops without closing its proxies, the
  registry still shows those BBSes as connected; H6 reconciles with frps's
  own API.

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
allowlist. After signing in, the BBS sends the browser to
`/_enig/ws-term/`; the hub answers that path with its own enig-term
(decided and built 2026-11-09), so the BBS needs no change.

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
| Implements | People (not only sysops) sign in to the hub with AT OAuth, identity scope only; a small profile keyed by DID, created at first sign-in, with their presence setting (off by default). No separate registration, no passwords. Signing in alone doesn't open the common space: by default that needs membership of a connected BBS (H14, vision §8.7) |
| Depends on | H3 (the hub's OAuth client) |
| Done when | A person signs in, sees their profile, and can turn presence on and off |

### H14. Presence

| | |
|---|---|
| Implements | Who is on the hub and on which leaf, from two sources (vision §8.6): the hub's own pages (a signed-in person opening a BBS from them), and reports from BBSes (F18), signed as the BBS, including vouched users without AT accounts (`alice@coolbbs`) where the hub admin accepts them from that BBS. Reports arriving through a BBS are shown as such (`alice via coolbbs`) until the person confirms that BBS at the hub. Consent: shown only with the person's setting on; the rating rule ([hub.md](hub.md) §5.4). **Who may join the common space** (vision §8.7): by default only members of a connected BBS, known from the BBS's signed statement (F18); hub settings for letting in anyone with an AT account, which BBSes count, and a waiting period |
| Depends on | H13; F18 for reports; a way for a BBS to prove itself (H3's stages: the tunnel's own channel first) |
| Done when | Someone who opened a board from the hub page, and someone who connected to a board by SSH, both appear, and disappear when they leave or turn presence off; a BBS can't report a user as on another BBS; someone signed in to the hub who is a member of no BBS can't join the space unless the hub is set to allow it |

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
| **HM1** Reachable | H1, H2, minimal H3 (admin CLI) | A throwaway test ENiGMA½ (§6; never the personal dev VM) is reachable at `test.hub.cyberspace.nexus`, with AT login working through the hub. **Working locally** (2026-11-09); the public server remains |
| **HM2** Self-service | H3, H4, H5 | Sysops register themselves, get handles, and users connect in the browser. H3 and H5 **working locally** (2026-11-09) |
| **HM3** Discovery | H6, H7 | Observed status and a public directory. H7 **working locally** (2026-11-09) |
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

- ~~**Tunnel software.**~~ frp, confirmed by spike H0.2 (2026-11-08): its
  hooks can enforce subdomain and path ownership. Path clean-up and the
  forwarded headers are the edge's job (H0, result).
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
