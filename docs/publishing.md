# Publishing Spec

Status: Draft
Last updated: 2026-10-29

## 1. Overview

User data never goes into AT repos ([attestation.md](attestation.md) §1).
The exception is the **BBS's own public output** (its directory listing,
announcements, events, and status), which is meant to be public and is
published to AT so Bluesky users, the hub, and any directory can read it.

## 2. The BBS's AT account

- Each BBS has its **own AT account and DID**, separate from the sysop's
  personal account.
  - Keeps the sysop's identity separate from the BBS's public voice.
  - Lets a BBS be handed to a new sysop.
- The account can be **any existing AT account**, including an ordinary
  `bsky.social` account. Account servers accept record types they don't
  recognize, so the project's custom records (§3) can be stored there; the
  Bluesky app ignores them and the hub picks them up from the firehose.
- When registered with the hub, the account may use a hub-issued handle such
  as `@coolbbs.hub.example` ([hub.md](hub.md) §2).
- The BBS writes to this account directly over outbound HTTPS, never through
  the hub ([hub.md](hub.md) §1.1).
- In ENiGMA½, a publishing module holds this session, and the event scheduler
  drives listing and status updates
  ([enigma_integration.md](enigma_integration.md) §7).
- The BBS server holds this account's OAuth session.
  - Unlike user logins (identity scope only), this session needs **write**
    access to the BBS's own repo.
  - Request only the permissions needed: Bluesky posts and the project's
    record types (exact scope strings per the AT OAuth permissions spec).

## 3. Record types

Record types use the NSID root **`io.zerosquared.bbs`**, under the
project-controlled domain `zerosquared.io` (authority `bbs.zerosquared.io`).
The root is deliberately independent of the project name (Nexus Lounge), so a
rename doesn't affect published records. Final Lexicon schemas will live in a
`lexicons/` directory; the fields below are drafts. When the schemas are
published, a DNS TXT record on `bbs.zerosquared.io` will point to where they
are hosted, per AT's Lexicon resolution rules (to be confirmed at that time).

### 3.1 Listing: `io.zerosquared.bbs.listing`

One record per BBS (record key `self`), in the BBS's repo.

| Field | Type | Notes |
|---|---|---|
| `name` | string | Display name |
| `description` | string | Short description |
| `url` | string (URI) | Public address, e.g. `https://coolbbs.hub.example` |
| `tags` | string[] | Optional topics |
| `admission` | string | Summary of the global login policy, e.g. `open`, `invite`, `verified` |
| `sysop` | DID | Optional; the sysop's personal DID, if they choose to disclose it |
| `createdAt` | datetime | |

Reserved for later: a P2P node key ([transport.md](transport.md) §6).

### 3.2 Events

Use the community calendar-event Lexicon used by Smoke Signal (believed to
be published by the Lexicon Community project; to be confirmed) rather than
defining our own. Events then appear in existing event apps as well as the
hub directory.

### 3.3 Status

Status comes from two sources:

| Kind | Record | Published by | Purpose |
|---|---|---|---|
| **Declared** | `io.zerosquared.bbs.status` in the BBS's repo | BBS / sysop tools | Planned maintenance, notices |
| **Observed** | `io.zerosquared.bbs.observedStatus` in the hub's repo | Hub | Tunnel connected or disconnected |

The split exists because a crashed BBS can't post its own outage. Status
records live on the account host, not the BBS machine, so they remain readable
while the BBS is offline.

`io.zerosquared.bbs.status` (record key `self`, overwritten on change):

| Field | Type | Notes |
|---|---|---|
| `state` | string | `up`, `maintenance`, `degraded`, `down` |
| `message` | string | Optional human-readable notice |
| `until` | datetime | Optional expected end |
| `updatedAt` | datetime | |

`io.zerosquared.bbs.observedStatus` (in the hub's repo, one record per BBS):

| Field | Type | Notes |
|---|---|---|
| `subject` | DID | The BBS's DID |
| `connected` | boolean | Tunnel state |
| `since` | datetime | When the state last changed |

### 3.4 Announcements and advertisements

Standard Bluesky posts (`app.bsky.feed.post`) from the BBS account, reaching
anyone who follows it.

## 4. Board bridging (optional)

A sysop may mark specific boards as **public, bridged** boards, whose posts
are mirrored to Bluesky from the BBS account.

- Opt-in per board, and the board's description must clearly say it is
  public.
- Only posts made on a bridged board are mirrored; nothing else crosses over.

## 5. Guidelines

- **Everything published is public and effectively permanent.** Deletes are
  honored by well-behaved indexers, but copies may persist.
- **Never publish member data or activity** without explicit consent
  (e.g. no "Bob just logged in" posts).
- **Make automated posts identifiable.** Mark the BBS account as automated,
  rate-limit posting, and keep volume low; spammy bot accounts are treated
  harshly by Bluesky users and moderation services.

## 6. Open questions

- Whether BBS accounts should be created by the hub (hub-hosted PDS) or
  brought by the sysop.
- Exact OAuth permission scopes for the BBS account.
