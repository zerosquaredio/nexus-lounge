# Publishing Spec

Status: Draft
Last updated: 2026-11-04

## 1. Overview

User data never goes into AT repos ([attestation.md](attestation.md) §1).
The exception is the **BBS's own public output** (its directory listing,
announcements, events, and status), which is meant to be public and is
published to AT so Bluesky users, the hub, and any directory can read it.

## 2. The BBS's AT account

- Each BBS has its **own AT account and DID**, separate from the sysop's
  personal account. This applies to every kind of leaf, not only BBSes
  ([Cyberspace Framework vision](https://github.com/zerosquaredio/cyberspace-framework/blob/main/docs/vision.md) §6.1).
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

Record types use the Cyberspace Framework's NSID root **`nexus.cyberspace`**,
under the project domain `cyberspace.nexus`, grouped by role: `leaf.*` for
records in a BBS's (or other leaf's) repo, `hub.*` for records in a hub's
repo ([vision](https://github.com/zerosquaredio/cyberspace-framework/blob/main/docs/vision.md) §2.2).
The root is deliberately independent of the project name (Nexus Lounge), so a
rename doesn't affect published records. Final Lexicon schemas will live in
the cyberspace-framework repo's `lexicons/` directory; the fields below are
drafts. When the schemas are published, DNS TXT records at
`_lexicon.leaf.cyberspace.nexus` and `_lexicon.hub.cyberspace.nexus` will
name the DID of the project account that holds them, per AT's Lexicon
resolution rules (to be confirmed against the current spec at that time).

**Names and fields are permanent once published** (§3.8), so the drafts below
must be reviewed before anything is published under them.

### 3.1 Listing: `nexus.cyberspace.leaf.listing`

One record per BBS (record key `self`), in the BBS's repo.

| Field | Type | Notes |
|---|---|---|
| `name` | string | Display name |
| `description` | string | Short description |
| `endpoints` | object[] | Ways to connect, each `{ protocol, uri }`; protocol is an open list (`web`, `ssh`, `telnet`, …), e.g. `https://coolbbs.hub.example`, `ssh://bbs.example:8889` |
| `tags` | string[] | Optional topics |
| `rules` | string | Optional; the BBS's rules, as plain text |
| `admission` | object | `policy`: open list of values (`open`, `invite`, `inviteCode`, `sysopApproval`, `verified`, …) a directory can filter on; `howToJoin`: plain-text explanation |
| `banner` | ANSI art (§3.7) | Optional |
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
| **Declared** | `nexus.cyberspace.leaf.status` in the BBS's repo | BBS / sysop tools | Planned maintenance, notices |
| **Observed** | `nexus.cyberspace.hub.observedStatus` in the hub's repo | Hub | Tunnel connected or disconnected |

The split exists because a crashed BBS can't post its own outage. Status
records live on the account host, not the BBS machine, so they remain readable
while the BBS is offline.

`nexus.cyberspace.leaf.status` (record key `self`, overwritten on change):

| Field | Type | Notes |
|---|---|---|
| `state` | string | Open list: `up`, `maintenance`, `degraded`, `down` |
| `message` | string | Optional human-readable notice |
| `until` | datetime | Optional expected end |
| `updatedAt` | datetime | |

`nexus.cyberspace.hub.observedStatus` (in the hub's repo, one record per BBS):

| Field | Type | Notes |
|---|---|---|
| `subject` | DID | The BBS's DID |
| `connected` | boolean | Tunnel state |
| `since` | datetime | When the state last changed |

### 3.4 Announcements

Standard Bluesky posts (`app.bsky.feed.post`) from the BBS account, reaching
anyone who follows it. Posts can be written by the sysop or triggered by
events (§5). The hub shows a BBS's recent posts on its directory page
([hub.md](hub.md) §5).

### 3.5 Stats: `nexus.cyberspace.leaf.stats`

**Every public stat is off by default**; the sysop turns on each one
individually. With none enabled, no stats record is published.

One record per BBS (record key `self`), overwritten periodically (e.g. every
15 to 60 minutes, not on every change). Totals only, never per-member data:

| Field | Type | Notes |
|---|---|---|
| `members` | integer | Optional |
| `messages` | integer | Optional |
| `files` | integer | Optional |
| `doors` | integer | Optional |
| `onlineNow` | integer | Optional. On a small board this can reveal who is on, so the setting's description should say so |
| `updatedAt` | datetime | |

Live counts for a hub-connected BBS could instead go to the hub over the
tunnel ([hub.md](hub.md) §5).

### 3.6 Advertisements: `nexus.cyberspace.leaf.ad`

Ads the hub rotates on its directory and front door, kept separate from posts
so the hub can control rotation, fairness between BBSes, and expiry.

| Field | Type | Notes |
|---|---|---|
| `text` | string | Plain-text version; always present |
| `art` | ANSI art (§3.7) | Optional |
| `expiresAt` | datetime | Optional; the hub stops showing it after this |
| `createdAt` | datetime | |

A sysop can also advertise with ordinary posts (§3.4).

### 3.7 ANSI art

ANSI art is supported wherever the project shows BBS content: listing
banners, ads, the hub's directory and front door, and status pages.

- Stored as a blob (the original bytes, CP437 and SAUCE metadata included)
  referenced from the record, alongside a **plain-text fallback** for readers
  that can't display it. Blob size and type limits on account servers are to
  be confirmed.
- The hub displays it with the same renderer as its web terminal.
- Bluesky posts can't display ANSI art, so a post (§3.4, §5) attaches it as
  an image rendered by the BBS, with the plain-text fallback as alt text:
  - Rendered with the IBM PC 8×16 VGA font (an 80×25 screen becomes
    640×400), honoring iCE colors and SAUCE width and font hints. Candidate
    renderer: ansilove (C library and command-line tool; a JavaScript port
    may exist, to be evaluated).
  - Bluesky allows up to 4 images per post, about 1 MB each. Tall art is
    cropped to its first screen with a link to the full piece, or split
    across up to 4 images.
  - Animated ANSI (cursor movement and timing) is posted as its final frame.
    A GIF or video version may come later.
  - The artist and group from SAUCE metadata are credited in the post.
- Designs should fit 80 columns.

### 3.8 Naming and changes

- AT's schema rules allow only compatible changes after publication: optional
  fields can be added, but fields can't be removed, renamed, change type, or
  become required. A breaking change needs a new name (e.g. `listingV2`).
- Value lists such as `state` and `admission.policy` are open lists of known
  values, not closed enums, so new values can be added later.
- The schemas are published from a long-lived project account (a `did:plc`
  with a recovery key the project holds), and `cyberspace.nexus` must stay
  registered for as long as the records matter.
- **During development, nothing is published under the final names.** Test
  records use the prefix `nexus.cyberspace.dev.*` or throwaway accounts, so
  the real names are first used once the shapes are final.

## 4. Board bridging (optional)

A sysop may mark specific boards as **public, bridged** boards, whose posts
are mirrored to Bluesky from the BBS account.

- Opt-in per board, and the board's description must clearly say it is
  public.
- Only posts made on a bridged board are mirrored; nothing else crosses over.

## 5. Triggered posts

Events can trigger Bluesky posts (and, where useful, records) from the BBS
account. Two sources:

- **Calendar events** (§3.2): announcing a new event, and reminders before it
  starts, sent by ENiGMA½'s event scheduler.
- **ENiGMA½ system events** (`core/system_events.js`): a publishing module
  listens for chosen events. The event scheduler also covers scheduled
  advertisements and posting when a file changes.

Every trigger is **off by default** and configured by the sysop with: the
event it listens for, a message template (optionally with ANSI art, §3.7), a
rate limit or batching ("3 new files this week" rather than one post per
upload), and whether the member's opt-in is required.

| Kind | Examples | Rule |
|---|---|---|
| **BBS events** | Calendar events and reminders; new board, door, or file area; status changes; scheduled ads; sysop announcements | May be posted |
| **Member events** | Achievements, high scores, a file the member wants promoted | Only with that member's opt-in, stored on the BBS; the member also chooses whether their handle appears |
| **Never posted** | Logins and logoffs, new users by name, private mail, node messages | Not available as triggers |

## 6. Guidelines

- **Everything published is public and effectively permanent.** Deletes are
  honored by well-behaved indexers, but copies may persist.
- **Never publish member data or activity** without explicit consent
  (e.g. no "Bob just logged in" posts).
- **Make automated posts identifiable.** Mark the BBS account as automated,
  rate-limit posting, and keep volume low; spammy bot accounts are treated
  harshly by Bluesky users and moderation services.

## 7. Open questions

- ~~Whether BBS accounts should be created by the hub (hub-hosted PDS) or
  brought by the sysop.~~ The sysop's choice; either way the DID is a
  `did:plc` whose rotation key the sysop holds
  ([Cyberspace Framework vision](https://github.com/zerosquaredio/cyberspace-framework/blob/main/docs/vision.md) §6.1, proposed
  2026-11-06).
- Exact OAuth permission scopes for the BBS account. They name the record
  types (now decided), so they can be written out with F9.
- ~~Name structure: flat or grouped by area.~~ Grouped by role
  (`nexus.cyberspace.leaf.*`, `.hub.*`); each group has its own `_lexicon`
  DNS record (decided 2026-11-06).
- Record key for `observedStatus`: the BBS's DID, or a generated key with the
  DID in `subject`.
- Confirm the community calendar-event schema (believed to be
  `community.lexicon.calendar.event`) and that it is stable.
- Stats: a periodic record (§3.5), live counts over the tunnel, or both.
- ~~Who holds the project domain if the project is handed to a
  community.~~ The names use `cyberspace.nexus`, registered for the
  framework rather than a personal domain, so it can be transferred. The
  project account goes with it.
