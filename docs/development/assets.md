# Assets Spec

Status: Draft
Last updated: 2026-11-26

How leaves (BBSes today), their members and other users make art and
models available to a hub and to each other; how the hub finds, checks,
caches and serves them; who may use, copy and remix them; and how people
stay recognizable when anything can be copied.

It is the concrete side of the framework's design for assets:
[One World at Every Level](https://github.com/zerosquaredio/cyberspace-framework/blob/main/docs/world.md)
(§6 assets, §7 the baker, §8 cohesion) and the
[vision](https://github.com/zerosquaredio/cyberspace-framework/blob/main/docs/vision.md)
(§7 assets and avatars, §8.8 licences). Those say what assets are and how
they scale between levels; this says how they move.

## 1. Overview

- **Files are named by their content.** Every file is identified by the
  SHA-256 hash of its bytes; where it is stored is only a hint. So the hub
  can check any copy, cache it, keep it while its source is offline, and
  block it for good.
- **Public assets are AT records** in their publisher's own repo (a
  leaf's or a user's), signed by that account (§3).
- **Assets a leaf hosts for its members are not records.** The leaf tells
  the hub about them privately, with the presence it already reports, so
  nothing public says which leaves a person uses (§5).
- **The hub fetches only what is used,** checks it once per hash, caches
  it and serves it (§6). Clients never fetch from people's PDSes.
- **Remixing is encouraged.** Copying and changing others' assets is the
  normal way to make things, with credit carried automatically. Authors'
  permissions are enforced by the hub's own tools as far as they can be;
  beyond that, protection is social (§7).
- **Identity comes from sign-in, not appearance** (§8).

## 2. Kinds of file

What a file is decides how the hub checks it (§6.2). An asset (§3) has one
or more **versions**, each one file:

| Form | Formats | For |
|---|---|---|
| `ansi` | ANSI art (CP437, with SAUCE) | The text level; emblems, banners, signs, portraits everywhere (world.md §6.2) |
| `text` | Plain UTF-8 | The text of ANSI art without its colours: for screen readers and anything that can't show colour (publishing spec §3.7) |
| `icon` | PNG, WebP | Small, square: the map, lists, nameplates |
| `image` | PNG, WebP, JPEG | Emblems, backgrounds, textures, patterns |
| `panorama` | PNG, WebP, JPEG (equirectangular) | Backgrounds on the map, skies in 3D |
| `sprite` | A PNG sheet plus its frame data (Aseprite's JSON export) | Animated 2D, the Doom-style level |
| `model` | glTF binary (`.glb`); VRM for humanoid avatars | 3D, at a budget class: `light`, `standard`, `full`. A model may declare **settings** a program can drive (a part's pose, a colour, a label), for live objects ([compute spec](compute.md) §5) |
| `program` | WebAssembly, with a manifest of what it needs | An object's backend, or a model's motion program: placed and run as the [compute spec](compute.md) says; never a viewer's page code |
| `voxel` | MagicaVoxel `.vox` | The grid style (world.md §8.1); later |
| `splat` | `.spz`, `.ply` | Backdrops only; later |

An asset may have several versions of one form at different sizes, such as
a full-size and a half-size `image`; a client takes the size it needs.

Every asset also has a **description** (text, in the record), its text
version (world.md §4), used for `look` and by screen readers.

Animations inside sprites and models are named by the shared **states and
events** (`idle`, `talking`, `waves`, …; world.md §6.3), so every version
responds to the same names. The names follow VRM's expression names where
they overlap.

## 3. Records

Record types for assets form a new group, **`nexus.cyberspace.asset.*`**,
usable in any repo (a leaf's or a user's), since the same asset record
suits both. This extends the vision's naming (§2.2), which groups records
by whose repo they live in; assets are the first records that may live in
anyone's. A person's own choices of look are `nexus.cyberspace.actor.*`,
as the vision already reserves.

During development the names are `nexus.cyberspace.dev.asset.*` and
`nexus.cyberspace.dev.actor.*`, per the [publishing spec](publishing.md)
§3.8. Fields below are drafts. Where at3d.app's record types for avatars
fit ([hub spec](hub.md) §5.3), follow or help shape them rather than
duplicating them.

### 3.1 Asset: `nexus.cyberspace.asset.item`

One record per asset (record key: a TID).

| Field | Type | Notes |
|---|---|---|
| `name` | string | Short display name |
| `description` | object | `short` (one line, shown on arrival or hover), `long` (for `look`); plain text, length-limited |
| `kind` | string | Open list: `avatar`, `emblem`, `object`, `environment`, `art`, `theme`, `style` |
| `role` | string | Optional: the role this is a form of (`person`, `entrance`, `exit`, `seat`, `screen`, `sign`, `light`, …; world.md §6.4) |
| `themes` | string[] | Optional free tags (`cyberpunk`, `fantasy`, …), as listings have (hub spec §5.4) |
| `versions` | object[] | One per file (§3.2) |
| `rating` | string | `general`, `mature` or `adult`; also an AT self-label, as listings carry it (hub spec §5.4) |
| `licence` | object | `id`: an SPDX identifier (`CC-BY-4.0`, `CC0-1.0`, …) or `custom`; `url`; `text` for custom terms |
| `permissions` | object | Who may use, copy, restyle, remix and share it (§7.1) |
| `credit` | object | Optional: `author`, `group`, `note`; for ANSI, filled from SAUCE |
| `source` | strongRef | Optional: the asset this one was derived from (record URI and CID) |
| `change` | string | Optional: what was changed from the source ("blue theme", "metal skin", "simplified for 3D Light") |
| `createdAt` | datetime | |

### 3.2 Versions

| Field | Type | Notes |
|---|---|---|
| `form` | string | §2: `ansi`, `icon`, `image`, `panorama`, `sprite`, `model`, … |
| `class` | string | Models only: `light`, `standard` or `full` (world.md §2.2) |
| `file` | object | Either `blob` (an AT blob in this repo) or `{ url, sha256, size, mediaType }` (§4.2) |
| `data` | object | Optional second file, the same way: a sprite sheet's frame data |
| `budget` | object | Measured, for models and sprites: `triangles`, `textureBytes`, `drawCalls`, `bones`, `frames` |
| `size` | object | Pixels or characters: `width`, `height` |
| `made` | string | `hand` or `derived` (by the baker; then `tool`, its name and version) |

### 3.3 Catalogue: `nexus.cyberspace.asset.catalogue`

A publisher's library: a name, a description, and a list of asset records
(strongRefs), with optional sections. A leaf's catalogue is what its
members and visitors browse (world.md §6.5). A catalogue doesn't grant
anything; each asset's own permissions apply.

### 3.4 A person's looks: `nexus.cyberspace.actor.looks`

One record (record key `self`) in a person's repo:

| Field | Type | Notes |
|---|---|---|
| `default` | strongRef | The asset they appear as wherever nothing else is chosen (vision §7.2, step 3) |
| `signature` | strongRef[] | Their **signature looks**: "this is how people know me" (§8.2) |

Which look a person uses on a given leaf or hub is **not** published: it is
kept by that leaf or hub (vision §7.2).

### 3.5 Versions of the format

**The format is this spec's, not any tool's.** The baker is one tool that
writes it; another tool, or an older or newer baker, may write it too, and
a hub takes them all alike. A derived version's `tool` names what made it,
for credit and for tracing faults, never to decide whether it is accepted.

- **Files are standard formats** (PNG, ANSI, glTF, VRM). A hub checks them
  against this spec's rules (clean ANSI, §6.2, is a rule about the file,
  not "what our writer would write"), never against one tool's exact
  output.
- **Records follow AT's schema rules** ([publishing spec](publishing.md)
  §3.8): fields are only ever added, so a field a hub doesn't know is
  ignored. A change that can't be made that way takes a new record type
  name, and hubs accept both the old and the new for a changeover period.
- **Lists are open:** forms, kinds, roles, states and events. A version of a
  form a hub doesn't serve yet is passed over, and the item is shown with
  the versions it has. An event a model has animations for but a hub
  doesn't send never plays; an event a hub sends that a model doesn't cover
  shows its idle state, or its role's default (world.md §6.3, §6.4).
  Mismatches cost detail, not breakage.
- **The floor:** every asset has an `image` and a description (and ANSI art
  its `ansi`), which every hub can show. Raising the floor is the one change
  that would ask publishers to add something, and is done rarely, with
  notice.
- **Derived versions are a cache.** The hand-made version is the asset; a
  hub with newer tools may make the derived ones again from it (an icon,
  a sprite sheet, a lighter model), which is showing it, not remixing it
  (§7.1). A leaf never has to re-bake for a hub.

### 3.6 Views: `nexus.cyberspace.asset.view`

A **view** is how a person sees the hub: its pages' colours and fonts, and
how art and objects are drawn (pictures, ANSI or text: world.md's levels, on
a web page). Views are assets: a leaf publishes its own, the hub has some
of its own, and each person picks one from a menu listing them all, each
credited ("CoolBBS's view"). With several leaves connected, their views are
all there to choose from.

**A view is data, not CSS.** A leaf's stylesheet on the hub's pages could
cover or fake controls on pages that handle sign-in and tokens, signal
what's on a page through clever selectors, or make pages unreadable. So a
view carries values, and the hub builds the CSS from them:

| Field | Type | Notes |
|---|---|---|
| `name` | string | Shown in the menu |
| `colours` | object | Values for the slots the hub's pages are built on: `bg`, `fg`, `dim`, `line`, `accent`, `warn`, each `#rrggbb`. Absent: the hub's own, light or dark as the device prefers |
| `fonts` | object | `body` and `heading`: each a font asset (a WOFF file, checked and licensed like any asset), or one the hub has |
| `art` | string | How art is drawn unless the person chooses otherwise: `pictures`, `ansi` or `text` |
| `ansi` | string[16] | Optional colours for ANSI art drawn as characters, in ANSI order. Art is recoloured as it's drawn, in each viewer's browser, and never copied, so this is showing art, not remixing it (§7.1) |
| `frame` | strongRef | Optional ANSI art for the page's header, later |
| `credit`, `licence`, `rating` | | As for any asset (§3.1) |

The hub's rules for views:

- **Contrast:** text colours (`fg`, `dim`, `accent`, `warn`) must reach
  WCAG's contrast ratio of 4.5 against `bg`. A view that doesn't is refused.
- **Plain where it matters:** pages where people sign in, see tokens or
  report abuse are drawn only in the hub's own views (which apply on every
  page), never in a leaf's or a person's view, so nothing on them can be
  mistaken.
- **The viewer has the last say:** a person's own settings (high contrast,
  larger text, the plain hub look) win over any view (world.md §8's
  cascade).
- **Where a view applies:** the one a person chooses applies everywhere on
  the hub. Later a leaf's own pages on the hub (its directory entry, its
  zone of the space) may show in the leaf's view by default.

The hub's first views are its own: **Hub** (its usual look), **BBS**
(black, the IBM VGA font, ANSI art) and **Pink and white** (recolouring
ANSI art as it's drawn), chosen from a menu in every page's header and kept
in a cookie, so they work on pages without scripts (hub plan H20).

## 4. Publishing

### 4.1 Where files go

| Where | For | Notes |
|---|---|---|
| **A blob in the publisher's repo** | Small files: ANSI, icons, sprites, small models | The default. AT addresses blobs by hash already. Each PDS sets its own size limit (`describeServer`'s `blobUploadLimit`), and whether every PDS accepts every media type (ANSI's especially) is to be checked |
| **The leaf's web server, through its tunnel** | Large files from a leaf | At `/assets/...` on the leaf's web address, which the hub already allows (hub spec §4). Simple, but tunnel traffic crosses the hub too |
| **A direct source** | Large files, heavy use | The leaf's own public address, any HTTPS host or a CDN: the "better with effort" option (vision §1), which spares the hub's bandwidth (§6.4) |
| **The hub** | | Not for now: holding uploads would make the hub a host (§10) |

### 4.2 Files outside the repo

A version whose file is not a blob gives `{ url, sha256, size, mediaType }`.
Whoever fetches it (the hub, or a client from a direct source) checks the
hash and refuses a mismatch. The URL may change by republishing the record;
the hash may not, without making a new version.

### 4.3 A leaf

The fork (ENiGMA½) already publishes its listing with the BBS's own AT
account (publishing spec §2). It gains:

- an `assets` section in its config: each asset's files, description,
  rating, licence, permissions and credit (SAUCE fills credit in for ANSI);
- publishing them the way it publishes the listing: blobs uploaded, records
  written, changed records updated, removed ones deleted;
- a listing field, **`emblem`**: the small logo that stands for the BBS on
  the hub's map. The sysop names it (`atProto.publishing.emblem.art`), which
  is their consent to offering it; there is none by default. Named and
  served like the splash below, and baked by the hub the same way (a
  strongRef to an asset record later, once boards publish those);
- a listing field, **`splash`**: its splash screen, the screen it greets
  callers with, which the hub shows on its directory and the BBS's page.
  With the sysop's consent, given once at setup, the fork offers by
  default the art its login menu shows. It names the raw file (its hash,
  size and credit), served at `/assets/<sha256>`, and the hub bakes it as
  it fetches it: menu codes blanked (as the baker's `--mci` does), so no
  live data is shown, then cleaned and drawn like any art (development plan
  F21). Until boards offer one, a hub's admin can choose it from the hub's
  own art (hub plan H20);
- large files served by its web server under `/assets/<sha256>`;
- an `oputil` command to publish an art pack in one go, as a catalogue.

### 4.4 A user

- **The baker** (world.md §7) publishes directly to the person's repo,
  signed in as them.
- **A page on the hub** ("Your assets"), later. The hub signs people in
  with the identity-only `atproto` scope (H13); this page asks, only when
  first used, for permission to write the `asset.*` and `actor.looks`
  collections and nothing else, as the hub's own account asks for only its
  record types (H6). The files still go to the person's own repo.

## 5. Assets a leaf hosts for its members

A leaf can host assets for its members: an avatar, a portrait, an item only
its members may wear. Members with no AT account can have assets this way
too.

These are **not AT records**: a public record saying "this leaf hosts
Ana's avatar" would show which leaves she uses (vision §7.2). Instead the
leaf **claims** them to the hub privately, in its presence report
(`POST /api/bbs/presence`, hub plan H14), alongside each member it
reports:

```json
{
  "did": "did:plc:ana…",
  "on": true,
  "assets": [
    {
      "slot": "avatar",
      "available": "always",
      "description": { "short": "a lanky figure in a neon jacket" },
      "rating": "general",
      "versions": [
        { "form": "icon", "sha256": "…", "size": 18342, "mediaType": "image/png" },
        { "form": "ansi", "sha256": "…", "size": 4120, "mediaType": "text/x-ansi" }
      ]
    }
  ]
}
```

The hub fetches each file from `/assets/<sha256>` on the leaf's web
address, through its tunnel, and checks it like any other (§6). It uses the
asset **only while the leaf's claim holds**:

| `available` | The hub uses it |
|---|---|
| `always` | Whenever the person is present on the hub. The hub keeps it cached, so it works while the leaf is down: a leaf that is only offline hasn't withdrawn its claim |
| `on-leaf` | Only while they are signed in to the leaf: the claim ends when the leaf stops reporting them as on |
| `in-space` | Only while they are present in the hub's common space |

- A claim ends when a report from the leaf leaves it out, or the leaf
  leaves the hub; a leaf that sends no report (it is down) ends nothing.
  The hub stops using the file at once then, and deletes its copy within
  the hour unless something else still uses it, as for withdrawn art
  (§6.5).
- **The leaf serves claimed files to the hub alone.** Served to anyone at
  `/assets/<sha256>`, a member's avatar would show which leaf hosts it:
  ask each board for the hash, and the one that answers is theirs. So the
  hub's edge doesn't pass public requests for claimed files to the leaf;
  the hub fetches them itself, through the tunnel, and serves its own
  copy.
- **The person decides what is shown as theirs.** A leaf can't put a
  picture on someone across the hub by claiming it: a claim for a slot
  shows on `/me`, where the person accepts it, and picks one when two
  leaves claim the same slot. Until then it is used on that leaf only.
- A leaf speaks only for its own members, as in its presence report: a
  claim for a DID counts once that person has confirmed the leaf at the
  hub (H14); before that, and for members with no AT account, the asset is
  shown as theirs only on that leaf's word (`alice via coolbbs`).
- Permissions and licence can be given in the claim, as in a record (§7).
  Without them, the asset may be used only by the member it was claimed
  for.
- Anything shown may already have been copied: availability controls use
  in the world, not secrecy.

## 6. The hub

### 6.1 Finding assets

The hub doesn't index everyone's assets. It fetches an asset when something
refers to it:

- a registered leaf's listing (its `emblem`) or catalogue;
- a signed-in person's `actor.looks`, or their choice of look on the hub;
- a leaf's claim for a member (§5);
- an asset placed in the space by someone allowed to (world.md §5), later.

Jetstream, which the hub already follows for listings (H7), tells it when
those records change, with `asset.*` and `actor.looks` added to the
collections it asks for, filtered to the accounts it cares about.

### 6.2 Checks

Once per hash, before anything is served:

1. **Fetch** within the cap for its form (§6.3), and check the hash.
2. **Validate** the format by actually parsing it, never trusting the
   media type or file name.
3. **Sanitize:**
   - **ANSI:** must be **clean ANSI**: before its end-of-file mark,
     nothing but characters, colour codes (SGR: reset, bright, blink, the
     eight foregrounds and backgrounds) and line ends, in lines of at most
     160 characters; after it, at most SAUCE's comments and record. Window
     titles, terminal queries, cursor movement, device modes and every other
     escape are refused. Art that isn't clean yet is cleaned by playing it
     into a grid of characters and writing it out again, which a hub may do
     itself or leave to the publisher's baker. SAUCE is read for width,
     font, iCE colours and credit.
   - **Images:** decoded and re-encoded, which strips metadata (including
     location data in photos) and anything hidden after the image.
   - **SVG** is never served as SVG: the hub rasterizes it to PNG.
   - **Models:** checked with the glTF validator; no external references, no
     scripts; extensions only from an allowed list (VRM, meshopt, KTX2 and
     the like).
4. **Measure** budgets for models and sprites, and compare with the
   record's figures (which are only the publisher's word).
5. **Apply rules:** the rating against the hub's and the place's, the
   licence and permissions (§7), the hub's blocklist (§9), its caps and
   the publisher's quota.

An asset waits (shown as the role's default) until it passes. A refused
one keeps its reason, which the publisher can see.

### 6.3 Caps and quotas

Hub config, `assets`: `enabled`, a cap per form and class, a cache quota
per publisher, a total cache size, and whether direct sources are allowed.
Suggested starting caps, to be tuned with use:

| Form | Cap |
|---|---|
| `ansi` | 64 KB, 160 columns |
| `icon` | 256 KB, 512 × 512 |
| `image`, `panorama` | 2 MB, 4096 px on a side |
| `sprite` | 4 MB |
| `model` `light` / `standard` / `full` | 8 / 25 / 100 MB, with budgets per class (world.md §2.2) |

### 6.4 Serving

- `GET /assets/<sha256>` on the hub's own address serves a checked file:
  the content type the hub decided, `nosniff`, a sandboxing content
  security policy, and cached forever by browsers (the name is the
  content).
- For large files with a direct source, the live model may give clients
  that address and the hash instead, and clients check the hash themselves.
  So the people who want heavy assets supply the bandwidth (vision §8.8).
  **Only for viewers who opt in:** whoever runs a direct source sees the
  address (IP) of everyone who fetches from it, and when, which would let
  the owner of a model learn who came near it. By default a client fetches
  only from the hub, and shows a lighter version the hub serves, or the
  description, for anything it would have to fetch elsewhere. The same
  goes for mirrors ([compute spec](compute.md) §9.1). The hub's privacy
  notice says so before any of this is turned on.
- Views don't resolve AT records. The live model (live_model.md) carries
  each entity's **look**: the versions available (form, class, the hub's
  address for each), the description, and the identity marks of §8.2, as a
  named extension that views without it ignore (vision §8.3).

### 6.5 Withdrawal

- **A deleted record** withdraws its asset: the hub stops using it and
  drops what only it used from the cache. Creative Commons licences can't
  be revoked, but honouring deletion is the courteous default.
- **A changed record:** references by strongRef keep the version they
  pinned; references by URI follow the latest, which is checked before use.

## 7. Permissions and remixing

### 7.1 Permissions

Each asset's author sets, for each permission, who has it:

| Permission | Means |
|---|---|
| `use` | Wear it, or place it in the space |
| `copy` | An unchanged duplicate, published as one's own (still credited) |
| `restyle` | A copy with colours, skins or materials changed |
| `remix` | A copy with any change |
| `share` | Those who copy or remix may let others do the same |
| `commercial` | Use in anything sold |

Each is one of `anyone`, `members` (of the leaves listed, by the membership
they vouch for; vision §6.4), `named` (DIDs listed in the record, which
makes them public), or `nobody` (the author alone). `hubs` can narrow any
of them to named hubs. They're set to match the licence: CC-BY allows
everything with credit, `-ND` rules out `restyle` and `remix`, `-NC` rules
out `commercial`. VRM's built-in permission fields are read into these when
importing (world.md §7).

Suggested defaults, which authors can change:

- **Avatars:** `use` by the author alone; `restyle` and `remix` by anyone,
  with credit; no exact `copy`. An avatar is identity (§8).
- **Everything else:** everything by anyone, with credit (CC-BY-4.0).

These limit **wearing and using, not seeing.** Records are public, and
anything shown can be saved.

### 7.2 Remixing in the world

Remix is a verb: "copy Ana's model and make it blue", "give this a metal
skin". The hub's tools and the baker do it, and every result is a new
asset whose `source` and `change` record where it came from. Inspecting
anything shows its line: made by X, restyled by Y. Scratch's Remix button,
which credits every original, is the model. Contributor awards can count
"most remixed" (vision §8.8).

### 7.3 Enforcement

What the hub can do, in the world:

- **Its own tools obey permissions.** The remix verb refuses, or offers only
  restyling, where the author said so; the hub won't let someone wear what
  they may not `use`.
- **Exact copies are caught:** a file whose hash belongs to an asset that
  doesn't allow `copy`, published by someone else, is held for the admin
  to look at and both publishers are told. It isn't refused outright: the
  first to publish a file isn't always its author, and refusing would let
  someone lock an artist out of their own work by publishing it first.
- **Near-copies are flagged, not refused.** Perceptual hashes (for images
  and rendered ANSI) and shape fingerprints (for models) catch lightly
  changed copies. The publisher is asked to mark it as a remix, which
  credits the original, or to explain; the author is told. Real changes
  aren't caught, and aren't meant to be.
- **First seen:** the hub records when it first saw each hash, and each
  record is signed by its publisher. That is evidence for the admin, not
  proof of authorship: it shows who published first here, which a copier
  can be.

Beyond that, protection is social: visible credit, the hub's norms in its
terms, a report kind for "copied without permission" (§9), and the admin's
judgement. Real copyright claims go through the hub's legal process (§10).

## 8. Identity and impersonation

Copying someone's avatar and changing one pixel's colour is undetectable as
a copy. So the hub doesn't rely on appearance for identity.

### 8.1 Identity comes from sign-in

- The hub knows who each person in the space is: their AT sign-in, or
  their leaf's vouching for members without AT accounts (vision §6.4). It
  attaches that identity to whatever they wear.
- A perfect copy of Ana's avatar worn by Bob is still shown as Bob: his
  **handle** on his nameplate and when inspected, at every level. Display
  names can be copied; the handle is verified (through its domain or DID),
  so the interface treats it as the identity.
- **Authorship is signed already:** an asset record sits in its author's
  repo, whose every change is signed with the account's key, and names its
  files' hashes. "This exact file was published by @ana" can be proven by
  anyone. A signature inside the file would add nothing, since it can be
  stripped. A signature proves who published, not who made; first-seen
  times help there (§7.3).

### 8.2 Signature looks

A person can name assets as their **signature looks**, in their
`actor.looks` record (§3.4):

- When they wear one, clients show a small **own look** mark, verified
  against their record.
- When someone else wears something that resembles it (the near-copy check
  of §7.3, against the signature looks of people nearby), clients show
  **"resembles @ana's look"**. A one-pixel change doesn't escape it: the
  check is for resemblance, not equality. Checking against the people a
  viewer follows would mean the hub reading who follows whom; that is
  left out unless the viewer asks for it and the privacy notice says so.
- A look can be claimed as a signature only by whoever the hub saw wear
  or publish it first, and a person has a small number of them, so nobody
  can name someone else's look as their own and have the real owner
  marked as the look-alike.
- A hub may go further and refuse look-alikes of someone's signature look
  in its space without their permission. That is the hub admin's choice.

Bluesky's verification records (trusted accounts vouching for others,
shown as a badge) are the nearest precedent.

None of this stops someone fooling strangers who don't look. It makes the
real person checkable at a glance, and puts look-alikes behind a visible
warning.

## 9. Moderation

- **Reports:** the hub's report form (H8) gains kinds for an asset and for
  "copied without permission"; reports name the asset by its hash.
- **Blocking:** `hubctl asset block <sha256> --reason …` blocks a file
  everywhere on the hub, including future copies with the same hash;
  `unblock` reverses it; `hubctl assets` lists what is cached, pending,
  refused and blocked, by publisher. Blocks go in the moderation log.
- **Publishers:** a hub can refuse all assets from an account, as it bans
  one (H8).
- **Ratings** are the publisher's word, as for listings, with reports and
  the admin behind them. Nothing can judge automatically what ANSI art or a
  model depicts.

## 10. Legal

- **Caching and serving assets is closer to hosting than to being a
  conduit.** It strengthens the case for a DMCA designated agent, already on
  the list for the lawyer's review, and the hub's terms need a section on
  assets: what may be published, the permissions, and takedowns.
- Uploads to the hub (§4.1) wait until that's settled.
- Imports from other platforms must respect their terms: models from
  VRChat come from their source files, never from uploads (world.md §7.1).

## 11. Order

*Step 1 works on the public hub for its test boards (hub plan H20,
2026-11-26): the baker, for ANSI; a library the hub checks and serves; a
gallery; art shared in the chat; BBSes' splash screens, emblems and
published art, with moderation and withdrawal; and people's pictures on
the map. Other boards' art waits for the terms (§10).*

1. **A leaf's emblem on the map.** Draft records (`dev.asset.item`); the
   listing's `emblem`; the fork publishes an ANSI logo; the hub fetches,
   sanitizes, caches and serves it; the live model carries looks; the map
   draws boards with their emblems, and people with their Bluesky picture
   (vision §7.2, step 4) through the same path.
2. **Members' assets** (§5): claims in the presence report, `available`,
   avatars and portraits from the leaf.
3. **People's own looks:** `actor.looks`, signature looks and the marks of
   §8.2.
4. **Catalogues, permissions and remixing** (§3.3, §7), with the baker's
   first version (world.md §7).
5. **Models and the 3D views**, as those come (world.md §9).

## 12. Open questions

- Whether PDSes, bsky.social's especially, accept ANSI's media type and
  sprite sheets' JSON as blobs, and their real size limits.
- The perceptual hash and model fingerprint to use, and how close counts
  as a near-copy.
- The live model's `look` extension, exactly.
- How a leaf's `members` permission is checked for someone wearing an item
  on another hub.
- How long the hub keeps first-seen records, given the 3-month log rule
  (they hold hashes and DIDs, not activity).
- How at3d.app's avatar records, if they settle, map onto §3.
- A person's choice of view kept with their hub profile, so it follows
  them between devices, rather than in a cookie.
- When a hub makes derived versions itself (§3.5): always, or only for
  forms it serves that the publisher didn't make; and how it keeps them.
