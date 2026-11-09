# Development Plan

Status: Draft
Last updated: 2026-11-08

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

The `config.hjson` settings, modeled on the existing top-level
`activityPub` block, as built on the fork (2026-11-08). Names may still
change if the maintainer prefers others.

```hjson
atProto: {
    enabled: false                  //  master switch for all AT features

    oauth: {
        //  loopback: development only, no public URL needed (F1)
        //  public:   production (F3); identified by the web server's own
        //  https:// base URL (contentServers.web.overrideUrlPrefix behind a
        //  proxy or the hub), so there is no separate URL setting
        clientMode: loopback
        //  user logins always ask for "atproto" (identity only); the board
        //  account's write scopes follow from publishing (F9); not settings
    }

    login: {
        allowNewUsers: true         //  false: invitation only (F6)
        secureConnectionsOnly: true //  never offer AT login over telnet
        handoffTimeoutSeconds: 300
        //  only this DID may become root (user #1) via AT login (F3)
        rootDid: ""
    }

    webSignIn: {
        enabled: false              //  sign in on a web page before the terminal (F14)
        sessionDays: 30
        allowedOrigins: []          //  other origins whose pages may use the sign-in
    }

    admission: {
        //  verifiers, in order; the first that admits the applicant decides
        //  (F6): open, invite, invite-code, sysop-approval
        policy: [ "open" ]
        //  group for applicants no verifier admits; empty = refuse them
        provisionalGroup: ""
    }

    publishing: {
        enabled: false              //  the board's own account and records (F9)
        nsidPrefix: "nexus.cyberspace.dev"  //  until the record shapes are final
        minPostIntervalSeconds: 60
        postLangs: [ "en" ]
        listing: {
            description: ""
            tags: []
            rules: ""
            howToJoin: ""
            hours: {}
            deriveEndpoints: true
            endpoints: []
            sysopDid: ""
        }
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
Later features add their own menus the same way (each feature's Config row
names them).

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
| Status | **Done** (2026-11-05) on the fork's `atproto-login` branch, in four commits (login core, login screen and callback, public client mode, sysop docs), tagged `pr/03-atproto-login` and pushed. 42 new tests. Logged in live with a real Bluesky account over SSH, first in loopback mode and then in public mode through a Cloudflare quick tunnel: first login created the sysop via `rootDid`, a later login found the same user by DID. enig-term was tried later, with F14 |
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
| Status | **Done** (2026-11-06) on the fork's `atproto-login` branch, in two commits (the setting; then AT users applying after login), tagged `pr/04-allowed-login-types` and pushed. Tested live on an AT-only board over telnet and SSH: password login and apply refused or redirected, a fresh board's sysop created through Bluesky login and the application form via `rootDid`. Found on the way: config arrays merge with the defaults, so `allowedAuthFactor1Types` is now in `replacePaths`. A later fix belongs with this PR, so include it when cutting the branch: `5218e636` (2026-11-07), the SSH key screen refuses to remove the user's only way to log in and says truthfully what is left |
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
| Implements | Verifier interface ([attestation.md](attestation.md) §6); v1 attestations as groups ([enigma_integration.md](enigma_integration.md) §5); verifiers `open`, `invite`, `invite-code`, `sysop-approval`; provisional access; global policy checked after AT login; users without a qualifying attestation are offered the matching verifier flow |
| Status | **Done** (2026-11-07) on the fork's `atproto-login` branch, in one commit, tagged `pr/08-admission` and pushed. 27 new tests. Tested live over SSH with the Bluesky test account on a board admitting by invite and code only: a wrong code and no code refused on the form, a real code (typed in lower case without dashes) admitted the account active with the code's groups and `verified-invite-code`, one use taken; with `["open"]` the code field is hidden |
| Track | `open` and `sysopApproval` go **upstream with F3**. The **verifier framework, `invite`, `inviteCode`, and provisional access** are proposed upstream; fork-only if declined |
| Config | `atProto.admission.policy` (`open`, `invite`, `invite-code`, `sysop-approval`), `atProto.admission.provisionalGroup`; `oputil atproto invite …` and `invite-code …`; `ET9`/`TL10` in `atprotoApplication` |
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

**Design** (2026-11-07, before coding). Admission applies when an AT
identity with no user yet applies (after AT login or web sign-in); existing
users are never re-checked, so they are grandfathered.

- **Policy**, `atProto.admission.policy`: an ordered list of verifier ids.
  The first that admits the applicant decides. Default `["open"]`, which is
  today's behavior. Read per application, so changes need no restart.
- **Verifiers** (v1), each a small module registered by id in
  `core/atproto/admission/`, with one call: given the applicant (DID,
  handle, any invite code they entered), admit or not, with the groups to
  add, the account status, and a `ref`:
  - `open`: anyone.
  - `invite`: an invite made for this DID (below).
  - `invite-code`: a valid code the applicant entered.
  - `sysop-approval`: admitted, but `inactive` until the sysop activates
    them (ENiGMA½'s existing activation).
  The framework is the upstream proposal; F7's payment and ID verifiers
  plug into it later, adding browser steps then.
- **Attestations as groups:** an admitted user joins `verified-<id>` (e.g.
  `verified-invite`) as well as their normal groups, so ACS can tell how
  someone got in (`GM[verified-invite]`).
- **Provisional access:** with `atProto.admission.provisionalGroup` set
  (e.g. `provisional`), an applicant no verifier admits is created in that
  group only, instead of `users.defaultGroups`, rather than refused.
  Default areas are `GM[users]`, so they see only what is opened to them.
  Promotion: manual (`oputil user group`), or ACS rules as above. Without
  it, they are refused, and told about invite codes if the policy takes
  them.
- **Closed boards:** `allowNewUsers: false` (or `general.closedSystem`)
  now means invitation only: `invite` and `invite-code` still admit, every
  other verifier refuses. `rootDid` is unchanged.
- **Invites** (DID-bound): `oputil atproto invite add HANDLE [--groups
  g1,g2] [--days N]` resolves the handle to its DID and stores the invite
  (groups default `users.defaultGroups`), with `list` and `revoke`. Used
  once, when the invitee's user is created. Nothing secret: only that DID
  can use it. The sysop tells the invitee themselves until F9 sends it.
- **Invite codes:** `oputil atproto invite-code add [--uses N] [--groups
  ...] [--days N]` prints a new code once; only its hash is stored, with
  uses left, expiry and groups; `list` and `revoke`. The applicant enters
  it in a new optional field of the AT application form (`ATNUA`), shown
  only when the policy has `invite-code`; it is checked, and used up, when
  the user is created.
- **Storage:** `invite` and `invite_code` tables in `atproto.sqlite3`
  (schema 3).
- **Not in v1:** in-BBS management (F15), sending invites (F9), the
  attestation table with expiry and revocation (F8), re-verifying existing
  users when the policy is raised.

**What was built** follows the design, with these details settled while
building it:

- The ids are kebab-case, as in [attestation.md](attestation.md) §8
  (`invite-code`, `sysop-approval`), and `open` admits into
  `verified-open` too, for consistency.
- `invite` and `invite-code` start the account active even with
  `users.requireActivation`: the sysop chose them in advance.
- Invites and codes are taken (a conditional update) before the user is
  created and given back if creating it fails, so two applicants can't
  both have the last use.
- Once no code could admit anyone, applying is refused up front ("This
  board is invitation only"), not on the form.
- ENiGMA½ orders focus by view id, so the code field uses ids 9/10 (the
  password fields' ids, unused in the AT form) to sit before the apply
  bar; a hidden field is skipped with `acceptsFocus`.
- `atProto.admission.policy` is in `replacePaths`: config arrays merge
  with the defaults by index, so an empty policy would turn back into
  `["open"]`.

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
| Status | **Part 1 done** (2026-11-08) on the fork's `atproto-login` branch, in one commit, tagged `pr/09-board-account` and pushed: the board account, listing and status records, announcements, and the ready-made invite message. 21 new tests. Tested live with the Bluesky test account as the board account: connected from the `BA` screen (the consent page listed only the granular permissions), the listing and status read back publicly from the account's host, and a first announcement posted from the screen (2026-11-08). The screen is sysops-only by its menu ACS; `ID1` makes it root-only. Part 2 (triggered posts, including a "we've moved" post when the board's addresses change, events, stats, ads, art, bridging, DM invites, and the listing's `rating` with matching self-labels, [hub.md](hub.md) §5.4) is still to do |
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

**Design** (2026-11-07, before coding). F9 is split; this first part is
the board account, the listing and status records, and announcements.
Triggered posts, events, stats, ads, ANSI art images, board bridging and
DM invites come after.

- **Permissions:** granular OAuth scopes, which bsky.social supports, not
  the broad `transition:generic`: `atproto`, `repo:` for the listing and
  status record types and for `app.bsky.feed.post`, and `blob:image/*`
  (for art, later). The client metadata (loopback `client_id` or the
  public metadata document) lists all of them; user logins still ask for
  `atproto` alone. DMs would need Bluesky's chat permission; deferred.
- **A separate session store for the board account** (an
  `oauth_board_session` table), used by a second OAuth client instance
  with the same client metadata. User sessions and the board's are both
  keyed by DID, so sharing a store would let the board account's owner
  logging in as a user replace the board's write session with a
  login-only one (the test account is also a user here).
- **Connecting the account:** a sysop-only screen in the BBS (`BA` in the
  main menu template, commented out, gated to sysops), built on the AT
  login screen: enter the board account's handle, approve in a browser,
  and the board keeps the write session. Shows the account, and lets the
  sysop disconnect it (revoking the session).
- **No new dependency:** records and posts are written with the OAuth
  session's own authenticated requests (`com.atproto.repo.putRecord`,
  `createRecord`), not `@atproto/api`.
- **Record names:** under `nexus.cyberspace.dev.*` until the shapes are
  final (publishing spec §3.8), from one setting
  (`atProto.publishing.nsidPrefix`), so switching to the real names later
  changes no code.
- **Listing** (`leaf.listing`, key `self`): the board name, and from
  `atProto.publishing.listing`: description, tags, rules, `howToJoin`,
  `hours`, extra `endpoints`, and optionally the sysop's DID. Endpoints
  are derived from the enabled servers (web/enig-term, SSH, telnet) plus
  any listed. `admission.policy` comes from `atProto.admission.policy`.
  Published at startup, when the config changes, and daily, only when it
  differs from what was last written.
- **Status** (`leaf.status`, key `self`): set by the sysop
  (`oputil atproto status up|maintenance|degraded|down [--message ...]
  [--until ...]`). The hub's observed status (F11) covers whether the
  board is actually reachable.
- **Announcements:** `oputil atproto post "text"`, and the same from the
  sysop screen. Plain text with link facets; rate limited.
- **Invite notifications:** `oputil atproto invite add` prints a
  ready-made message for the sysop to send (the "sysop sends it" row
  above); DMs later.
- **oputil** uses the stored board session directly (it can restore it
  without the BBS running), so publishing works from the command line too.
- Off by default (`atProto.publishing.enabled`).

Testing uses the Bluesky test account as the board account. Posts from it
are public, so the first live post waits for the user's go-ahead.

### F10. Running behind a tunnel or the hub

| | |
|---|---|
| Implements | Mostly configuration of existing settings: public URL, `wsTerm.endpoint`, trusted proxy headers, path routing for the web and WebSocket ports ([enigma_integration.md](enigma_integration.md) §6). Hub registration client if needed |
| Track | **Upstream docs PR** for tunnel setup (ENiGMA½ already ships an ngrok dev helper in `dev_util/ngrok`). Hub registration client is fork-only |
| Config | Existing web and WebSocket settings; hub settings TBD |
| Depends on | F3; F11 for the hub part; a VPS (the dev VM is never exposed to the internet) |
| Done when | A hosted test BBS on the VPS (e.g. `test.cyberspace.nexus`, behind Caddy) works end to end over the internet: AT login in `public` mode, enig-term over `wss://`, and web sign-in. The home-based model is tested with the hub (F11) |

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
| Status | **Done** (2026-11-07) on the fork's `atproto-login` branch, in one commit, tagged `pr/07-web-sign-in` and pushed. 37 new tests. Tested live with enig-term 0.3.1 and a Bluesky test account, through an SSH tunnel on `127.0.0.1`: sign-in, a one-click login (also after a restart), a same-site page at another origin ignored, sign-out, and revoking the board at the account host (`bsky.social/account`, Apps) signing the browser out |
| Track | **Upstream**, as a follow-up PR to F3 |
| Config | `atProto.webSignIn.*` (`enabled`, `sessionDays`, `allowedOrigins`), `loginServers.webSocket.firstMenuSignedIn`; menu `webSignInConnected` |
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

**Design** (2026-11-07, before coding):

- **Start page**, `GET /_enig/signin` on the web server. Signed out: a
  handle field and "Sign in with Bluesky". Signed in: "Continue as
  @handle" (opens enig-term at `/_enig/ws-term/?connect=1`) and "Sign out".
- **Sign-in**, `POST /_enig/signin`: starts OAuth with `state` naming a
  web sign-in flow (the callback tells it apart from terminal handoffs),
  sets a short-lived flow cookie (`SameSite=Lax`, so it comes back on the
  redirect from the account host), and redirects to the account host. The
  existing callback, for a web sign-in state, checks the flow cookie
  matches (so a sign-in can't be finished in another browser), creates a
  session, sets the session cookie, and redirects to enig-term.
- **Session cookie**: a random token; only its hash is stored, with the
  DID and expiry, in the AT database next to the OAuth sessions, so
  restarts keep people signed in. `HttpOnly`, `Secure`, `SameSite=Lax`,
  host-only (so it reaches the WebSocket on another port of the same host).
  Lax rather than Strict: browsers still never send it on WebSocket
  connections or POSTs other sites start, and the start page recognizes a
  browser arriving from a link.
  Lifetime `atProto.webSignIn.sessionDays`. One per browser; a DID can
  have several.
- **WebSocket**: on upgrade, the cookie is honored only if `Origin` is one
  of the board's own web origins (or `atProto.webSignIn.allowedOrigins`).
  Connections from other origins are still accepted, as today, but
  anonymous, so third-party web clients keep working and cross-site
  hijacking gets nothing. A valid session is then checked against the AT
  OAuth session, refreshing it, so access revoked at the account host ends
  the web session; then the caller starts at
  `loginServers.webSocket.firstMenuSignedIn` instead of the matrix.
- **That menu** (module `atproto_web_sign_in`) proves nothing itself: it
  hands the identity to the AT login flow (`identityProven`), so linked
  users are logged in, unknown DIDs link or apply, and account states,
  2FA and `allowedAuthFactor1Types` all apply as for AT login. Any failure
  falls back to the matrix.
- **Sign out**, `POST /_enig/signout`: deletes the session and clears the
  cookie. Logging off the BBS does not sign the browser out.
- Off by default (`atProto.webSignIn.enabled`); needs AT login and the web
  handler. Routes rate limited like the AT callback.

Dev test setup: the SSH tunnel serves the web server and the `ws://`
listener both on `127.0.0.1` (enig-term allows `ws://` for loopback), so
page and WebSocket share the cookie without certificates.

**What was built** follows the design above, with these findings from
testing:

- With `Referrer-Policy: no-referrer`, browsers send `Origin: null` even on
  a page's own form posts, so the sign-in pages use `same-origin`.
- A menu with no form is moved on to its `next` by ThemeManager
  (`runtime.autoNext`), which raced the login. The web sign-in menu
  overrides `autoNextMenu()`, as `message_base_offline_export.js` does, so
  only a completed login moves the caller on.
- Revocation surfaces as the library's `TokenRefreshError` ("Invalid
  refresh token"); then all of that DID's web sessions end. Other errors,
  such as the account host being unreachable, only send that one
  connection to the usual login.
- A signed-in connection still follows `atProto.login.secureConnectionsOnly`,
  so the dev setup (plain `ws://`) turns it off.

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
| Implements | Existing password users connect their account to an AT identity, so either login works afterwards ([Cyberspace Framework vision](https://github.com/zerosquaredio/cyberspace-framework/blob/main/docs/vision.md) §6.3). Two ways in: "link Bluesky account" in user settings (logged in with a password; approve in the browser, as for AT login), and "I already have an account here" offered after AT login when no user has that DID (enter username and password once, instead of applying). Plus the `oputil user` subcommand for sysops to set or clear a user's DID (noted under F3), and unlinking from settings |
| Status | **Done** (2026-11-07) on the fork's `atproto-login` branch, in one commit, tagged `pr/06-link-at-account` and pushed. 18 new tests. Tested live: an AT login with an unlinked DID claimed a password user; from the settings screen, a user linked a Bluesky account (then logged in with it) and unlinked one, and unlinking with no other way to log in, or with a wrong password, was refused |
| Track | **Upstream.** Generic; a follow-up to F3 |
| Config | Menus `atprotoLinkAccount` (after AT login; set as `linkAccount` in the AT login menu's config) and `userAtProtoConfig` (settings, command `AT`, commented out in the main menu template); art `ATLINK`, `ATCFG`; no new settings |
| Depends on | F3, F4 (the application step it sits before) |
| Done when | A password user links their Bluesky account from settings and then logs in with either; an AT login with an unlinked DID can claim an existing account with its password; one DID can't be linked to two users; failed password attempts count as failed logins; tests cover each path |

Needed for existing boards joining a hub: their users keep their accounts
and gain AT identity, rather than applying again.

**What was built.** After AT login with a DID no user has, the caller is
asked whether they already have an account here. Yes takes their user name
and password once, through the normal password login (so wrong passwords
count as failed logins and lock out as usual), then links the DID and logs
them in; no goes on to apply. An account with two-factor authentication is
refused there, because the link would be saved before the second factor:
it logs in with its password and links from settings instead.

The settings screen links by proving the AT identity in the browser, as AT
login does, and unlinks with the user's password or a saved SSH key, so
they keep a way to log in. Linking replaces any DID the user had; a DID
already linked to another user is refused everywhere, including `oputil
user atproto USERNAME DID|clear`.

Two gaps, left for later: a wrong password when unlinking (already logged
in) is not counted as a failed login; and if an operator removes a user's
SSH key with `oputil` during their session, the session still counts the
key when unlinking.

Found in the SSH key menu while testing. Upstream bugs, fixed on the
fork's `feature/ssh-key-config-actions` branch (from upstream `master`)
and offered upstream as
[NuSkooler/enigma-bbs#987](https://github.com/NuSkooler/enigma-bbs/pull/987)
(2026-11-07): the action bar was a toggle
view, which keeps only two items, so "cancel" never showed; and the
status box drew over two lines of the art. Ours, since upstream always
allows passwords, and fixed in `5218e636` (2026-11-07, with F4): after
removing a key it said password login "remains available" even where
passwords aren't allowed, and it let a user remove their only way to log
in.

### F17. Ready-made BBS images

| | |
|---|---|
| Implements | Framework-standard images so anyone can start a BBS quickly: a Docker image (and Compose file) and a VM image, with ENiGMA½ from the fork, AT login, web sign-in and enig-term set up, sensible admission defaults, the hub agent, and a first-run setup that asks for the board name, the sysop's Bluesky handle (`rootDid`), and hosted or home-based. Runs on a server, a home VM, a spare machine, or someone's own computer, and need not be up all the time ([hub.md](hub.md) §6) |
| Track | **This repo** (or a small `images` repo of its own). Builds on ENiGMA½'s own Docker image |
| Config | The image's first-run settings; publishes the listing's `hours` if the sysop gives them |
| Depends on | F10 (hosted), F11 (home-based, through the hub) |
| Done when | Someone with no ENiGMA½ experience starts a board from the image, signs in as its sysop with Bluesky, and it appears on the hub, in both models |

### F18. Presence reports to the hub

| | |
|---|---|
| Implements | With the sysop's switch on, the BBS tells its hub who is on, for members who have chosen to be shown (a setting in their user config, off by default): connecting, leaving, and optionally where they are (a door, a chat room), sent over the BBS's connection to the hub and signed as the BBS ([vision](https://github.com/zerosquaredio/cyberspace-framework/blob/main/docs/vision.md) §8.6). The same statement tells the hub the person is a member here, which is what lets them into its common space by default (vision §8.7). Members with a linked AT identity are reported by DID; with a second switch, members without one are reported as local users (`alice@coolbbs`, vision §6.4). The sysop can keep any member out of the hub's space, whatever the member's own setting (vision §8.7) |
| Track | **Fork-only** (hub integration) |
| Config | `atProto.hub.presence.*` (names to be settled with the hub settings, F10 and F11); a user config entry |
| Depends on | F9 (the board's identity), F11; hub H14 |
| Done when | A member who turned it on appears on the hub when they log in by any route, and is gone when they log off or turn it off; nobody is reported without their own setting on; a member the sysop withheld never appears |

### F19. The hub as a door

| | |
|---|---|
| Implements | A menu module showing the hub's common space inside the BBS, as an ANSI view of the hub's live model (hub H16, H17): who is around, grouped by who is talking, and the hub's chat room, as the caller's reported identity (F18). So a caller on an ordinary terminal can see and talk to people on other BBSes |
| Track | **Fork-only** |
| Config | A menu entry (commented out in the templates); art |
| Depends on | F18; hub H15 to H17 |
| Done when | A caller opens it from the main menu, sees people from another BBS and from the hub's web page, and chats with them |

## 4. Milestones

| Milestone | Features | Outcome |
|---|---|---|
| **M0** Groundwork | F0 | Environment ready, library verified, maintainer contacted |
| **M1** Log in with Bluesky | F1, F2, F3 | Upstream PRs open for the core AT login |
| **M2** Access control | F4, F5, F6, F14, F16 | AT-only boards, SSH for AT users, invites, provisional access, one-click web sign-in, existing users linking their AT identity |
| **M3** Public presence | F9, F10, F11, F17 | Publishing (including invite notifications), tunnels, the hub, and ready-made BBS images, for hosted and home-based boards |
| **M4** Common space, first slice | F18, F19 (with hub H13 to H18) | Members appear on the hub and can chat with people on other BBSes, from a browser or from inside the BBS (decided 2026-11-08, vision §3.2) |
| **M5** Networking | F12 | Shared boards between BBSes |
| Later | F7, F8, F13, F15 | Paid verification, attestation table, clusters, in-BBS user manager |
| After M4 | (not yet split into features) | Voice, then assets and avatars, then the 3D and VR social space: Overte worlds, AT login through a hub-run metaverse server, a browser client, an in-world BBS terminal. Decision and next steps in [overte_evaluation.md](overte_evaluation.md) |

## 5. Branches and PR sequence

### 5.1 Fork branches

| Branch | Purpose |
|---|---|
| `master` | Mirrors upstream exactly; never committed to directly |
| `feature/<name>` | One per upstream PR, branched from `master` |
| `atproto-login` | Current working branch, and the fork's default branch on GitHub (since 2026-11-07), so visitors see our work first; split into feature branches for PRs. One commit on it is fork-only: the README note that the fork is part of the Cyberspace Framework (`2b0f7c83`), left out when cutting PR branches |
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
6. Linking an AT identity to an existing account (F16).
7. Web sign-in (F14).
8. Verifier framework, DID-bound invites, invite codes, and provisional
   access (F6), if the maintainer wants them.
9. The board's own Bluesky account: announcement posting and the invite
   message (F9, generic part). The tag `pr/09-board-account` also covers
   the listing and status records, which are project-specific and stay on
   the fork; they are separated out when this PR branch is cut.
10. Docs: running behind a tunnel (F10).
11. Multiple SSH keys per user (F5), as a separate proposal.
12. In-BBS user manager (F15), as a separate proposal.

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
- **The board account's permissions** (F9, F11, F12). Proving the board's
  identity to a hub or a peer with AT service auth probably needs an
  `rpc:` permission on the board account's session, beyond the `repo:`
  and `blob:` ones F9 asks for (to verify against the permission spec).
  Adding a permission later means every sysop reconnects the board
  account, so the full set should be settled before real boards connect.
- **Root vs. sysop semantics.** ENiGMA½'s `isSysOp()` means "is root"; any
  upstream change touching privileges should keep that distinction intact.
