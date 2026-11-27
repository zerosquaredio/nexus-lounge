# Build Spec: the First 3D Slice

Status: Decisions accepted (2026-11-26); ready to build. The numbers in
decision 4 are provisional, to be tried and revisited (§9)
Last updated: 2026-11-26

A board publishes a 3D model; the hub checks it, keeps it and serves it;
the gallery shows it in a viewer that plays its animations. This is the
first use of the `model` form of the [assets spec](assets.md) (§2, §6.2,
§6.3, order step 5, taken early), and what driven models and compute
([compute spec](compute.md) §5) build on. It is written to be built by
several agents at once, so it fixes the shapes they would otherwise each
invent.

## 1. What it is, and isn't

**In:** `.glb` files of class `light`, published by a board as asset
records with a preview picture; checked and measured by the hub; listed
in the gallery by their preview; a page per model with a viewer (turn,
zoom, play its animations); blocking, reports, withdrawal, refusal and
caps as for ANSI art.

**Out, for later:** models on the map, in the chat (a model shares as
its preview picture, linking to its page) or in the BBS door; driven
settings and object state (compute §5); compressed formats; VRM avatars;
classes `standard` and `full`; files from anywhere but the board's own
account; boards other than the hub's own test boards on the public hub,
until the terms cover models.

## 2. Decisions for the owner

Each has a recommended answer. **All eight were accepted as recommended
(2026-11-26).** The limits of decision 4 are a first guess, made without
data, and are to be revisited once real models have been tried (§9).

| # | Decision | Recommended |
|---|---|---|
| 1 | **The viewer.** The hub's first third-party script: its pages run only its own scripts, from its own address, with no build step | A pinned release of three.js (the module build, with its glTF loader and orbit controls), copied into the repo with its licence (MIT), served by the hub at its own address. No CDN, no bundler. Recorded in `related_tools.md` |
| 2 | **How models are checked.** The spec says "the glTF validator", which is a large outside dependency | The hub's own checker in TypeScript (§4), as it has for PNG and ANSI. Khronos's validator is used in tests only, to confirm the checker agrees on the fixtures |
| 3 | **Extensions allowed** | None of the compressed formats (meshopt, Draco, KTX2), which each need a decoder running in the page. Allowed: `KHR_materials_unlit`, `KHR_materials_emissive_strength`, `KHR_texture_transform`, `KHR_mesh_quantization`; and, *added 2026-11-26*, the material effects three.js draws: clearcoat, sheen, transmission, volume, iridescence, specular (`KHR_materials_*`), their textures checked like a material's own. A model that *requires* anything else is refused; other optional ones are ignored. What the effects cost to draw is a trial (trials.md §2); a limit on how many one model uses may follow |
| 4 | **Size and budget for `light`** (the framework's world doc names the classes but gives no numbers) | 8 MB a file; 30,000 triangles; 32 draw calls; 4 MB of textures, none over 1024 pixels a side; 64 bones; 16 animations of up to 60 seconds. Tuned with use. *Added by the security reviews (2026-11-26), so that what the checker counts is what a viewer draws and holds:* one scene; 1,000 nodes; 8 morph targets and 16 attributes a primitive; 64 channels an animation |
| 5 | **Textures inside a model** can carry hidden data (location, a camera's details), which the spec says to strip | PNG and JPEG only. The hub rewrites the file without metadata blocks and anything after the image's end, and serves that rewritten model, as it serves cleaned ANSI. No re-encoding of the pixels in this slice |
| 6 | **A preview picture.** Every asset needs an image for where scripts are off and for the gallery; the hub can't draw 3D itself | The sysop gives one: a PNG beside the model. The hub requires it |
| 7 | **The record's shape,** where the spec and the code disagree | Keep what the code does and correct the spec: the record is keyed by the SHA-256 of its first file, and each version carries its `file` (hash, size, type) with its `blob` beside it. A model item has two versions: the model, then its preview image |
| 8 | **On the public hub** | Built and tested on a scratch hub with models of our own. On the public hub, off (`assets.models.enabled`) until the terms' section on art covers models and the lawyer has seen it |

## 3. Shapes

**The record** (`nexus.cyberspace.dev.asset.item`, as art uses), rkey the
model file's SHA-256:

```json
{
  "name": "Brass Clock",
  "kind": "art",
  "rating": "general",
  "licence": { "id": "CC-BY-4.0", "url": "https://creativecommons.org/licenses/by/4.0/" },
  "credit": { "author": "Ana" },
  "description": { "short": "A brass mantel clock, its pendulum swinging" },
  "versions": [
    {
      "form": "model",
      "class": "light",
      "file": { "sha256": "…", "size": 412345, "mediaType": "model/gltf-binary" },
      "blob": { "$type": "blob", "ref": { "$link": "bafk…" }, "mimeType": "model/gltf-binary", "size": 412345 }
    },
    {
      "form": "image",
      "file": { "sha256": "…", "size": 20311, "mediaType": "image/png" },
      "blob": { "$type": "blob", "ref": { "$link": "bafk…" }, "mimeType": "image/png", "size": 20311 }
    }
  ]
}
```

**The fork's config:** an entry in `atProto.publishing.assets` gains
`model` (a path to a `.glb`) and `image` (its preview PNG), with the
name, licence, credit and description it has for art. A file over the
account host's upload limit is refused when publishing, with the limit
named.

**The hub's config:** `assets.models`: `enabled` (false), `maxBytes`
(8 MB), `perBoard` (5 models), `totalBytes` (200 MB). Only boards in
`assets.boardArt`, as for art.

**What pages are told about a model** (`ModelItem` in `board_models.ts`,
a type of its own rather than art's `PublicItem`, which every piece of
ANSI art fills): name, description, credit, licence and rating as art
has; `page`, its address; `image`, the preview; and `model: { url,
bytes, triangles, animations: [names], effects: [names] }`.

## 4. The checker

A pure function of the file's bytes, returning the measured figures or a
reason for refusing. It is the security boundary of this slice: every
byte comes from outside.

- **Container:** the 12-byte header (`glTF`, version 2, a length equal to
  the file's); exactly one JSON chunk, then at most one binary chunk;
  chunk lengths within the file and padded as the format says; nothing
  after the declared length.
- **JSON:** valid UTF-8 and JSON, under 1 MB; `asset.version` "2.0".
- **Nothing outside the file:** no buffer or image has a `uri`, not even
  a `data:` one; everything is in the one binary chunk.
- **References in range:** every index (accessors, buffer views, nodes,
  meshes, materials, textures, images, skins, animations, scenes) points
  at something that exists; every buffer view and accessor lies within
  the binary chunk, with a known component type and count; no cycles
  among nodes.
- **Extensions:** `extensionsRequired` only from decision 3's list.
- **Images:** PNG or JPEG by their own bytes, sizes within the budget.
- **What a viewer would hold, not just what the file says** (found by
  running hostile files through the viewer's own loader): a scene lists
  each root node once, and there is one scene; buffer views share no
  bytes; a stride only on vertex data, with every element whole; animation
  times rise, and values are plain numbers; morph targets, attributes,
  channels and nodes are capped; the vertex data all the accessors
  describe is no more than twice what the file holds; no object key named
  `__proto__`, `constructor` or `prototype`.
- **Budget, measured by the hub** (a record's own figures are ignored):
  triangles (from each primitive's indices or positions), draw calls
  (primitives), bones (joints), texture bytes and sizes, animation count
  and length. Over budget is refused, with the figure.
- **Rewritten on the way out** (decision 5): the model the hub serves is
  the same scene with its images stripped of metadata, named by its own
  hash; the item's id is that hash.

## 5. The viewer page

- **The gallery** (`/art`) shows a model by its preview picture, with its
  name, credit, licence, triangle count and size, a **View in 3D** link
  and **Report**, with or without scripts.
- **A page per model,** `/art/<first 12 digits of its id>`: the preview
  until the person presses **Load 3D** (the file is fetched only then);
  turn and zoom with mouse, touch and keys; a button for each animation
  by its name, playing `idle` if there is one, else the first, looping;
  **Pause**; a fixed neutral light. Paused to start with for people who
  ask their device for less motion. In a view set to text, the
  description only.
- **Its own, narrow permissions:** this page alone may run the hub's
  viewer scripts, fetch from the hub, and show pictures the viewer makes
  from the model's textures. No WebAssembly, no workers, nothing from any
  other address. Every other page keeps the rules it has.
- **Model files** are served as art is: by hash, never run as a page,
  only to the hub's own pages.

## 6. Stages, with a trial after each

Built in stages, each ending in something that can be tried, so that a
wrong guess (a limit, a rule of the checker) is found before more is
built on it. The trials are in [trials.md](trials.md) §2, by stage.

**Stage 0, done (2026-11-26): can it work at all?** Bluesky's hosts
accept model files as blobs, up to the 8 MB tried.

**Stage 1: the parts that stand alone.** First, alone: **A.** the shapes
of §3 and §4 into `assets.md`, and a feature in the hub plan. Then four
tracks side by side, each in files of its own:

| Track | Work | Touches |
|---|---|---|
| **B. Checker** | `gltf.ts`: §4, with tests on good and hostile files | New files in the hub |
| **C. Fixtures** | A few small models of our own (still, animated, skinned), CC BY 4.0 like the project's art, and generated hostile ones (an outside address, wrong lengths, too large, a required extension, trailing bytes) | New files in the hub |
| **D. Viewer** | The copied library, the hub's viewer script, a bare test page, tried against the fixtures in a real browser | New files in the hub |
| **E. Fork** | Config entries, finding the files, the size check, upload, the two-version record, tests | The fork only |

*Trials after stage 1:* the checker over freely licensed models from
elsewhere, beside Khronos's validator; how many of them need a compressed
format.

**Stage 2: on the hub, on a scratch hub. Built 2026-11-26.** In order, by one agent (they
share files): **F.** the hub's record reader and library take models
(`assets.ts`, `board_art.ts`: read every version; items without ANSI;
large files served from disk, not held in memory; quotas; withdrawal,
blocking and refusal as for art); **G.** the gallery and the model page
(`art_page.ts`, `site.ts`), with their permissions and the page's own
report of frame rate and load time.

*Trials after stage 2:* the `light` budget and the file cap, on a
desktop and on phones; how the viewer handles. The limits are changed
here, before boards publish anything.

*As built:* `board_models.ts` reads boards' records beside their art (on
the stream's word and hourly), keeps each model and its preview cleaned
in `board-models/` beside the database and serves them from disk;
`model_files.ts` serves the viewer's scripts by a fixed list, with
ETags; the gallery lists models by their preview; `/art/<12 digits>` is
a model's page, with the policy of §5 and nothing loaded until **Load
3D**. `hubctl assets` lists models, so `hubctl asset block` takes their
short hashes.

**Stage 3: end to end.** **H.** a board publishes a model from its own
account, the hub takes it, the page plays its animation in a real
browser, a blocked hash disappears, a deleted record withdraws it; first
on a scratch hub, then test2 on the public hub with a model of our own
(`assets.models.enabled` for it alone). **I.** docs, the terms draft
naming models, and the question for the lawyer.

*Trials after stage 3:* quotas against the hub's disk and memory;
stripping of textures' metadata.

Other boards' models stay off the public hub until the terms cover them
(decision 8).

## 7. How it's verified

- **Without a person:** unit tests for the checker (each rule, each
  hostile file, the measured figures), the record reader and library,
  taking and quotas with a stand-in account host, the routes and their
  headers; the fork's tests for the record and the upload; Khronos's
  validator over the fixtures, in tests only; a real browser (Playwright)
  loading the model page on a scratch hub: no errors, nothing fetched
  from any other address, the animation's buttons work, the page works
  with scripts off.
- **With a real account host:** done first (stage 0). Bluesky's host
  accepted `model/gltf-binary` uploads from a test board's own account at
  440 bytes, 1 MB and 8 MB (2026-11-26).
- **By a person:** how it looks and handles, on a desktop and a phone.

## 8. Unchanged, and to change

- **The privacy notice:** unchanged. Models are public and published by
  boards, as art is, and the viewer keeps nothing about who looked.
- **The terms:** the drafted art section gains models, and the lawyer's
  questions gain one (larger files, textures that may be photographs),
  before the public hub turns it on.

## 9. To try out and revisit

The numbers here were set without data. They, and when each is tried, are
in [trials.md](trials.md) §2, with every other provisional number in the
project. Each is one setting or constant, and the viewer page reports
what it measures, so they can be changed on evidence.
