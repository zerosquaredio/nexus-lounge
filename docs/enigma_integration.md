# ENiGMA½ Integration Spec

Status: Draft
Last updated: 2026-10-29

## 1. Decision

The BBS is **ENiGMA½** (github.com/NuSkooler/enigma-bbs) with AT Protocol
support added as modules. We do not write a new BBS.

| Component | Where it lives |
|---|---|
| AT login, verifiers, publishing, peering | Modules in a GitHub fork of ENiGMA½, contributed upstream where accepted |
| Hub | This repo; independent of BBS software |
| Specs, Lexicons | This repo |

The other specs describe behavior in BBS-neutral terms; this doc maps them
onto ENiGMA½.

### 1.1 Why ENiGMA½

Evaluated 2026-10-29 by reading source at commit `6d32e9b`:

- **License:** BSD-2-Clause. Forking and modifying are permitted; the
  copyright notice must be kept.
- **Activity:** very active (342 commits in the past year). Effectively a
  single maintainer (Bryan Ashby, ~90% of recent commits).
- **Language:** JavaScript (CommonJS), Node.js. Not TypeScript.
- **Fit:** login is centralized and already supports multiple login types;
  users have an extensible property table; the web server and menus accept
  plugins; it already ships a browser terminal (enig-term) and WebSocket
  login server; it already supports federation (ActivityPub, FidoNet/binkp,
  QWK, MRC), so upstream accepting AT integration is plausible.
- **Classic features for free:** message and file areas, doors (including
  Amiga doors), ANSI/CP437 art and themes, event scheduler, sysop tools.

### 1.2 Upstream strategy

1. Open a discussion with the maintainer before significant work, proposing
   AT login as an additional login type.
2. Develop on feature branches in our fork, keeping each feature in separate
   modules with minimal core changes.
3. Submit upstream PRs per feature, starting with AT login (§3).
4. If a feature is declined, keep it in the fork as an isolated module and
   keep `master` synced with upstream.

Follow upstream's `CONTRIBUTING.md`: Prettier, modern JS, `npm test` before
PRs.

## 2. ENiGMA½ concepts used

| ENiGMA½ concept | Location | Used for |
|---|---|---|
| Users: integer ID, unique username, key/value properties | `core/user.js`, `user_property.js`, `database.js` | Storing a member's DID as a property |
| Login types (`AuthFactor1Types`: password, SSH key, TLS client) in `authenticateFactor1` | `core/user.js` | Adding an AT login type |
| Second factor (`AuthFactor2`) and temporary tokens | `core/user_2fa_otp*.js`, `user_temp_token.js` | Model for the browser-handoff wait state |
| Web server routes (`addRoute`, regex paths under `/_enig`) and web handler plugins | `core/servers/content/web.js`, `web_handler_module.js` | OAuth metadata and callback, verifier webhooks |
| Menu modules | `core/menu_module.js`, `mods/` | Handle entry and "open this URL" login screen |
| Groups and ACS rules (`GM[...]`, `SC`, account status) | `core/acs.js`, `misc/acs_parser.pegjs`, `user_group.js` | v1 attestations; restricting AT login to secure connections |
| WebSocket login server (terminal stream over WebSocket) | `core/servers/login/websocket.js` | Terminal transport |
| enig-term browser terminal at `/_enig/ws-term/` | `contentServers.web.wsTerm` config | Web terminal client |
| Scanner/tosser modules (`startup`, `shutdown`, `record(message)`) | `core/msg_scan_toss_module.js`, `core/scanner_tossers/` | BBS-to-BBS peering |
| Event scheduler | `core/event_scheduler.js` | Periodic publishing and status updates |

## 3. AT login

Implements [attestation.md](attestation.md) §3.

### 3.1 Login type

- Add an `atproto` login type alongside the existing ones in
  `authenticateFactor1`.
- The member's DID is stored as a user property (e.g. `atproto_did`).
  Members are looked up by DID (`getUserIdsWithProperty`), never by handle.
- ENiGMA½ requires a unique username. On first login, derive one from the
  handle (e.g. `alice` from `alice.bsky.social`), resolving collisions. The
  username is local and stable; handle changes don't affect it.
- First login creates the user record (the ENiGMA½ equivalent of new user
  signup), then admission is checked (§5).

### 3.2 Login flow

1. A **login menu module** asks for the handle, resolves it, starts OAuth,
   and shows the handoff URL ([attestation.md](attestation.md) §7.1). The
   session waits, with timeout and cancel.
2. A **web handler plugin** serves the OAuth client metadata and callback.
   On callback, it completes the waiting session.
3. The session is then logged in through the normal post-login path
   (`userLogin` in `core/user_login.js`), so stats, themes, and events work
   unchanged.

### 3.3 Routes

| Logical endpoint ([transport.md](transport.md) §2.1) | ENiGMA½ route |
|---|---|
| OAuth client metadata | `/_enig/atproto/client-metadata.json` |
| OAuth callback | `/_enig/atproto/callback` |
| Browser handoff landing | `/_enig/atproto/login/<code>` |
| Verifier callbacks and webhooks | `/_enig/verify/<verifier-id>/...` |

### 3.4 Secure connections only

AT login is offered only on secure connections (ACS `SC`: SSH, `wss://`, or
TLS). Telnet stays available for sysops who want it, but cannot be used for
AT login.

### 3.5 OAuth library

Verified 2026-10-29 (spike on `spike/atproto-oauth`, Node 24.19,
`@atproto/oauth-client-node` 0.5.13):

- The library is **ESM-only** (`"type": "module"`, no CommonJS build).
- Plain `require()` from ENiGMA½'s CommonJS code **works**, via Node's
  built-in `require(esm)` support (unflagged since Node 22.12). Dynamic
  `import()` also works.
- A real authorization request against `bsky.social` succeeded using a
  loopback development client (`http://localhost` client ID, no hosted
  metadata or keys), returning an approval URL. Loopback clients are the way
  to develop locally before the BBS has a public HTTPS address.
- ENiGMA½'s `engines` field allows Node `>=22`. Node 22.0–22.11 lacks
  unflagged `require(esm)`, so either use `import()` or propose raising the
  minimum to `>=22.12`.
- The library warns when no `requestLock` is configured (concurrent token
  refreshes can revoke a session). ENiGMA½ runs as a single process, so an
  in-process lock is sufficient.

## 4. Credentials (subsequent logins)

Implements [attestation.md](attestation.md) §3.2.

| Client | ENiGMA½ mechanism | Gap |
|---|---|---|
| SSH | Existing SSH key login (`user_ssh_key_config.js`) | ENiGMA½ stores **one** key per user; the spec allows several. Accept one key for v1; propose multiple keys upstream later. |
| enig-term (browser) | None yet: enig-term connects to the WebSocket login server like any terminal, so the BBS sees no browser cookie | Open question (§8) |
| Native client | None yet | Later |

## 5. Attestations and admission

Implements [attestation.md](attestation.md) §4–§6.

- **v1: attestations are groups.** Each verifier, on success, adds the user
  to a group named after it (e.g. `verified-invite`, `verified-card`). Access
  rules use the existing ACS group check (e.g. `GM[verified-card]`), so no
  ACS changes are needed.
- **Later:** a proper attestation table (expiry, revocation, `ref`), with
  group membership synced from it so ACS rules keep working.
- The global login policy is checked right after AT login; users without a
  qualifying attestation are offered the matching verifier flows.
- Bans: ENiGMA½'s account status (`disabled`) on the user record, keyed to
  the DID through the user's `atproto_did` property.

## 6. Transport and the hub

Implements [transport.md](transport.md) and [hub.md](hub.md).

- ENiGMA½ serves the **web server** and the **WebSocket login server** on
  separate ports (defaults 8080/8443 and 8810/8811).
- Behind a tunnel or the hub, both must be reachable at one public host. Use
  path-based routing in the tunnel (e.g. Cloudflare Tunnel ingress rules) or a
  small local reverse proxy:

  | Public path | Local target |
  |---|---|
  | `/ws` | WebSocket login server |
  | `/_enig/...` | Web server |

- Set `contentServers.web.wsTerm.endpoint` to the public `wss://` URL (e.g.
  `wss://coolbbs.hub.example/ws`).
- The hub serves enig-term itself ([hub.md](hub.md) §4), pointed at the BBS's
  `/ws`.

## 7. Publishing and peering

- **Publishing** ([publishing.md](publishing.md)): a module holding the BBS
  account's OAuth session, with the event scheduler driving status and
  listing updates.
- **Peering** ([networking.md](networking.md)): a new scanner/tosser module,
  alongside the existing FidoNet/binkp and ActivityPub ones. Shared boards are
  ordinary ENiGMA½ message areas bound to the peering network. The `/peer`
  endpoint's listener (web server upgrade vs. separate port) is to be
  decided.

## 8. Open questions

- Persistent login for enig-term users: planned as web sign-in with a session
  cookie read on the WebSocket connection, without enig-term changes
  ([development_plan.md](development_plan.md) F14). To be confirmed in
  testing.
- Whether upstream will accept AT login, and in what shape.
- Username derivation rules for handles (length limits, allowed characters,
  collisions).
- Where the `/peer` listener lives (§7).
