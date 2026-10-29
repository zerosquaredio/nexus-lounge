# Hub Spec

Status: Draft
Last updated: 2026-10-29

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
§6), a standard PDS runs as a **separate** service alongside the hub, routed by
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
- Wildcard TLS certificate on the hub.
- The hub selects the target tunnel by the request's `Host` header.
- If the BBS's tunnel is not connected, the hub returns a status page using
  the BBS's latest status ([publishing.md](publishing.md) §3.3).

## 4. Allowed endpoints

To keep the hub from becoming general web hosting (and attractive for
phishing or malware), it forwards **only** the BBS endpoints defined in
[transport.md](transport.md) §2.1:

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
and a BBS cannot serve arbitrary pages under the hub domain.

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
  filtered to the project's record types ([publishing.md](publishing.md) §3).
- It presents a browsable BBS list with name, description, status, and
  upcoming events.
- Any other directory can be built from the same public records; the hub's
  directory is not privileged.
- Optional: expose the directory as XRPC methods (e.g.
  `com.yourbbs.directory.list`) under a `did:web` for the hub, so AT clients
  can call it directly or via their account server's service proxying
  (`atproto-proxy` header, with service auth). References: the atproto.com
  specs (Lexicon, XRPC, service proxying, service auth) and the
  `bluesky-social/feed-generator` starter.

## 6. Status monitoring

The hub can observe whether each BBS's tunnel is connected. Because a crashed
BBS cannot report its own outage, the hub publishes **observed status** from
its own AT account ([publishing.md](publishing.md) §3.3).

## 7. Trust and privacy

- **The hub can read traffic in v1.** TLS terminates at the hub (wildcard
  certificate). This must be stated plainly to sysops and users, as with
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
