# Build Spec: the First Live Object

Status: Decisions accepted (2026-11-27); ready to build
Last updated: 2026-11-27

An object whose own code fetches the weather for a place and shows it on
the hub's map. It is the first program the hub runs, and the first live
object, from the [compute spec](compute.md) (§1.2, §2, §7, §10.7): a
WebAssembly program, published with its source; a record giving it an
input (a place name, or coordinates); the hub running each step within
fuel and memory limits, fetching for it only from sites both the program
and the hub allow; and its values carried in the live model and drawn as
a small badge. Weather is the example; nothing in the hub knows about
weather except the shared `weather` type's limits.

## 1. What it is, and isn't

**In:** programs as assets (form `program`, with their source); object
records with an input and an interval; the hub as the only host, with
fuel metering, a memory limit, a time limit and its guarded fetcher; the
two whitelists (§7 of the compute spec); the `weather` type; the
`object` entity in the live model; a badge on the map and a line in the
BBS door; an object's own page showing its record, manifest, source and
credit; limits per owner; blocking an object, a program or an owner.

**Out, for later:** calls between objects (compute §2.5); switching
looks and moving (§5.4); raising events (§11.1); zones (§4.4); running
anywhere but the hub (headless leaves, BBSes, people's machines); the
technical view; checking that a source rebuilds into its module (the
page shows the source as its author's word, and says so); objects
published by people rather than boards (they need the hub to write to
their repo, or a tool of their own); 3D looks for objects.

## 2. Decisions for the owner

Each has a recommended answer. **All ten were accepted as recommended
(2026-11-27).** Every limit is a default in the hub's config, not fixed in
code, so each hub's admin sets their own.

| # | Decision | Recommended |
|---|---|---|
| 1 | **The runtime.** The spec leaves it open (compute §13): Node's own WebAssembly, or Wasmtime, which counts fuel itself but needs a native add-on or a separate service | **Node's own**, in a worker thread, with fuel counted by **instrumenting each module when it's loaded**: the hub's own small rewriter (TypeScript, as its glTF and PNG checkers are) adds a fuel counter that every function entry and loop start charges for the instructions up to the next branch, and that stops the step when it runs out. The worker also has a hard time limit and is replaced if it's hit. Same module, same rewriter: same fuel on any host |
| 2 | **How a step fetches.** WebAssembly can't wait for the network inside a call | **Ask, then step.** A step returns what it wants fetched (at most 2 requests); the hub fetches them (guarded, whitelisted, size-limited), and the next step gets the replies as inputs. Each step stays a pure function of its inputs, which checking and moving need later (compute §2.4) |
| 3 | **The program's language** | **AssemblyScript** (TypeScript-like, Apache 2.0), pinned, as a development dependency for building the framework's own programs, never in the hub at run time. Any language that compiles to WebAssembly works for others' programs |
| 4 | **Who may have objects** (the owner's decision: anyone registered with the hub, within configured limits) | `compute.owners`: `registered` (people and BBSes registered with the hub) or a list. In this slice only **boards** publish objects, as only the fork has a publishing tool; the hub reads people's records the same way once they have one |
| 5 | **Whose programs the hub runs** | Only **vetted programs, by hash** (`compute.programs`), at first only the framework's weather program. Anyone may still make an object from it; running others' programs waits for the runtime to have been tried and reviewed |
| 6 | **Limits** | Defaults, each a setting in the hub's config (§3): `compute.perOwner.objects`: 3. `compute.minInterval`: 600 s (an object may ask for slower, never faster). Per step: 50 million fuel, 1 MB of memory (16 pages), 2 s, a 16 KB reply per fetch (*lowered from 64 KB in stage 2*: Open-Meteo's replies are about 600 bytes, and a program's memory, never freed, must hold the reply several times over), 2 fetches. `compute.maxObjects`: 50 in all, under Open-Meteo's 10,000 calls a day (decision 9) |
| 7 | **The whitelist** | `compute.fetch`: `api.open-meteo.com` and `geocoding-api.open-meteo.com`, https only, through the hub's existing guarded fetcher (`net.ts`: public addresses only, checked as it connects). The program's manifest must name each site too |
| 8 | **The badge** | A weather symbol (from the WMO code) and the temperature, °C or °F as each viewer chooses, in the owner's area of the map (a board's box; a person's objects beside them, while they are shown). Its object page credits "Weather data by Open-Meteo.com" with the link, as their licence asks, and GeoNames for a place found by name. Greyed, with "not updated since …", when stale |
| 9 | **Open-Meteo's terms** | Their free service is for non-commercial use, which the hub is; the data is CC BY 4.0, credited with a link next to it wherever it shows (the badge's page, and its title on the map); 10,000 calls a day from one address, which `compute.maxObjects` keeps under (50 objects at ten minutes is 7,200). The privacy notice gains a line before it's on: the hub sends the places in object records to the services their programs use, and Open-Meteo keeps coordinates in its logs for 90 days |
| 10 | **On the public hub** | Built and tested on a scratch hub first; on the public hub, off (`compute.enabled`) until the privacy notice has its line, then on for test2 only |

## 3. Shapes

**The program** (`nexus.cyberspace.dev.asset.item`, as art and models
use), rkey the module's SHA-256. Two versions, the module and its
source, and the manifest (compute §2.2) in the record:

```json
{
  "name": "Weather (Open-Meteo)",
  "kind": "program",
  "licence": { "id": "BSD-2-Clause", "url": "https://opensource.org/license/bsd-2-clause" },
  "credit": { "author": "Cyberspace Framework" },
  "description": { "short": "The current weather for a place, from Open-Meteo" },
  "manifest": {
    "fuel": 50000000,
    "memory": 1048576,
    "rate": { "interval": 600 },
    "fetch": ["api.open-meteo.com", "geocoding-api.open-meteo.com"],
    "input": { "name": "string(100)?", "latitude": "number(-90,90)?", "longitude": "number(-180,180)?" },
    "values": "weather",
    "trust": "shared",
    "source": { "language": "AssemblyScript", "compiler": "assemblyscript@0.28.20", "build": "asc weather.ts -O3 --runtime stub --use abort= --maximumMemory 16 --exportStart _initialize" }
  },
  "versions": [
    { "form": "program", "file": { "sha256": "…", "size": 9123, "mediaType": "application/wasm" }, "blob": { "…": "…" } },
    { "form": "source", "file": { "sha256": "…", "size": 4210, "mediaType": "text/plain" }, "blob": { "…": "…" } }
  ]
}
```

**The object** (`nexus.cyberspace.dev.object`), any rkey:

```json
{
  "title": "Weather in Portland",
  "program": { "sha256": "…", "uri": "at://did:plc:…/nexus.cyberspace.dev.asset.item/…" },
  "input": { "name": "Portland, Oregon" },
  "interval": 600,
  "look": "badge",
  "createdAt": "2026-11-27T…"
}
```

`input` is the program's, checked against its manifest's `input`; this
one by name (the program looks it up once with the geocoder and keeps
the coordinates in its working state), or `{ "latitude": 45.52,
"longitude": -122.68 }`.

**The `weather` type** (values a weather object sets, each optional, any
outside its limits dropped alone):

| Value | Type and limits | From Open-Meteo's `current` |
|---|---|---|
| `temperature` | °C, -90 to 60 | `temperature_2m` |
| `precipitation` | mm in the last hour, 0 to 500 | `precipitation` |
| `code` | WMO weather code, 0 to 99 | `weather_code` |
| `cloudCover` | %, 0 to 100 | `cloud_cover` |
| `windSpeed` | km/h, 0 to 500 | `wind_speed_10m` |
| `windDirection` | degrees, 0 to 360 | `wind_direction_10m` |
| `isDay` | true or false | `is_day` |
| `observedAt` | a time, not in the future, not over a day old | `time` |
| `place` | a label, 60 characters, plain text | the geocoder's name, or the input's |

**The host interface** (imports from module `cyberspace`; strings as
UTF-8 in the program's memory, given as pointer and length):

| Import | What it does |
|---|---|
| `input_len()`, `input_read(ptr)` | The step's input as JSON: `{ "input": …, "state": …, "replies": [ { "status", "body" } ], "time": "…" }` |
| `fetch(url_ptr, url_len)` | Asks for a URL for the next step; refused (returns -1) if either whitelist says no or the step has asked for 2 |
| `values(ptr, len)` | The object's new values, as JSON, checked against its type |
| `keep(ptr, len)` | Its working state for the next step, at most 4 KB, never shown to anyone |
| `log(ptr, len)` | A line for its owner (kept in memory, the last 20) |

The program exports `memory` and `step()`, and may export
`_initialize()`, which the hub calls once after loading it, metered like
a step (AssemblyScript sets up its memory there, built with
`--exportStart _initialize`; stage 0, trials.md §2a). Nothing else is
imported: a module that imports anything else, has no memory limit or
one over the manifest's, uses threads, shared memory or SIMD, or doesn't
validate, is refused. A `start` section is refused too, so nothing runs
outside a metered call.

**The hub's config** (`compute`, all off by default): `enabled`,
`owners`, `programs` (vetted hashes), `fetch` (sites), `perOwner.objects`,
`minInterval`, `maxObjects`, `perStep` (`fuel`, `memory`, `ms`,
`fetchBytes`, `fetches`).

**The live model:** an `object` entity (live model, entities):
`{ id: "object:<did>/<rkey>", owner, title, kind: "weather", zone: null,
look: { badge: true, credit: { text, url } }, values, updatedAt, stale,
record }`.

## 4. Stages

0. **Trials** (no hub changes; **done** 2026-11-27, trials.md §2a): the rewriter's approach on a hand-written
   module (fuel counted the same in two runs, a loop stopped at its
   limit, a deep recursion stopped by the stack, a worker past its time
   replaced); one Open-Meteo request by name and one by coordinates,
   with the reply's size and shape kept as a test fixture.
1. **The runtime** (**done** 2026-11-27: `wasm_meter.ts`, `program.ts`, `program_worker.ts`, 24 tests, real AssemblyScript output among them): checking a module,
   instrumenting it, running a step in a worker with its limits, the host
   interface. Tests with hostile modules: endless loops, huge memory,
   forbidden imports, a `start` function, malformed bytes, a fetch
   outside the whitelist, values outside the type.
2. **The weather program** (**done** 2026-11-27: `programs/weather/`, AssemblyScript, 20 KB; 8 tests run it against Open-Meteo's real replies and the worst replies a 16 KB limit allows, none making it trap; two builds from a clean copy gave the same hash): built
   reproducibly, its hash recorded; tested against the fixtures, with no
   network.
3. **Records and the hub's reading** (`board_objects.ts`): programs and
   objects from linked boards, as models are read (H25), with the same
   care: withdrawn records dropped, a changed record read again, limits
   per owner; blocking (`hubctl compute block`).
4. **Running and showing:** the scheduler (each object at its interval,
   within the limits, stale after three missed), the `object` entity in
   the live model, the badge on the map, a line in the door, and the
   object's page with its source and credit.
5. **The fork:** `atProto.publishing` gains programs and objects, as it
   has models. Then a scratch hub, then the public hub for test2
   (decision 10).

**Done when** test2 publishes "Weather in Portland" from its own account,
and everyone on the hub's map sees the current weather there on test2's
box, updating every ten minutes, with the object's page showing the code
that fetched it.

## 5. Security

The program is someone else's code running on the hub, so this slice is
reviewed as the 3D one was, by an outside reviewer, before it is turned
on anywhere public. What it relies on:

- **Node's WebAssembly sandbox** for memory safety: kept up to date with
  Node's security releases. The worker runs with no access to the hub's
  files, environment or network; only the host interface crosses.
- **The rewriter** for fuel: a mistake in it costs the hub time, not
  safety, and the worker's time limit catches what it misses.
- **The guarded fetcher** for the network: https only, public addresses
  checked at connect time, sizes and times limited, and only sites on
  both whitelists. Redirects are not followed.
- **The live model's checks** for what is shown: values against their
  type, labels as plain text (as chat is), a rate per object.
