# Authentication & Attestation Spec

Status: Draft
Last updated: 2026-10-28

## 1. Overview

The BBS is a terminal application served over HTTPS/WebSocket (see
[transport.md](transport.md)) that uses the AT Protocol **for user identity
only**. AT Protocol proves *who* a user is; the BBS decides *whether they may
enter* and *what they may access*.

All BBS content (boards, messages, mail, chat, presence) lives in the BBS's own
database. Nothing is written to users' AT repositories, so nothing is public
unless the BBS chooses to publish it. The BBS's own public output (listings,
announcements, events, status) is covered in [publishing.md](publishing.md).

This spec is BBS-neutral. How it maps onto ENiGMA½ (login type, routes,
groups as v1 attestations) is in [enigma_integration.md](enigma_integration.md).

The design separates two concerns:

| Concern | Question | Mechanism |
|---|---|---|
| **Authentication** | Is this really `did:plc:abc123`? | AT OAuth (first login), then a bound client key or session (subsequent logins). Fixed, not pluggable. |
| **Admission** | Is this DID allowed in, and into which areas? | Attestations issued by pluggable verifiers, evaluated by access policies. |

Being authenticated never implies being admitted. Code must not treat
"logged in" as "allowed."

## 2. Identity

- Every member is identified by their **DID**. Handles are display names only.
  - Handles can change or be reassigned; DIDs are permanent.
  - Store the DID; resolve the current handle for display and refresh it
    periodically.
- A user's identity is vouched for by **their own** account host (PDS /
  authorization server), e.g. Bluesky for `*.bsky.social` users. For
  `did:plc` identities, the PLC directory is also trusted for DID resolution.
- AT authentication proves control of an account, **not** real-world identity.
  Accounts are effectively pseudonymous unless a verifier (§5) says otherwise.

## 3. Authentication flow

### 3.1 First login (AT OAuth with browser handoff)

1. User connects (web terminal, native client, or SSH; see
   [transport.md](transport.md)) and enters their handle
   (e.g. `alice.bsky.social`).
2. BBS resolves handle → DID → PDS → authorization server.
3. BBS starts an OAuth request and displays a short URL in the terminal:
   `Open https://coolbbs.hub.example/_enig/atproto/login/7F3K in a browser to approve`
4. User approves on their own account host, which redirects to the BBS web
   callback.
5. The callback matches the request to the waiting terminal session and
   completes authentication.
6. BBS binds a persistent credential for the client to the DID (§3.2).

Requirements:

- The BBS serves the OAuth client metadata document (its URL is the
  `client_id`) and the redirect/callback endpoints over HTTPS. These must be
  publicly reachable; a BBS behind a firewall gets this through a tunnel or the
  hub (see [transport.md](transport.md), [hub.md](hub.md)).
- The BBS is a **confidential client** (server-side).
- AT OAuth mandates PKCE, PAR, and DPoP. Use an existing library
  (`@atproto/oauth-client-node` for TypeScript, indigo for Go); do not
  implement the protocol by hand.
- Request only the base **`atproto` scope**. The BBS does not need permission
  to write to users' repos, and should not hold tokens that can post on their
  behalf.

### 3.2 Credential binding (subsequent logins)

After a successful OAuth login, the BBS binds a persistent credential to the
DID so later logins skip the browser. The credential depends on the client:

| Client | Credential |
|---|---|
| Web terminal (browser) | Long-lived session cookie scoped to the BBS's host. Optionally a passkey (WebAuthn) later. |
| Native client | Client-generated keypair; the BBS stores the public key and authenticates with a signed challenge. |
| SSH (optional transport) | The user's SSH public key. |

Rules:

- The BBS stores a `credential → DID` mapping.
- A DID may have multiple credentials; users can list and remove them.
- Removing a credential, banning a DID, or revoking the OAuth grant (§3.4)
  invalidates it.
- Optionally, if the BBS later wants key portability, keys could also be
  published as records in the user's repo (the approach Tangled takes with
  `sh.tangled.publicKey`). That would require a write scope and is out
  of scope for v1.

### 3.3 Transport

Transport is specified in [transport.md](transport.md). In short: HTTPS +
WebSocket is primary, SSH is an optional add-on, and telnet is not supported
for authenticated sessions.

### 3.4 Session revocation

- Users can revoke the BBS's OAuth grant at their account host. Handle refresh
  failures cleanly by asking the user to log in through OAuth again.
- Credential-based logins (§3.2) should periodically re-confirm the account
  still exists and the DID still resolves.

## 4. Attestations

An attestation records that a specific verifier vouched for a specific DID.
Admission is never a single boolean on the user record.

```
attestation:
  id           unique ID
  did          did:plc:abc123
  verifier     verifier ID, e.g. "open", "invite-code", "stripe-card"
  verified_at  timestamp
  expires_at   optional timestamp
  status       active | revoked
  ref          opaque reference owned by the verifier
               (e.g. invite code ID, Stripe customer ID)
```

Rules:

- A DID may have any number of attestations from different verifiers.
- An attestation is **valid** when `status = active` and it has not expired.
- Verifier-specific data (payment details, ID documents, and so on) is stored by
  the verifier plugin, never in the core attestation table. The core table only
  holds the `ref`.

## 5. Access policies

Policies reference attestations (and roles) to decide access.

- **Global login policy:** who may enter the BBS at all.
  - v1: `any_of: [open]` (any authenticated AT user)
  - later, for example: `any_of: [stripe-card, sysop-approval]`
- **Per-area policies:** boards, file areas, doors, etc. can have their own
  requirements.
  - Example: Marketplace requires `stripe-card`; Sysop board requires
    `role:sysop`; all other boards inherit the global policy.
- **Roles** (`sysop`, `co-sysop`, `member`, ...) are stored separately from
  attestations and may also appear in policies.
- **Bans** override all policies and are keyed by DID.

Policy changes:

- When the global policy is raised, the sysop chooses whether existing members
  are **grandfathered** (keep access) or must re-verify.
- Users who lack a required attestation are offered the matching verifiers'
  flows instead of a bare "access denied."
- **Provisional access:** optionally, users who are authenticated but don't
  meet the global policy are admitted with a limited role (`provisional`)
  instead of being refused. They see only areas explicitly opened to that
  role until promoted, manually by the sysop or automatically by rules (e.g.
  account age plus post count).

## 6. Verifier plugin interface

Each verifier is a plugin with the following surface (language-neutral):

| Member | Purpose |
|---|---|
| `id` | Stable identifier stored in attestations |
| `description` | Human-readable text shown to users |
| `start(session)` | Begin verification. May prompt in the terminal or request a browser handoff (§7.1). |
| `handleCallback(request)` | Handle redirects or webhooks routed to this plugin (§7.2). Issues attestations on success. |
| `revoke(attestation)` | Mark an attestation revoked (e.g. chargeback, abuse). |
| `refresh(attestation)` | Optional periodic re-check or renewal (e.g. subscription status). |
| storage | Plugin-private storage for its own data |

Plugins issue and revoke attestations through a core API; they never write
access decisions directly.

## 7. Shared services

These are built in v1 because both AT OAuth and future verifiers need them.

### 7.1 Browser handoff

A generic flow for steps that a terminal can't do:

1. A terminal session requests a handoff and receives a short code and URL.
2. The URL is displayed; the session waits (with timeout and cancel).
3. Completion in the browser resolves the waiting session with a result.

It is used by AT OAuth (§3.1) and by any verifier needing a browser
(payment, ID check).

### 7.2 Callback / webhook router

- One HTTPS endpoint namespace (e.g. `/cb/<verifier-id>/...`). When the BBS
  runs behind the hub, this namespace is on the hub's allowed-endpoint list
  ([hub.md](hub.md) §4).
- Routes inbound redirects and webhooks to the owning plugin's
  `handleCallback`.
- Verifies webhook signatures where the provider supports them.

## 8. Verifiers

| Verifier | Description | Phase |
|---|---|---|
| `open` | Any authenticated AT account | v1 |
| `invite` | Sysop invites a specific handle; the invite is bound to that DID, so there is no secret to leak. Grants the invite's groups on first login. | Early |
| `invite-code` | Sysop-issued single-use or limited-use codes, redeemed on first login | v1 / early |
| `sysop-approval` | New users land in a limited area until the sysop approves them | Early |
| `vouch` | An existing member vouches for a new one | Optional |
| `account-host` | Account must be hosted on a specific server (requires running our own PDS). Check the OAuth issuer on **every** login, since accounts can migrate. | Later, if needed |
| `peer-attested` | Honors attestations issued by a trusted peer BBS, for shared membership in clusters ([networking.md](networking.md) §8) | Later |
| `stripe-card` | Payment method on file via Stripe Checkout | Later |
| `id-check` | Identity verification via a provider (e.g. Stripe Identity) | Later |

`open` and `invite-code` are implemented as real plugins through the same
interface as future verifiers, so the plugin system is in use from day one.

## 9. Security & privacy notes

- **Never store card numbers.** Payment verifiers store only processor
  references (customer IDs), which also keeps the BBS out of PCI-DSS scope.
- A credit card is **weak proof of identity** (prepaid and virtual cards
  exist). It deters casual sock puppets and trolls; use `id-check` where real
  identity matters.
- Bans are keyed by DID. Combined with a payment or ID verifier, a banned
  person who returns under a new account must verify again.
- Optional cosmetic badge: verified members may be given a handle under the
  BBS domain (e.g. `alice.coolbbs.example`). This is for display only; the
  attestation table remains the authority.
- Collect the minimum PII needed; it stays inside the plugin that requires it.

## 10. Open questions

- Attestation expiry defaults per verifier.
- Grandfathering behavior when the global policy changes: per-change
  sysop choice, or a fixed rule?
- Whether passkeys (WebAuthn) are in scope for v1 web-terminal logins.
