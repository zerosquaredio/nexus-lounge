# Trials: Numbers and Choices to Try Out and Revisit

Last updated: 2026-11-27

Limits and choices made without real data. Each is one setting or one
constant, so changing it is small. This is the one list of them: specs
point here instead of keeping their own. When one has been tried, write
what was seen and what was decided in its row, with the date; when it is
settled, move it to **Settled** at the end.

"Who" is who can try it: **Claude** (a test, a script, a browser driven
by one) or **a person** (how it looks and feels, on real devices).

## 1. Live now

| What | Now | Where it's set | How to try it | Who |
|---|---|---|---|---|
| People's pictures on the map: size | 18 pixels across | `map_page.ts` | With several people at one board: can you tell them apart, is it too busy? At phone size too | A person |
| A picture the hub will take | Up to 1 MB, 2048 pixels a side | `pictures.ts` | How many real Bluesky pictures are refused (the hub's log says each) | Claude, from the log |
| Pictures: read again, and kept unseen | Every 6 hours; a week | `pictures.ts` | Change your Bluesky picture: is 6 hours too slow to matter? | A person |
| Art from each board | 50 pieces, 64 KB each | `assets.boardPieces`; `ansi.ts` | A board with a real gallery: enough? | A person (a sysop) |
| How fast moderation takes effect | A block in 30 seconds; a refused account's splash in a minute, its pieces within the hour | `main.ts`, `board_art.ts` | Block something for real: fast enough? | A person |
| Each board's bandwidth | 1 MB a second each way | `tunnel.bandwidthLimit` | Usage totals (`hubctl usage`) once boards serve art | Claude, from usage |
| The main menu's hint line | "HS who's on  HP show me  AT Bluesky", prompt row 1, column 36. **2026-11-27:** the first wording ("HS around  HP be shown") puzzled; this one was chosen instead | The fork's `main.in.hjson` | Readable? Right on your own theme? | A person |
| Withdrawn art deleted | At the next reading (seconds by the stream, an hour at worst) | `board_art.ts` | Delete a published piece: how long until it's gone from `/art`? | Claude |

## 2. The first 3D slice

In stages, with the build ([build_3d_slice.md](build_3d_slice.md) §6): each
trial happens as soon as the stage that makes it possible is done, so a
wrong guess is found before more is built on it.

| Stage | What | Now | How to try it | Who |
|---|---|---|---|---|
| 0 | Do Bluesky's hosts take model files? | **Tried 2026-11-26: yes.** From test2's own account, files of 440 bytes, 1 MB and 8 MB were accepted as `model/gltf-binary`, in about 1 to 2 seconds each | Settled for `bsky.social`; other hosts unknown | Claude |
| 1 | The checker against real models | Our own rules (§4 of the build spec) | Run it over a set of freely licensed models from elsewhere, beside Khronos's validator: what does it refuse that is fine, or pass that isn't? **Tried 2026-11-26, results below** | Claude |
| 1 | No compressed formats | Refused if required | Of those same models, how many need one, and how much larger are the rest uncompressed? | Claude |
| 1 | Rules the checker gained from its security reviews, which refuse some valid models | One scene only; at most 1,000 nodes, 8 morph targets and 16 attributes a primitive, 64 channels an animation; animation values as plain numbers only (some optimizing tools write packed integers); no buffer views sharing bytes; vertex data no more than twice what the file holds | Of those same models, how many does each rule refuse? Loosen the ones that cost most and can be loosened safely | Claude |
| 2 | The `light` budget | 30,000 triangles, 32 draw calls, 4 MB of textures at up to 1024 pixels, 64 bones, 16 animations of up to 60 seconds | The viewer page reports its frame rate and load time. Models at half the budget, at it, and at twice it, on a desktop, a mid-range phone and an old phone | Claude for the numbers on a desktop; a person for the phones |
| 2 | Material effects (clearcoat, sheen, transmission, volume, iridescence, specular): allowed, no limit on how many | All six, any number at once. The checker names those each model uses (`effects`) | The frame rate of models using none, one, two and three of them (the sample collection has 21, 17 and 7 of each), above all transmission, which draws the scene a second time. Is a model with them still `light`? Perhaps a limit of one or two a model, or transmission counted against the budget | Claude for a desktop; a person for the phones |
| 2 | The `light` budget on a desktop | As above | **Tried 2026-11-26 (results below)** | Claude |
| 2 | The 8 MB file cap | 8 MB | How long does a phone on mobile data take to fetch it? Would 4 MB do? | A person |
| 2 | How the viewer handles | Turn, zoom, a button for each animation, a fixed light | Does it feel right? Anything missing that every model needs? | A person |
| 3 | Models from each board, and in all | 5; 200 MB | The hub's disk and memory with a few boards publishing. **Tried 2026-11-27, below** | Claude |
| 3 | Stripping textures' metadata without re-encoding | PNG and JPEG, metadata blocks removed | Feed it pictures with location data and with data hidden after the image's end: what survives? **Tried 2026-11-27: nothing, below** | Claude |

### What the first trial showed (2026-11-26)

The checker, after two security reviews, over the 109 models of 9 MB or
less in Khronos's glTF sample collection (feature tests and showpieces,
so richer than a typical small model). No crash, nothing but a plain
refusal, the slowest check 64 ms.

- **44 of 109 pass the `light` budget as it stands.** With the size
  limits lifted and only the rules applied, 79 do.
- **The texture limit refuses most:** 34 models have a texture over 1024
  pixels a side. Of the 97 that could be measured, the largest texture is
  2048 in 37, 1024 in 19, 512 or less in 25. *To decide in stage 2, on
  real devices:* whether `light` should allow 2048 (and whether the hub
  should then offer a smaller version itself).
- **Triangles:** half the models have under 4,300, three quarters under
  19,000, and 76 of 97 are within 30,000. The limit looks about right.
- **Extensions a model requires:** 11 refused. None needs a compressed
  format. Five need `KHR_lights_punctual` (lights inside the model, which
  the viewer page's fixed light replaces), the rest newer material
  effects (clearcoat, sheen, transmission, volume, iridescence, specular)
  that three.js draws. *Decided 2026-11-26:* the material ones are
  allowed (their textures held in range like a material's own), and
  what they cost to draw is a stage 2 trial. With them, 47 of 109 pass
  `light` (from 44), and 101 pass with every size and count limit
  lifted (97 before, counted the same way). 45 models use at least one effect, 7
  of them three.
- **The rules added by the security reviews cost little:** two models
  have an animation with more than 64 samplers; none has several scenes,
  shared buffer views, packed animation values or too many morph targets.
  One animates something the checker doesn't know (a colour, by a newer
  extension).
- **Total texture pixels** (a rule from the first review) refuses 16 even
  with the per-side limit lifted; it should be set together with the
  texture side.

### What the stage 2 desktop trial showed (2026-11-26)

The 47 Khronos sample models that pass `light`, each published by a
stand-in board to a scratch hub, opened on its page in headless Chrome
on a desktop PC, **Load 3D** pressed.

- **All 47 loaded,** with no breach of the page's policy and nothing
  asked of any other address. Loading took 16 to 486 ms from the hub on
  the same machine (the larger files: 1 to 3.9 MB, 120 to 300 ms).
- **Frame rate:** every animated model ran at the browser's cap (240 a
  second). The viewer draws a still model only when it moves, so it gives
  no figure for those until turned: the phone trial should turn each.
  A desktop is not where the budget will bind; phones are.
- **Material effects cost more than the checker counts:** for models
  using transmission, three.js draws more triangles than the model has
  (the broken window 1,974 for 987; the sunglasses 23,848 for 13,396;
  the iridescent Suzanne 19,680 for 11,808), and more draw calls. *For
  the effects trial:* count a transmissive mesh's triangles twice against
  the budget, or limit how many effects a model uses.

### Stage 3 trials (2026-11-27)

- **Textures' metadata.** A JPEG with EXIF (a camera maker and a GPS
  position), an XMP block, a comment and data after its end, and a PNG
  with tEXt, iTXt and zTXt chunks, an eXIf chunk and data after its end,
  each put inside a model and through the checker: both taken, and none
  of it in the model the hub would serve; the same for a PNG as a model's
  preview. A valid colour profile is kept on purpose (it changes how the
  colours look); it can name the device that made it, nothing more.
  *Settled for now:* the cleaning does what decision 5 asks.
- **Disk and memory.** The public hub with five models (test2's: the test
  model and four Khronos samples up to 3.1 MB): 7 MB on disk, 10 files (a
  model and a preview each); the hub process at 146 MB of memory after
  three hours, on a server of 3.8 GB, models being served from disk and
  never held. At the 200 MB limit for all models, under 1% of the
  server's 25 GB free. *The limits stand;* they can grow with the server.

### On a phone, larger models on mobile data (2026-11-27)

Four freely licensed Khronos samples published by test2, each opened for
the first time on an iPhone 15 Pro Max on mobile data (5G, no Wi-Fi):

| Model | File | Triangles drawn | Loaded in | Frames a second |
|---|---|---|---|---|
| Fox (animated) | 160 kB | 576 | 589 ms | 60 |
| Traffic cone | 1.9 MB | 17,224 | 1,751 ms | 60 |
| Velvet sofa (sheen) | 3.1 MB | 4,196 | 2,872 ms | (not turned) |
| Glass vases (transmission) | 1.8 MB | 21,672 | 6,799 ms | 60 |

- **Downloading** ran at about 1 MB a second on 5G: an 8 MB model would
  take some 8 seconds on this connection, 4 MB about 4. On 4G or a weak
  signal it will be slower: worth trying once on 4G (or LTE) too.
- **Drawing** is not where this phone struggles: 60 frames a second
  (Safari's cap) for all, the glass included.
- **Transmission costs at load, not while drawing:** the glass vases took
  about 5 seconds longer than the cone, a file of the same size; that is
  the phone preparing the glass effect's shaders. *For the effects
  trial:* count transmission against the budget by the time it adds to
  loading, or tell people before they press Load 3D.
- Still to try: a mid-range or old phone, which is where the budget
  will bind.

### On a phone (2026-11-27)

test2's animated test model (192 triangles, 11 kB) on the public hub,
on an iPhone 15 Pro Max: loaded in 644 ms, 60 frames a second (Safari's
own cap). Again on mobile data: 167 ms, 59 frames a second, but most
likely from the browser's cache (model files are kept a day), so not a
measure of mobile data: that needs a model the phone hasn't fetched, and
a larger one. Turning, pinching to zoom, the animation buttons and Pause
all worked as expected. Missing: full screen and a way to put the view
back, both added after (**Reset view**, and **Full screen**, which fills
the window where the browser gives full screen only to video, as an
iPhone's Safari does), to be tried on the phone. The phone has room to spare at this size; the budget trial
needs models nearer the limits.

## 2a. The first live object

The slice's limits ([build_live_object_slice.md](build_live_object_slice.md)
§2, decision 6) are defaults in the hub's config, to be revisited with
real programs.

### Stage 0 trials (2026-11-27)

- **Fuel metering works.** A prototype of the rewriter (decision 1) added
  a fuel counter to hand-written modules and to real AssemblyScript
  output. The same step gave the same fuel on every run (a loop to 1,000:
  13,008 both times; to 2,000: 26,008), and rewriting the same module
  twice gave the same bytes. A loop past its fuel, and an endless one,
  stopped within 30 ms with 50 million fuel; deep recursion stopped on
  the stack; memory couldn't grow past the module's own maximum. An
  endless loop with no metering was stopped by the worker's time limit
  at 2 s, as the backstop. SIMD and a `start` function were refused.
- **What it costs:** a tight loop ran about 2.3 times slower metered
  (1.4 ms against 0.6 ms for a million rounds), which is the usual price
  of counting in the module itself. A weather step needs a few thousand
  fuel, against a limit of 50 million.
- **AssemblyScript** (0.28.20) builds programs the hub can take, with
  three flags: `--use abort=` (else it imports `env.abort`, which the
  host doesn't give), `--maximumMemory 16` (else it declares no memory
  limit, which the hub refuses), and `--exportStart _initialize`, since
  it sets up its memory in a `start` function. **Changed:** the hub
  takes an exported `_initialize`, which it calls once, metered like a
  step, after loading the module; a `start` section is still refused.
- **Open-Meteo:** a reply for one place's current weather is 564 bytes,
  a place found by name 423, each in under a second. Its current weather
  changes every 15 minutes (`interval: 900`), so the 10-minute minimum
  never misses a change. A name it doesn't know gives no `results`; a
  bad coordinate gives status 400 with `{"error":true,"reason":…}`. Both
  are kept as test fixtures.

## 3. Later designs (nothing built yet)

| What | Suggested | Spec |
|---|---|---|
| Fuel and memory for programs; how much each place keeps free | To be measured on the first programs; the first slice's defaults are in §2a | [compute.md](compute.md) §2, §8 |
| State updates an object may send | 4 a second | compute §5.2, §8 |
| Live events a place may make | To be found: when do bells turn into noise? | compute §11.3 |
| Awards: what is worth one, and can the counting be gamed | To be tried with a few givers we know | compute §9.2 |
| Settings as sentences: do the presets cover what people want | Four presets | [settings_ui.md](settings_ui.md) §3 |
| How many pieces of a board's art, and models, before a quota in bytes is needed | Counts for now | [assets.md](assets.md) §6.3 |

## 4. Settled

*(none yet)*
