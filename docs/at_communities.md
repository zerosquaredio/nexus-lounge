# AT Protocol Communities & Resources

Last updated: 2026-10-29

Where AT Protocol development happens, and where this project might be
hosted, announced, or contribute. URLs are from memory and should be verified
before relying on them.

## Code hosting

| Place | Notes | Plan |
|---|---|---|
| **GitHub** | Where nearly all AT development happens, including Bluesky's own repos (`bluesky-social/atproto`, `bluesky-social/indigo`) | Primary home for the project |
| **Tangled** (tangled.org) | Git hosting built on AT Protocol; sign in with an AT account | Optional mirror; a good thematic fit |

There is no official AT Protocol marketplace or app store.

## Schemas

| Place | Notes | Plan |
|---|---|---|
| **Lexicon Community** (lexicon.community) | Publishes shared Lexicon schemas used across apps, including the calendar-event schema used by Smoke Signal | Reuse its event schema ([publishing.md](publishing.md) §3.2). Later, propose our listing/status records if other projects would benefit. |

## Community and discussion

| Place | Use |
|---|---|
| **atproto GitHub discussions** (`bluesky-social/atproto`) | Protocol questions, specs, bug reports against Bluesky's libraries |
| **AT developer community on Bluesky** | Announcing the project, asking questions, following protocol news |
| **"awesome atproto" lists** (community-maintained on GitHub) | Closest thing to an app directory; submit the project once it's usable |

## Developer references

| Resource | Use for |
|---|---|
| **atproto.com specs** | Lexicon, XRPC, DID, OAuth, service proxying, service auth, sync/firehose |
| **Statusphere tutorial** (atproto.com) | End-to-end example app: OAuth, custom Lexicon, writing records, firehose indexing |
| **`bluesky-social/feed-generator`** | Example standalone service: `did:web` setup and service auth (relevant to the hub directory, [hub.md](hub.md) §5) |
| **Jetstream** | Lightweight JSON firehose for the hub directory |
| **Libraries** | TypeScript: `@atproto/api`, `@atproto/oauth-client-node`, `@atproto/xrpc-server`, `@atproto/lex-cli`. Go: `indigo`. Python: `atproto` (MarshalX). |

## Before going public

- **Register the project domain.** Record type names (NSIDs, currently the
  placeholder `com.yourbbs.*`) must be under a domain the project controls,
  and the hub needs one. Renaming record types after BBSes start publishing
  them is painful.
