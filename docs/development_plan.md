# Development Plan

Status: Draft
Last updated: 2026-11-06

This plan breaks the work into features, says where each one is delivered
(upstream ENiGMA½, our fork, or this repo), and defines how sysops enable it.
Design details live in the other specs; ENiGMA½ specifics are in
[enigma_integration.md](enigma_integration.md).

## 1. Principles

### 1.1 Configuration, not compilation

ENiGMA½ is plain JavaScript (Node.js) with no build step, so there are no
compile-time options. Every feature is switched on by configuration:

- **`config.hjson`:** system settings. All new settings default to off.
- **`menu.hjson`:** which menus and login options callers see. New menu
  entries ship **commented out** in the menu templates
  (`misc/menu_templates/*.in.hjson`), the same way ENiGMA½ ships its optional
  "forgot password" and "feedback" login options.

This follows ENiGMA½'s existing precedent: ActivityPub is off by default and
is enabled with flags at the system, web handler
(`contentServers.web.handlers.activityPub.enabled`), and per-user levels.

### 1.2 Additive, not replacing

AT features are added **alongside** existing behavior; no existing code path
is removed or changed for sysops who don't enable them.

A sysop who wants AT-only access gets it through configuration (F4): disable
password logins and new-user signup, and offer only the AT login option on the
login menu. The password code stays in place; it is simply not reachable.

### 1.3 Rules for upstream PRs

Every PR we send upstream must:

1. **Be off by default,** with **no behavior change** when disabled.
2. **Not load new dependencies unless enabled.** AT libraries are required
   lazily, only when the feature is turned on (ENiGMA½ already does this with
   its Amiga door emulator).
3. **Be small and self-contained:** one feature per PR, reviewable on its own.
4. **Include** tests (Mocha, `test/`), sysop docs (`website/src/content/docs/`),
   config metadata (`core/config/meta.js`) and regenerated schema
   (`npm run build:schema`), menu template entries (commented out), and
   `WHATSNEW.md` / `UPGRADE.md` notes where relevant.
5. **Follow `CONTRIBUTING.md`:** Prettier, ESLint, modern JS, `npm test` passing.
   The pre-commit hook runs ESLint and Prettier automatically.

### 1.4 Delivery tracks

| Track | What goes there | Where |
|---|---|---|
| **Upstream** | Generic, off-by-default features useful to any ENiGMA½ sysop | PRs from feature branches in our fork to `NuSkooler/enigma-bbs` |
| **Fork-only** | Features upstream declines, or that are specific to this project (our record types, hub integration) | Our fork, isolated in their own modules |
| **Add-on mods** | Features tied to third-party services (e.g. Stripe) | Installable modules a sysop drops into `mods/`; no core changes |
| **This repo** | Specs, Lexicons, the hub | `BBS` repo |

If an upstream PR is declined, the feature moves to the fork-only track
unchanged; its module boundaries are designed so that this costs nothing.

## 2. Configuration model

Proposed new `config.hjson` settings, modeled on the existing top-level
`activityPub` block. Names are proposals until agreed with the maintainer.

```hjson
atProto: {
    enabled: false                  //  master switch for all AT features

    oauth: {
        //  loopback: development only, no public URL needed (F1)
        //  public:   production (F3); identified by the web server's own
        //  https:// base URL (contentServers.web.overrideUrlPrefix behind a
        //  proxy or the hub), so there is no separate URL setting
        clientMode: loopback
        //  the scope is always "atproto" (identity only) and is not a setting
    }

    login: {
        allowNewUsers: true         //  create a local user on first AT login
        secureConnectionsOnly: true //  never offer AT login over telnet
        handoffTimeoutSeconds: 300
        //  only this DID may become root (user #1) via AT login (F3)
        rootDid: ""
    }

    webSignIn: {
        enabled: false              //  sign in on a web page before the terminal (F14)
        cookieMaxAgeDays: 30
        allowedOrigins: []          //  origins allowed to open terminal sessions
    }

    admission: {
        //  attestations required for full access (F6)
        policy: { anyOf: [ "open" ] }
        //  group for AT users who log in without meeting the policy;
        //  empty = refuse them instead
        provisionalGroup: provisional
        verifiers: {
            open:           { enabled: true }
            invite:         { enabled: false }  //  DID-bound invites
            inviteCode:     { enabled: false }  //  shareable codes
            sysopApproval:  { enabled: false }  //  uses users.requireActivation
        }
    }

    publishing: {
        enabled: false              //  BBS account and public records (F9)
    }
}

users: {
    //  which login types are accepted system-wide (F4)
    allowedAuthFactor1Types: [ "password", "sshPubKey", "tlsClientAuth", "atproto" ]
}

contentServers: {
    web: {
        handlers: {
            atProto: { enabled: false } //  OAuth metadata and callback routes
        }
    }
}
```

Menu side: an `atprotoLogin` menu and a matching "login with AT" option on the
login matrix, both commented out in `misc/menu_templates/login.in.hjson`.

## 3. Features

Each feature lists what's implemented, its delivery track, its configuration,
and what "done" means.

### F0. Groundwork

| | |
|---|---|
| Implements | Dev environment, library spike, maintainer contact |
| Status | Dev environment done (Ubuntu VM, `~/dev/enigma-bbs`, tests passing). OAuth spike done ([enigma_integration.md](enigma_integration.md) §3.5). Maintainer discussion **deferred** until a proof of concept works (§5.2). |
| Done when | The maintainer has seen the proposal and answered the questions in [enigma_integration.md](enigma_integration.md) §8 (welcome in core, dependency, PR split) |

### F1. AT identity library

| | |
|---|---|
| Implements | `core/atproto/`: a callback-style adapter around `@atproto/oauth-client-node` (Promises stay inside the adapter) exposing handle and DID resolution, authorize, callback, restore, and revoke; state and session stores in a separate `atproto` database (set up like ActivityPub's); library loaded with `import()` at startup only when enabled, so Node 22 stays the minimum ([enigma_integration.md](enigma_integration.md) §3.6). Resolution (with two-way handle verification) and the in-process refresh lock come from the library rather than our own code. Loopback client only; public mode is F3 |
| Status | Implemented on the fork's `atproto-login` branch (2026-11-03); 39 new tests, full suite passing; checked live against bsky.social in loopback mode |
| Track | **Upstream** |
| Config | `atProto.enabled`, `atProto.oauth.clientMode` (`loopback` only) |
| Depends on | F0 |
| Done when | Unit tests cover resolution and store behavior; the OAuth library is not loaded when `atProto.enabled` is false (the empty database is still created, as ActivityPub's is); `npm test` passes |

### F2. Browser handoff service

| | |
|---|---|
| Implements | Generic "open this URL to continue" flow: a waiting terminal session gets a short code and URL; completion in the browser resumes the session. Timeout and cancel. `core/browser_handoff.js`, landing route `/_enig/handoff/<code>`, registered only when a feature that uses handoffs asks for it ([attestation.md](attestation.md) §7.1) |
| Status | Implemented on the fork's `atproto-login` branch (2026-11-04); 26 new tests, full suite passing apart from one upstream test that also fails on upstream `master` |
| Track | **Upstream.** Generic; usable by any future feature needing a browser step |
| Config | Uses the existing web server; one new rate-limit default, `contentServers.web.rateLimits.handoffGet`, alongside the existing ones |
| Depends on | Web server enabled |
| Done when | Tests for code issue, completion, expiry, and cancel; a session cannot be completed twice |

### F3. AT login

| | |
|---|---|
| Implements | `atproto` login type in `authenticateFactor1`; member DID stored as a user property and used for lookup; username derived from handle with collision handling; first-login user creation (since F4: an application form after first login); `atprotoLogin` menu module (enter handle, show handoff URL, wait); web handler for client metadata and callback under `/_enig/atproto/`; secure-connection check (originally ACS `SC`; since F4 the module's own check, with a message); public client mode (client metadata, signing keys) alongside F1's loopback mode |
| Status | **Done** (2026-11-05) on the fork's `atproto-login` branch, in four commits (login core, login screen and callback, public client mode, sysop docs), tagged `pr/03-atproto-login` and pushed. 42 new tests. Logged in live with a real Bluesky account over SSH, first in loopback mode and then in public mode through a Cloudflare quick tunnel: first login created the sysop via `rootDid`, a later login found the same user by DID. enig-term not yet tried |
| Track | **Upstream** |
| Config | `atProto.login.*`, `atProto.oauth.clientMode: public` (uses `contentServers.web.overrideUrlPrefix`; no separate URL setting), `contentServers.web.handlers.atProto.enabled`, menu template entries (commented out) |
| Depends on | F1, F2 |
| Done when | A user can log in with a Bluesky account from enig-term and SSH; logging in again finds the same user by DID after a handle change; AT login is refused on telnet; root cannot be claimed by any DID other than `rootDid`; tests cover username derivation, the root safeguard, and the login path; sysop docs written |

This is the **minimum viable feature**: "log in to an ENiGMA½ board with your
Bluesky account."

**Root safeguard.** User #1 is root: permanently a sysop, with root-only powers
such as reading all private mail. On a fresh install, the first AT login would
otherwise become root. F3 therefore supports two setups:

- `atProto.login.rootDid` names the sysop's DID; only that DID can create
  user #1, and AT login refuses to create user #1 for anyone else.
- Or the sysop creates root locally with `oputil` and links their DID to it
  (an `oputil user` subcommand to set the DID property).

**Web terminal flow.** In enig-term, the handoff URL is opened in a separate
browser tab; no enig-term changes are needed. To verify: whether enig-term
renders the URL as a clickable link (ENiGMA½ already detects hyperlink
support in terminals). The smoother sign-in-first flow is F14.

### F4. Allowed login types

| | |
|---|---|
| Implements | System-wide list of accepted login types, so a sysop can disable password logins (AT-only board), or disable AT. Refused types get a message (`loginAttemptLoginTypeNotAllowed`, `LOGINTYPE` art) rather than a disconnect, and aren't counted as failed logins. Menus show all options; sysops remove the ones they don't want. Also, with F3: new AT users apply after logging in (below) |
| Status | **Done** (2026-11-06) on the fork's `atproto-login` branch, in two commits (the setting; then AT users applying after login), tagged `pr/04-allowed-login-types` and pushed. Tested live on an AT-only board over telnet and SSH: password login and apply refused or redirected, a fresh board's sysop created through Bluesky login and the application form via `rootDid`. Found on the way: config arrays merge with the defaults, so `allowedAuthFactor1Types` is now in `replacePaths` |
| Track | **Upstream.** Small and generic. The application flow belongs with F3's PR, so the split may move when PRs are cut |
| Config | `users.allowedAuthFactor1Types`; menu entries `atprotoApplication`, `newUserApplication`'s `config.atProtoLogin` |
| Depends on | F3 (to be useful), but the setting itself is independent |
| Done when | With password removed from the list, password login and new-user signup are refused with a clear message; default list preserves current behavior |

**AT users apply after logging in.** First AT login no longer creates a user
silently. An account with no user yet goes on to the new user application
(`atprotoApplication`: no password fields, handle shown, username suggested
from the handle), with the proven identity kept on the session for 30
minutes. On AT-only boards, "apply" goes to AT login first, so nobody applies
without proving their account. The `atprotoLogin` menu is no longer gated by
`acs: SC`, which refused silently; it tells telnet callers to use SSH
(`atProto.login.secureConnectionsOnly`). Login matrix order: login, bluesky
login, apply.

### F5. SSH keys for AT users

| | |
|---|---|
| Implements | AT users add an SSH key through ENiGMA½'s existing SSH key config, then log in over SSH without OAuth. Also: after logging in, callers who connected as a new user name are offered the SSH key their client proved (below) |
| Status | **Done** (2026-11-07) on the fork's `atproto-login` branch, in one commit, tagged `pr/05-ssh-key-offer` and pushed. 11 new tests. Tested live: connected as `new` with a key, logged in with Bluesky, saved the offered key, then connected as that user and was logged straight in |
| Track | The offer goes **upstream** with the AT login PRs. **Multiple keys per user** is a separate upstream proposal |
| Config | Existing `loginServers.ssh.*` and `users.allowedAuthFactor1Types` (list `sshPubKey` on AT-only boards); menu `fullLoginSequenceSshKeyOffer`, art `SSHKEYOFR` |
| Depends on | F3 |
| Done when | An AT-created user can register a key and log in over SSH |

**Offering the key a caller connected with.** AT login over SSH needs a
browser every time. Most SSH clients try the user's keys before anything
else, so a caller connecting as `new` has often proven a key already. The
SSH server now checks the signature of such an attempt (ssh2 leaves that to
the application) and keeps the key on the connection. After the welcome
screen, a logged-in caller is asked whether to save it, with the user name
to connect as next time; yes replaces any saved key. The menu skips itself
when no key was proven, the key is already saved, or `sshPubKey` isn't an
allowed login type.

One behavior change: OpenSSH starts with the `none` method, and accepting it
meant clients never offered a key. For new user names, `none` is now refused
when SSH keys are allowed, so the client tries its keys first. Clients
without keys go on to keyboard-interactive or password as before, with no
extra prompt. SyncTERM's behavior with this is not yet checked.

### F6. Admission and verifiers (v1)

| | |
|---|---|
| Implements | Verifier interface ([attestation.md](attestation.md) §6); v1 attestations as groups ([enigma_integration.md](enigma_integration.md) §5); verifiers `open`, `invite`, `inviteCode`, `sysopApproval`; provisional access; global policy checked after AT login; users without a qualifying attestation are offered the matching verifier flow |
| Track | `open` and `sysopApproval` go **upstream with F3**. The **verifier framework, `invite`, `inviteCode`, and provisional access** are proposed upstream; fork-only if declined |
| Config | `atProto.admission.*` |
| Depends on | F3; F9 for sending invite notifications |
| Done when | Each verifier adds the expected groups; invites work only for the invited DID; provisional users can reach only areas opened to them; policy changes take effect without restart; invite codes are single- or limited-use as configured |

**Sysop approval** reuses ENiGMA½'s existing `users.requireActivation`: new
users start `inactive` and the sysop activates them. No new mechanism needed.

**DID-bound invites (`invite`).** The sysop invites a handle; the BBS resolves
it to a DID and records the invite with the groups it grants (default
`users`). The invite is valid only for that DID, so there is no secret to
leak. When the invitee first logs in, they get the invite's groups
immediately. Invites can expire and be revoked. Delivering the notice is F9.

**Shareable codes (`inviteCode`)** remain for "anyone I give this code to."

**Provisional access.** AT users who log in without meeting the policy join
`admission.provisionalGroup` instead of `users`. Because ENiGMA½'s area
defaults are `GM[users]`, provisional users are automatically shut out of
everything except areas the sysop opens to them (e.g. `GM[users,provisional]`
on a welcome board). Promotion is:

- manual: the sysop moves them to `users`; or
- automatic, with existing ACS codes, e.g. `GM[users] | (GM[provisional] & AA7 & NP5)`
  (provisional for a week with five posts).

Menus have **no** ACS check by default, so the sysop docs and menu templates
must show how to restrict sensitive menus (doors, user lists) for provisional
users.

Note: ENiGMA½'s ACS docs list account status `AS` values as `0=inactive,
1=active`, but the code defines `disabled 0, inactive 1, active 2, locked 3`.
Confirm which is right before using `AS` in rules.

### F7. Payment and ID verifiers

| | |
|---|---|
| Implements | `stripe-card`, `id-check` verifiers using F2's handoff and the webhook routes under `/_enig/verify/` |
| Track | **Add-on mods.** Service-specific, so not proposed upstream |
| Config | Each mod's own config block; requires F6 |
| Depends on | F6 |
| Done when | Verification issues an attestation group; chargeback or revocation webhooks remove it; no card data stored locally |

### F8. Attestation table

| | |
|---|---|
| Implements | Proper attestation storage (expiry, revocation, `ref`), with group membership synced from it so ACS rules keep working |
| Track | Proposed **upstream** after F6 has real use; fork-only if declined |
| Config | None new |
| Depends on | F6 |
| Done when | Expired and revoked attestations remove access automatically |

### F9. BBS account and publishing

| | |
|---|---|
| Implements | The BBS's own AT account (OAuth with write scopes); Bluesky announcement posts; events; listing and status records ([publishing.md](publishing.md)); event-scheduler jobs for updates |
| Track | Split: **generic Bluesky announcement posting goes upstream**; the **listing and status records are project-specific** (our record types), so fork-only |
| Config | `atProto.publishing.*` |
| Depends on | F1; record type names (`nexus.cyberspace.*`, decided) |
| Done when | Announcements appear on Bluesky; listing and status records are published and updated on schedule; invite notifications are delivered or handed to the sysop |

**Invite notifications** (for F6 invites), in order of preference:

| Channel | Private | Caveats |
|---|---|---|
| Bluesky DM from the BBS account | Yes | Bluesky-only (DMs are Bluesky's chat service, not AT Protocol). Recipients' default DM setting accepts only accounts they follow, so delivery often fails. Needs a chat permission on the BBS account's session; **verify OAuth support** for it. |
| Sysop sends it themselves | Yes | Always works: the BBS shows a ready-made message and link |
| Public post mentioning the invitee | No | Always notifies, but reveals the invite publicly. Opt-in only |

Default: try a DM, fall back to the sysop-delivered message; public mentions
only when the sysop chooses them. Invites go only to people a sysop names, to
avoid the BBS account looking like a spam bot.

### F10. Running behind a tunnel or the hub

| | |
|---|---|
| Implements | Mostly configuration of existing settings: public URL, `wsTerm.endpoint`, trusted proxy headers, path routing for the web and WebSocket ports ([enigma_integration.md](enigma_integration.md) §6). Hub registration client if needed |
| Track | **Upstream docs PR** for tunnel setup (ENiGMA½ already ships an ngrok dev helper in `dev_util/ngrok`). Hub registration client is fork-only |
| Config | Existing web and WebSocket settings; hub settings TBD |
| Depends on | F3; F11 for the hub part |
| Done when | A BBS on the VM is reachable through a tunnel with AT login working end to end |

### F11. Hub

| | |
|---|---|
| Implements | Tunnel relay, sysop registration, routing, allowed endpoints, handle verification, directory, observed status, serving enig-term ([hub.md](hub.md)). Planned in detail in [hub_development_plan.md](hub_development_plan.md). |
| Track | **This repo** (`hub/`) |
| Config | Hub's own config |
| Depends on | F10; test hub domain (`hub.cyberspace.nexus`, decided) |
| Done when | A BBS behind a home firewall registers, gets `name.hub.cyberspace.nexus`, and users can connect and log in through it |

### F12. Peering (networking phase 1)

| | |
|---|---|
| Implements | Scanner/tosser module for BBS-to-BBS shared boards: peer auth (service auth), store and forward, dedupe, path-based loop prevention ([networking.md](networking.md)) |
| Track | **Fork first**, proposed upstream once proven (ENiGMA½ already accepts message network modules such as binkp and ActivityPub) |
| Config | A new message network block, following existing `messageNetworks` conventions |
| Depends on | F3, F9 (BBS account and DID) |
| Done when | Two BBSes exchange a shared board's messages, including while one is offline |

### F13. Shared resources and clusters

Networking phases 2 and 3 ([networking.md](networking.md) §7–§8). Not planned
in detail until F12 is in use.

### F14. Web sign-in

| | |
|---|---|
| Implements | A start page with "Sign in with Bluesky": OAuth in the same tab, then a session cookie for the BBS host; the page opens enig-term, whose WebSocket connection carries the cookie, and the BBS logs the user in directly, skipping the handle prompt. Later visits log in with one click. Solves persistent login for enig-term users ([enigma_integration.md](enigma_integration.md) §8). |
| Track | **Upstream**, as a follow-up PR to F3 |
| Config | `atProto.webSignIn.*` |
| Depends on | F3; web and WebSocket servers reachable under one host name (direct, tunnel, or hub) |
| Done when | A signed-in browser user reaches the BBS main menu without a login prompt; connections from other sites' pages are refused; logout and OAuth revocation invalidate the cookie |

Design points:

- ENiGMA½'s WebSocket server already reads the connection's HTTP headers, so
  reading the cookie there is a small addition. No enig-term changes are
  expected.
- Cookies are scoped to the host name, not the port, so ENiGMA½'s separate web
  and WebSocket ports still share the cookie.
- **Origin check is mandatory.** Browsers attach cookies to WebSocket
  connections opened by any site, so the WebSocket server must reject
  connections whose `Origin` isn't in `allowedOrigins` (cross-site WebSocket
  hijacking).
- Cookie is `Secure` and `HttpOnly` with a configurable lifetime.
- Behind the hub, the cookie is set by the BBS's own callback for the BBS's
  subdomain, never by the hub.

### F15. In-BBS user manager (candidate)

| | |
|---|---|
| Implements | Sysop screens inside the BBS to approve and activate users, change groups (including promoting co-sysops to `sysops`), and manage invites. Today group changes require shell access (`oputil user group`). |
| Track | Candidate **upstream** proposal; not committed |
| Config | Menu entry gated by `GM[sysops]` |
| Depends on | F6 (invites, provisional users) to be most useful |
| Done when | A sysop can manage an AT-only board entirely from a terminal session |

Terminology note: **root** is user #1 only, permanently; **sysops** are root
plus members of the `sysops` group. Most sysop features check "root or
`sysops`", but a few are root-only (reading all private mail, editing any BBS
list entry), because ENiGMA½'s `isSysOp()` actually means "is root."

### F16. Link AT to an existing account

| | |
|---|---|
| Implements | Existing password users connect their account to an AT identity, so either login works afterwards ([Cyberspace Framework vision](https://github.com/zerosquaredio/cyberspace-framework/blob/main/docs/vision.md) §6.3). Two ways in: "link Bluesky account" in user settings (logged in with a password; approve in the browser, as for AT login), and "I already have an account here" offered after AT login when no user has that DID (enter username and password once, instead of applying). Plus the `oputil user` subcommand for sysops to set or clear a user's DID (noted under F3). Unlinking |
| Track | **Upstream.** Generic; a follow-up to F3 |
| Config | Menu entries (commented out in the templates, as for AT login); no new settings expected |
| Depends on | F3, F4 (the application step it sits before) |
| Done when | A password user links their Bluesky account from settings and then logs in with either; an AT login with an unlinked DID can claim an existing account with its password; one DID can't be linked to two users; failed password attempts count as failed logins; tests cover each path |

Needed for existing boards joining a hub: their users keep their accounts
and gain AT identity, rather than applying again.

## 4. Milestones

| Milestone | Features | Outcome |
|---|---|---|
| **M0** Groundwork | F0 | Environment ready, library verified, maintainer contacted |
| **M1** Log in with Bluesky | F1, F2, F3 | Upstream PRs open for the core AT login |
| **M2** Access control | F4, F5, F6, F14, F16 | AT-only boards, SSH for AT users, invites, provisional access, one-click web sign-in, existing users linking their AT identity |
| **M3** Public presence | F9, F10, F11 | Publishing (including invite notifications), tunnels, and the hub |
| **M4** Networking | F12 | Shared boards between BBSes |
| Later | F7, F8, F13, F15 | Paid verification, attestation table, clusters, in-BBS user manager |

## 5. Branches and PR sequence

### 5.1 Fork branches

| Branch | Purpose |
|---|---|
| `master` | Mirrors upstream exactly; never committed to directly |
| `feature/<name>` | One per upstream PR, branched from `master` |
| `atproto-login` | Current working branch for M1; split into feature branches for PRs |
| `pr/<nn>-<name>` (tags) | Annotated tags on `atproto-login` marking where each planned PR (§5.2) is complete; `nn` is its number in that list. A PR branch is cut from `master` with the commits up to its tag. Moved if the piece changes later |
| `integration` | Our distribution: upstream plus every feature (including fork-only), used to run our own BBS |
| `spike/*` | Throwaway experiments; never merged or pushed |

### 5.2 Planned upstream PRs

We are developing independently first, to get a working proof of concept
before contacting the maintainer or opening PRs (decided 2026-11-04). The
work is still structured so that these PRs can be cut from it later. In
order, each small and independently reviewable:

1. `atProto` config block and the `core/atproto/` library (F1). Inert until
   enabled.
2. Browser handoff service (F2).
3. AT login type, login menu module, and web handler (F3), with docs and
   commented-out menu template entries.
4. Allowed login types setting (F4).
5. Offering callers the SSH key they connected with (F5).
6. Web sign-in (F14).
7. Verifier framework, DID-bound invites, invite codes, and provisional
   access (F6), if the maintainer wants them.
8. Docs: running behind a tunnel (F10).
9. Bluesky announcement posting and invite notifications (F9, generic part).
10. Multiple SSH keys per user (F5), as a separate proposal.
11. In-BBS user manager (F15), as a separate proposal.
12. Link AT to an existing account (F16), as a follow-up to the AT login
    PRs (3 and 4).

## 6. Risks and open questions

- **Maintainer acceptance.** Effectively a single maintainer; preferences on
  naming, structure, and scope may reshape the PR list. Mitigated by
  following existing conventions (ActivityPub's in particular) and opening
  the discussion before PR 1; developing a proof of concept first means some
  rework if the maintainer asks for a different shape.
- **Dependency weight.** `@atproto/oauth-client-node` adds 34 packages
  (~38 MB in `node_modules`). Lazy loading keeps the cost off sysops who
  don't enable it, but upstream may still prefer it as an optional dependency.
- **Node version.** Plain `require()` of the ESM-only library needs Node
  22.12+; ENiGMA½ currently allows `>=22`. Use `import()`, or propose raising
  the minimum.
- **Persistent login for enig-term users.** Addressed by F14 without enig-term
  changes, if the cookie approach holds up in testing.
- **Bluesky DM reach and permissions** (F9). DMs often won't be delivered
  under recipients' default settings, and OAuth support for the chat
  permission needs verifying.
- **Root vs. sysop semantics.** ENiGMA½'s `isSysOp()` means "is root"; any
  upstream change touching privileges should keep that distinction intact.
