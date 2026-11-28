# Final Record Names

Status: Draft, for decisions (2026-11-27)
Last updated: 2026-11-27

Everything the framework publishes today is named `nexus.cyberspace.dev.*`,
from one setting on each side (`atProto.publishing.nsidPrefix` in the fork,
`directory.nsidPrefix` in the hub). The final names are permanent once used
([publishing.md](publishing.md) §3.8). This spec settles them, and the
permissions boards ask for, before any board outside the project publishes:
it is item 5 of the hub plan's list before public launch
([hub_development_plan.md](hub_development_plan.md) §5.2).

Now is the cheapest time. Every board publishing is ours (test and test2),
so switching costs one reconnect each and nothing else. Every new record
type adds to that cost later: live objects just added one.

## 1. What there is now

| Record | Today's name | Published by | In use since |
|---|---|---|---|
| Listing | `nexus.cyberspace.dev.leaf.listing` | a board | F9 |
| Declared status | `nexus.cyberspace.dev.leaf.status` | a board | F9 |
| Observed status | `nexus.cyberspace.dev.hub.observedStatus` | the hub | H6 |
| Asset | `nexus.cyberspace.dev.asset.item` | a board, the hub | F21, H20 |
| Catalogue | `nexus.cyberspace.dev.asset.catalogue` | a board, the hub | F21 |
| View | `nexus.cyberspace.dev.asset.view` | (asked for; none yet) | F21 |
| Live object | `nexus.cyberspace.dev.object` | a board | the live object slice |

The live model's messages also use the prefix as their `$type`
(`nexus.cyberspace.dev.space.*`). They are not records in anyone's repo,
only what the hub sends its pages and doors, so they can change name
whenever the hub and the fork do.

A board's account is asked for each record type by name (`repo:` and the
type), plus `repo:app.bsky.feed.post` and `blob:` for its files. Every new
type has meant every board connecting again: the art did, and live objects
did.

## 2. What AT Protocol gives us

Checked against the specs on 2026-11-27:

- **Lexicon resolution** ([Lexicon spec](https://atproto.com/specs/lexicon),
  [Publishing Lexicons](https://atproto.com/guides/publishing-lexicons)).
  A name's authority is the name without its last part, reversed into a
  domain: `nexus.cyberspace.leaf.listing` is `leaf.cyberspace.nexus`. A
  DNS TXT record there, `_lexicon.leaf.cyberspace.nexus` with
  `did=did:plc:…`, names the account whose repo holds the schema, as a
  `com.atproto.lexicon.schema` record keyed by the name. Resolution
  doesn't walk up or down the domain, so **each group needs its own TXT
  record**.
- **Permission sets** ([Permissions spec](https://atproto.com/specs/permission),
  [Permission Requests](https://atproto.com/guides/permission-requests)).
  A permission set is itself a Lexicon (type `permission-set`), asked for
  as one scope, `include:nexus.cyberspace.authBoard`. It may name record
  types in its own group and every group below it, so a set named
  `nexus.cyberspace.authBoard` covers `nexus.cyberspace.leaf.*`,
  `.asset.*`, any other group under `nexus.cyberspace`, and the
  `nexus.cyberspace.dev.*` drafts. It may not name `app.bsky.feed.post`
  (another group), `blob:`, account or identity permissions; those are
  still asked for beside it. **When the set changes, sessions pick up the
  change as their tokens refresh, without the person approving again**
  ("Client software can then be updated to take advantage of those new
  lexicons, without requiring users to re-authenticate their sessions").
  Only a new scope outside the set needs a reconnect. The `auth` at the
  front of the name is a convention for sets, not a rule. Authorization
  servers cache a set for at most 24 hours.

The specs don't say whether Bluesky's hosts honour `include:` today. Bluesky
publishes its own sets (`app.bsky.authFullApp`), which suggests they do, but
it must be tried (stage 0).

## 3. Decisions

### Decision 1: the names

Keep the root, `nexus.cyberspace`, and the groups the specs already use,
and give live objects a group of their own:

| Record | Final name |
|---|---|
| Listing | `nexus.cyberspace.leaf.listing` |
| Declared status | `nexus.cyberspace.leaf.status` |
| Observed status | `nexus.cyberspace.hub.observedStatus` |
| Asset | `nexus.cyberspace.asset.item` |
| Catalogue | `nexus.cyberspace.asset.catalogue` |
| View | `nexus.cyberspace.asset.view` |
| Live object | `nexus.cyberspace.world.object` |
| Permission sets | `nexus.cyberspace.authBoard`, `nexus.cyberspace.authHub` |

- **Objects get a `world` group** in place of today's bare `.object`, with
  room for what the compute spec has coming: zones (`world.zone`) and
  places' rules (compute §4.4, §11). A bare `nexus.cyberspace.object` would
  sit in the root's group with the permission sets, and every later world
  record would have to sit there too.
- **`actor.*` stays reserved** for a person's own records (`actor.looks`,
  assets spec §3.4). Nothing uses it yet, so it isn't made final now.
- **The live model's messages** become `nexus.cyberspace.space.*`, with no
  Lexicon published for them yet.

*Recommended.* The alternative is fewer groups (everything flat under
`nexus.cyberspace`). That needs one TXT record, not five, but the specs
already chose groups by role (publishing.md §7), and groups keep each
area's schemas apart.

### Decision 2: one permission set for boards, one for the hub

A board asks for:

```
atproto include:nexus.cyberspace.authBoard repo:app.bsky.feed.post blob:*/*
```

with `authBoard` naming `leaf.listing`, `leaf.status`, `asset.item`,
`asset.catalogue`, `asset.view` and `world.object`. `blob:*/*` is what the
board asks for today; a set can't carry it, and listing each kind of file
would mean a reconnect for every new one. The hub's account asks for
`include:nexus.cyberspace.authHub`, naming `hub.observedStatus`.

Then **a new record type is added to the set, not to every board's
request**: boards gain it within a day (as their tokens refresh and the
set's cache expires), and nobody connects again. Drafts can go in the set
too, as `nexus.cyberspace.dev.*`, while their shapes settle.

The set's title and detail are what a sysop sees when approving, so they
are written for them: "Publish this BBS to Cyberspace hubs: its listing,
status, art, models and live objects."

*Recommended, if stage 0 shows it works.* If Bluesky's hosts don't honour
`include:` yet, boards ask for the final names one by one, as today, and
switch to the set when hosts do (one more reconnect then).

Still open from the development plan (§6): an `rpc:` permission for a board
proving itself to a hub or a peer. It can join the set later without a
reconnect, if it's one a set can carry.

### Decision 3: the project account

The schemas live in a **project account**, a `did:plc` made for this and
nothing else, not the hub's account or anyone's own. Its recovery key is
held by the project. The publishing spec already plans it (§3.8): whoever
holds `cyberspace.nexus` holds this account too, so both can be handed on
together.

Making it is yours: an account on Bluesky's host (or any), with a handle
such as `lexicons.cyberspace.nexus`, and a recovery key added to its DID
(the hub's own account was made the same way). Five DNS TXT records then
name its DID, one for each group: `_lexicon.cyberspace.nexus` (the
permission sets), `_lexicon.leaf.cyberspace.nexus`,
`_lexicon.hub.cyberspace.nexus`, `_lexicon.asset.cyberspace.nexus`,
`_lexicon.world.cyberspace.nexus`. Stage 0 needs only one more,
`_lexicon.dev.cyberspace.nexus`.

### Decision 4: switch outright

The test boards delete their `dev` records and publish under the final
names; the hub reads only the final names. No period of following both,
since no board outside the project has published.

The prefix setting stays, for development: a hub and board on `dev` names
can try a change without touching the final ones. New record types start
as `nexus.cyberspace.dev.*` drafts and move to their final names when
their shapes are settled, each type by its own name. So the single
`nsidPrefix` gives way to a table of names in each code base (the fork's
`core/atproto/const.js`, a module of the hub's), with the prefix applied to
the drafts and to everything on a development setup.

*Recommended.* The alternative, outside boards on the `dev` names with a
migration later and hubs reading both for a while, only makes sense if
outside boards must publish before the shapes can be reviewed.

### Decision 5: the shapes are reviewed first

Names can't be taken back, and neither can fields: after publishing, only
optional fields can be added (publishing.md §3.8). So before stage 3, each
record's fields are written as a Lexicon and compared with what the fork
and the hub really publish and read today. These are the points known now:

- **Listing:** the spec's `banner` (ANSI art in the record) was never
  built; the hub shows a board's splash and emblem, which are assets. Drop
  it, or leave it out until it's built.
- **Asset:** add `program` to `kind`'s known values, and the program's
  `manifest` (fetch, values, credit) as an optional field. Keep the
  record key, the SHA-256 of the first version's file.
- **Live object:** `program` is `{ sha256, uri }`, not AT's usual strong
  reference (`{ uri, cid }`). Keep the hash: it names the module itself,
  whoever publishes it, which is what a hub vets. Add `cid` as optional.
  `look` is the string `badge` today; make it an object
  (`{ kind: "badge" }`) so looks can grow fields (compute §5.4).
- **Everywhere:** lists of words (`kind`, `state`, `admission.policy`,
  `rating`, `form`) become `knownValues`, so new words can be added;
  strings get `maxGraphemes` limits that match what the hub and fork
  already enforce; `createdAt` is a `datetime`.

The Lexicons live in the vision repo's `lexicons/` directory, as the
publishing spec planned, and are checked with AT's own Lexicon tools as a
development step only (no new dependency in the fork or the hub).

## 4. Stages

0. **Does a permission set work?** (Your part: the project account and
   `_lexicon.dev.cyberspace.nexus`.) Publish
   `nexus.cyberspace.dev.authBoard`, naming today's `dev` types; point
   test2's board at it; connect test2 again; publish. Then add a type to
   the set and see test2 gain it without connecting again, within the
   cache's day. Record the result in [trials.md](trials.md).
1. **The Lexicons:** every record's schema and the two permission sets,
   written and checked, with the review points of decision 5 settled.
2. **The code:** the table of names in the fork and the hub; boards ask
   for the set (or the names one by one, if stage 0 failed); the hub reads
   and writes the final names. Tests on both sides.
3. **The switch:** the schemas published to the project account, the five
   TXT records added (yours), the hub deployed, test and test2 on the new
   image, each connected again once; their `dev` records deleted, and the
   hub's own `dev` records with them.
4. **The docs:** the publishing spec, the assets spec and the compute spec
   name the final names; the joining guide shows the sysop's approval
   screen.

## 5. Open questions

- Whether hosts other than Bluesky's honour permission sets. A board on
  another host that doesn't may need the names one by one.
- Whether calendar events use the community's schema
  (`community.lexicon.calendar.event`) as publishing.md §3.2 plans. Not
  needed for this switch: no board publishes events yet.
