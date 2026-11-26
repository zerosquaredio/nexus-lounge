# Trials: Numbers and Choices to Try Out and Revisit

Last updated: 2026-11-26

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
| The main menu's hint line | "HS around  HP be shown  AT Bluesky", prompt row 1, column 37 | The fork's `main.in.hjson` | Readable? Right on your own theme? | A person |
| Withdrawn art deleted | At the next reading (seconds by the stream, an hour at worst) | `board_art.ts` | Delete a published piece: how long until it's gone from `/art`? | Claude |

## 2. The first 3D slice

In stages, with the build ([build_3d_slice.md](build_3d_slice.md) §6): each
trial happens as soon as the stage that makes it possible is done, so a
wrong guess is found before more is built on it.

| Stage | What | Now | How to try it | Who |
|---|---|---|---|---|
| 0 | Do Bluesky's hosts take model files? | **Tried 2026-11-26: yes.** From test2's own account, files of 440 bytes, 1 MB and 8 MB were accepted as `model/gltf-binary`, in about 1 to 2 seconds each | Settled for `bsky.social`; other hosts unknown | Claude |
| 1 | The checker against real models | Our own rules (§4 of the build spec) | Run it over a set of freely licensed models from elsewhere, beside Khronos's validator: what does it refuse that is fine, or pass that isn't? | Claude |
| 1 | No compressed formats | Refused if required | Of those same models, how many need one, and how much larger are the rest uncompressed? | Claude |
| 2 | The `light` budget | 30,000 triangles, 32 draw calls, 4 MB of textures at up to 1024 pixels, 64 bones, 16 animations of up to 60 seconds | The viewer page reports its frame rate and load time. Models at half the budget, at it, and at twice it, on a desktop, a mid-range phone and an old phone | Claude for the numbers on a desktop; a person for the phones |
| 2 | The 8 MB file cap | 8 MB | How long does a phone on mobile data take to fetch it? Would 4 MB do? | A person |
| 2 | How the viewer handles | Turn, zoom, a button for each animation, a fixed light | Does it feel right? Anything missing that every model needs? | A person |
| 3 | Models from each board, and in all | 5; 200 MB | The hub's disk and memory with a few boards publishing | Claude |
| 3 | Stripping textures' metadata without re-encoding | PNG and JPEG, metadata blocks removed | Feed it pictures with location data and with data hidden after the image's end: what survives? | Claude |

## 3. Later designs (nothing built yet)

| What | Suggested | Spec |
|---|---|---|
| Fuel and memory for programs; how much each place keeps free | To be measured on the first programs | [compute.md](compute.md) §2, §8 |
| State updates an object may send | 4 a second | compute §5.2, §8 |
| Live events a place may make | To be found: when do bells turn into noise? | compute §11.3 |
| Awards: what is worth one, and can the counting be gamed | To be tried with a few givers we know | compute §9.2 |
| How coarse a weather feed's place and readings must be | A town; rain or not, temperature to a few degrees | compute §10.4 |
| Settings as sentences: do the presets cover what people want | Four presets | [settings_ui.md](settings_ui.md) §3 |
| How many pieces of a board's art, and models, before a quota in bytes is needed | Counts for now | [assets.md](assets.md) §6.3 |

## 4. Settled

*(none yet)*
