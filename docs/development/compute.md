# Compute Spec

Status: Draft (ideas, not yet built)
Last updated: 2026-11-26

Where the work behind live objects in the space gets done: an animated
model, a simulation, a 3D infographic driven by streaming data. One
program runs wherever there is room for it: on the hub, on its owner's
own computer, on their group's, on a BBS or a resource node. The hub
places each program, within limits its admin and every place's owner set,
and moves it when things change.

It gathers what the
[vision](https://github.com/zerosquaredio/cyberspace-framework/blob/main/docs/vision.md)
says about object backends and the live model (§8.3) and trust groups
sharing computation (§8.8), and what the [resource node spec](resource_node.md)
(§6.1) and the [assets spec](assets.md) say about programs and models.
The idea grew from looking at live 3D explainers such as an animated
mechanical watch, whose parts and motion are computed rather than stored.

## 1. Overview

- **Data drives what's drawn; code never touches a viewer's page.** A
  program computes an object's **state**: named values its model declares
  it can take (§5). The hub carries that state to viewers through the live
  model, and each viewer draws the object from its model file. An author's
  code reaches a viewer's browser only as a sandboxed motion program
  (§5.3), with nothing to reach.
- **One program, any place.** Programs are WebAssembly, named by their
  hash and signed by their author's DID (resource node §6.1). The same
  program runs on the hub, a BBS, a resource node, or a person's computer,
  and gets the same answers from the same inputs.
- **Programs say what they need, and are held to it** (§2). What they
  declare is a ceiling they can't exceed, so the hub can plan on it.
- **Every place says what it offers** (§3), in the same measure.
- **The hub places programs** (§4): itself first when it has room, for the
  fastest, most consistent experience; then the program's owner's own
  compute, their group's, their BBS's, and so on, in an order its admin
  sets. It moves them as load and places change.
- **Who may say what an object is like** depends on where its program runs
  (§6): shared state comes only from places trusted for it.
- **Anyone can give** compute, storage or bandwidth to everyone, counted
  and recognised with contributor awards (§9), and **live data** from the
  real world: feeds, which are states such as the weather (§10), shown as
  objects; places listen to the feeds they choose and turn their changes
  into live events, moments such as a market opening (§11), which objects
  and looks react to.
- **Everything is off until turned on,** on the hub and on every place.

## 2. Programs

### 2.1 What a program is

A WebAssembly module with no access to anything but the functions its host
gives it: read its inputs, read and set its object's state, fetch from the
sites its rules allow (through the host, §7), log. No clock but the one the
host gives, no randomness but a seeded one, so that a step can be repeated
anywhere and give the same result (§6.2).

It runs in **steps**: each update (a tick, an input, a message) is one call,
which reads the object's state and its inputs and sets new state.

### 2.2 Its manifest

Published with the program, as part of its record (an asset of kind
`program`, assets spec §2), and signed with it:

| Field | Meaning |
|---|---|
| `fuel` | The most computing per step, in fuel: WebAssembly instructions, counted by the host |
| `memory` | The most memory it uses |
| `rate` | Steps per second it wants, and the fewest it can live with |
| `fetch` | The sites it reads, and how much a minute |
| `state` | The size of its state, for moving it (§4.3) |
| `trust` | Whether its state is shared (everyone sees it) or local (each viewer's own), §6 |

### 2.3 Held to it

Every host counts fuel as the program runs. A step that runs out of its
declared fuel is stopped, and the object keeps its last state; memory past
its declaration fails the allocation. So the manifest is a ceiling the
program can't break, not an estimate. A wrong or dishonest manifest hurts
only that program: it gets stopped, or placed somewhere too small.

Fuel counts instructions, so it is the same for the same work on any
machine. That makes it the unit for everything here.

## 3. Places and what they offer

### 3.1 Kinds of place

| Place | Runs | Paid for by |
|---|---|---|
| **The hub** | Programs its admin allows, within its budget | The hub's operator |
| **A person's own compute** | Their programs, and what they offer others: a companion program on their computer, or their resource node | The person |
| **A group's** | Programs of a BBS group's members: members' companion programs pooled (vision §8.8) | The members |
| **A BBS** | Its members' programs, if its sysop offers compute | The sysop |
| **A resource node** | Its owner's programs, and others' as its rules allow (resource node §4) | Its owner |
| **A viewer's browser** | Local work only: smoothing, motion programs (§5.3) | The viewer |

### 3.2 What each reports

Each place, BBSes and headless leaves included, tells the hub what it
offers, in its regular report (as BBSes report presence each minute,
development plan F18), and when that changes:

- **Capacity:** fuel per second it offers, memory, how many programs at
  once. Machines differ in speed, so each finds its own fuel per second
  once with a short calibration, and again when its hardware changes.
- **Whose programs:** its owner's only, a group's, a BBS's members',
  anyone the hub places, or named authors only.
- **When:** its hours, for places not always up.
- **Load:** what it is running now, and how much of its offer is free.

### 3.3 Checked, not believed

A report is a claim. The hub watches how places do: steps answered late or
missed, programs lost, results that don't match (§6.2). A place that does
worse than it says is given less, or nothing, until it does better.

## 4. Placement

### 4.1 Planning on ceilings, then on measurements

To place a program, the hub needs to know what it will cost. It starts
with the manifest's ceiling (§2.2), and keeps a record, by the program's
hash, of what it actually uses: typical and peak fuel per step, and how
that changes with its inputs (a data stream that gets busier makes a
step dearer). Placement plans on measured use with the ceiling as its
bound, and leaves headroom, a share of every place's capacity kept free.

### 4.2 The order

For each program, the hub tries places in order and takes the first with
room. The default order, each step of which the hub's admin can turn off or
move:

1. **The hub**, within its budget (§8): fastest, and one state for
   everyone without relaying through another place.
2. **The program's owner's own compute.**
3. **Their group on their BBS** (a trust group).
4. **Their BBS.**
5. **The pool:** resource nodes and BBSes their owners give to everyone
   (§9).
6. **Nowhere:** the object runs at its lowest rate, or freezes with a note,
   until room comes.

A program's owner can narrow this (never on the hub, say, or only on their
own node), and a place can refuse any program it doesn't want. A program
whose state is local (§6.1) can also run in each viewer's browser.

### 4.3 Moving

When a place fills, goes away or does badly, or a better one frees up, the
hub moves the program: it takes the last state (kept in the live model,
which carries every object's state anyway), starts the program at the new
place with it, and switches over between steps. Viewers see at most a
missed update. Programs that keep large state say so (`state`, §2.2), and
are moved less readily.

### 4.4 What stays hard

- **Spikes.** A sudden flood of input can need more than any place has.
  The program is held to its ceiling per step, and runs fewer steps rather
  than starving its neighbours.
- **Drawing.** Graphics in a browser aren't counted in fuel. Models keep
  their budget classes (`light`, `standard`, `full`, assets spec §2), and
  each viewer takes the class their device can draw.
- **Fairness.** Quotas (§8) keep one owner from filling the hub; how
  they're shared among many is a policy each hub sets, and will need
  tuning with use.

## 5. Driven models

### 5.1 Settings a model declares

A model (glTF, assets spec §2) names what about it may change, with
limits: a part's position, turn or scale within a range; a colour from a
set or a range; a morph's weight; a text label of so many characters; an
animation of its own to play. Its program can set only those, and a
viewer applies only those. Anything else in the state is ignored.

The same object then works in every view: the 3D view draws the model;
the 2D map a simpler picture with the same values; the ANSI door the
label and the values as text.

### 5.2 State through the live model

An object's state is a small set of those settings, carried as an
`object` entity's `state` in the live model ([live_model.md](live_model.md)),
as changes: only what changed, at most at the object's rate and the hub's
limit per object. A 3D infographic fed by a data stream sends "bar 3:
height 0.72, colour amber, label 41%" a few times a second; a watch's gear
train sends its time. Viewers smooth between updates, so a few a second
still moves fluidly at a browser's frame rate.

### 5.3 Motion programs

For motion that has to be worked out every frame, such as a balance wheel
on its hairspring, a model may come with a **motion program**: WebAssembly
that turns time and the object's state into its parts' poses, nothing
else. It runs in the viewer's browser in a sandbox (a worker with no
access to the page, the network, storage or sign-ins), with a fuel limit
per frame, and only if the viewer's settings allow it. Without it, the
model plays its own stored animations, or holds still between updates.

## 6. Trust in results

### 6.1 Shared and local

- **Shared state,** which everyone sees and which may matter (a score, who
  owns what, a reading shown as fact), comes only from places trusted for
  it: the hub, the object's owner's own compute, and a BBS or resource
  node the owner chose.
- **Local state,** which only changes one viewer's own view (smoothing,
  effects, a view of their own), can be worked out anywhere, the viewer's
  browser included.

### 6.2 Checking

Work placed on a group or on others' compute, for shared state, has to be
checked. Steps are repeatable (§2.1), so the hub can run the same step in
two places, or on itself now and then, and compare: a place whose results
differ loses the work and its standing (§3.3). The vision's trust groups
(§8.8) are the way in: people who choose to share compute with each other
and accept that.

## 7. Data from outside

A program reads outside data (a feed, a sensor, an API) only through its
host, from sites its rules allow (resource node §6.2): `https` only,
private and local addresses refused, sizes and rates limited, and every
read counted against the place's bandwidth. On the hub, that is the hub's
own guarded fetcher, as the directory uses, and its share of the hub's
bandwidth (§8). Video and other heavy streams go from their source straight
to viewers, never through the hub (resource node §6.2).

## 8. The hub's settings

| Setting | Meaning |
|---|---|
| `compute.enabled` | The hub runs programs at all. Off by default |
| `compute.budget` | Fuel per second and memory the hub gives programs in all |
| `compute.perProgram` | The most fuel per step, memory and steps per second for any one |
| `compute.perOwner` | Quotas for each owner (a person, a BBS) |
| `compute.authors` | Whose programs the hub runs: DIDs, vetted program hashes, or anyone |
| `compute.fetch` | Sites programs on the hub may read, and their share of bandwidth |
| `compute.order` | The placement order (§4.2), and which steps are on |
| `compute.objectRate` | The most state updates a second the hub relays for an object |
| `compute.openEvents` | Whether places may leave their events open to everyone (§11.4) |
| `compute.headroom` | The share of each place's capacity kept free |

Running others' code, even in a sandbox, is a risk the hub takes on: a flaw
in the WebAssembly runtime would be a way in. So it is off by default, and
a hub that turns it on should start with programs it has vetted, or
authors it trusts, and keep its runtime up to date.

## 9. Giving to everyone: compute, storage and bandwidth

Anyone can run a leaf for **general use**, not only for their own objects:
a resource node, or a BBS, offered to the hub's pool to run anyone's
programs, keep anyone's files, or carry anyone's traffic, so the world
runs more smoothly, holds more objects, or shows more detail. It is like
volunteering a computer to a science project, and is recognised the same
way.

### 9.1 What can be given

- **Compute:** a place whose report (§3.2) says "anyone the hub places".
  The hub puts programs there after its own budget and before refusing
  (§4.2). It suits local work (§6.1) and checked work (§6.2); shared state
  that isn't checked stays with trusted places.
- **Storage:** room for others' files, assets above all. Files are named by
  their hash (assets spec §3), so a copy anywhere is as good as the
  original, and anyone can check it. A giver keeps copies of files the hub
  asks them to hold, and the hub checks now and then that they still do
  (asking for a hash over a random part of a file it knows).
- **Bandwidth:** serving those copies to viewers, as a mirror. The live
  model can give a client a mirror's address with the file's hash (assets
  spec §6.4), and the client checks what it gets. That takes load off the
  hub and off small account hosts. A mirror sees the viewer's IP address,
  so viewers choose whether to use mirrors at all.
- **Paying toward costs,** for those who'd rather: later, with payment
  (H9's later part).

### 9.2 Counted, then recognised

What a giver does is measured by the hub, not taken from their reports:
fuel of steps they ran and the hub accepted (checked ones count fully),
storage held and passed in checks, bytes served that clients confirmed.
From those, the hub gives **contributor awards**: badges on a person's
profile and in the space, issued by the hub as attestations
([attestation.md](attestation.md) §4), so they can be shown and checked
anywhere, alongside the awards for art (vision §8.8, "most remixed"). The
hub's admin decides what is awarded and when, and can make it part of
membership (a group that keeps a node running, a BBS that gives compute
to its own members first).

### 9.3 Safeguards

- **For givers:** they run others' code only in the sandbox (§2), keep
  only files by hash, and set limits like any place (§3.2). What they hold
  or serve can be anyone's art, so they get the hub's moderation with it:
  a file blocked on the hub (assets spec §9) is dropped from every mirror.
  Their responsibility for others' content is a question for the terms
  (a later section, after the lawyer's look at the art section).
- **For everyone else:** a giver can't change anything, only fail. Work
  that matters is checked, files are checked by hash, and a giver whose
  results or copies don't hold up loses the work and its awards.
- **Against gaming:** awards count only measured, checked contributions,
  so offering capacity that isn't real earns nothing; many accounts
  claiming the same machine are found by checking where the work was done
  (timings, addresses) and count once.

## 10. Data feeds

A leaf can also give **live data from the real world**: the weather in its
owner's town from their own station, a river's level, a city's transit,
the sky over a telescope. A feed is a named stream of values, and it shows
up in the world as an object, so people can find it, look at it, and
build on it.

### 10.1 What a feed is

- **A feed record** in its publisher's AT repo describes it: its **type**,
  where it is (as precise as its owner chooses, §10.4), how often it
  updates, its source (an own sensor, or a named service, with that
  service's terms), and its licence.
- **Types are shared**, so anything that uses weather can use any weather
  feed: `feed.weather` has a temperature, precipitation, wind, cloud cover,
  day or night, and so on, each with units and limits. A new type is a new
  record shape, agreed as the rest are (development plan §6).
- **Values travel like an object's state** (§5.2): the leaf's program, or
  the leaf itself, sends them to the hub, which carries them in the live
  model as a `feed` object's state, at the feed's rate and within the
  hub's limits. A feed's history, when it keeps one, stays with the leaf.

### 10.2 In the world

- **As an object:** a weather station on its owner's board, a gauge by a
  river, with a model whose settings (§5.1) its own values drive, so it
  shows what it measures. Inspecting it shows its source and owner.
- **Driving places:** a place (hub plan H23) can name a feed for its
  environment: its sky, light, rain or snow follow the weather feed of the
  town it stands for, by settings its scene declares.
- **Driving looks:** a person's look can follow a feed by a simple rule,
  data and not code: "when it rains where I am, add my umbrella",
  choosing a variant or an accessory their model declares (assets spec
  §3.4, `actor.looks`). The viewer or the hub applies the rule; nobody's
  code runs for it.
- **As input to programs:** a program (§2) can read feeds as inputs, as it
  reads outside data (§7), but through the hub's copy, so many programs
  can use one feed without each fetching it.

### 10.3 Trust

A feed's values are its publisher's word, as a listing's rating is. Types
set limits (no 900° days), values outside them are dropped, and a feed
that goes stale is marked so, and things that follow it go back to their
defaults. A feed that misleads can be reported and blocked like any asset
(assets spec §9), and its publisher refused.

### 10.4 Privacy and terms

- **A location is personal.** A weather station names where its owner
  lives. The feed's place is as precise as its owner says (a town, a
  region, nothing), never their address, and the hub shows no more.
- **Others' data has terms.** Data from a service (a weather API, a
  transit agency) may not allow passing it on; the feed record names its
  source, and its publisher answers for using it within those terms.
  Data from one's own sensors is one's own.

### 10.5 As a contribution

A reliable feed is a contribution like compute or storage (§9): the hub
counts how long it stayed fresh and within its type's limits, and awards
it the same way.

## 11. Live events

A feed is a **state**: a value that is always there, which someone
arriving late sees as it is now. A **live event** is a **moment**:
something that happens once, at a time, such as a market opening, a goal,
a train arriving, an earthquake. Things react when it happens, or the
moment is gone. Events are the environment's: a place makes them, from
feeds it chooses to listen to. (Not to be confused with a BBS's scheduled events, its
calendar listings, development plan F9; the live model's message for
one is named `signal` to keep them apart.)

### 11.1 Feeds report states; environments make events

- **Feeds carry only states** (§10), discrete ones included: a market's
  status is `open` or `closed`, a match's score is a number. A feed never
  sends events into the world itself, so nobody's feed can ring bells
  across the space.
- **Each place's environment controls its events.** A place (hub plan
  H23), run by whoever owns it (the hub for its common space, a sysop for
  their board's), chooses the feeds it listens to and turns their changes
  into live events by **rules, as data**:
  - a value changing: "when the market feed's status becomes `open`,
    `market.open`";
  - a value crossing a line: "when precipitation goes above 0,
    `rain.start`";
  - a time: "at noon, `bell.noon`".

  A user-contributed feed object is just an input here: the place's owner
  decides whether to listen to it.
- **An object's owner can do the same for their own object:** a bell they
  own can follow a market feed and ring, but only in its own looks and
  sounds, not as an event for the place.
- **Types are shared and named** (`market.open`, `rain.start`,
  `sport.goal`), with a few fields each (which market, how strong). The
  names join the shared **states and events** models name their
  animations by (assets spec §2, world.md §6.3).
- **An event travels once,** as a message in the live model to the people
  in its place, with its type, the place that made it, the feed it came
  from, when it happened, and how long it stays news (a bell rings now; a
  quake may matter for an hour). It is not kept in anyone's state: someone
  arriving after it has passed doesn't get it, unless it is still news.

### 11.2 Things that react

- **By rule, as data:** an object's model can say "on `market.open`, play
  `ring`, and sound `bell`", and the viewer does it, for every bell in the
  place. Looks can react the same way ("on `rain.start`, open my
  umbrella"), and the place's own scene (a quake shakes it).
- **By program:** a program (§2) can take its place's events as inputs,
  for anything a rule can't say: count the goals, change a scoreboard.
- **Mismatches cost nothing:** an event a model has no animation for
  plays nothing, as with any event (assets spec §3.5).

### 11.3 Limits and trust

- **The place answers for its events,** since its owner chose the feeds
  and the rules; the feeds behind them answer for their values (§10.3).
  A feed that misleads a place's events can be dropped by the place, and
  reported and blocked on the hub.
- **Rate limits,** per place and per type, kept by the hub, so a jittery
  feed (a value bobbing across a line) can't turn bells into noise: rules
  can also say how long a state must hold before it counts.

### 11.4 Who may set it up

(How people set all this, as sentences and presets on each thing's own
page: [settings_ui.md](settings_ui.md).)

Connecting a feed to a place's events takes **both sides' consent**: the
feed's owner allows its use, and the place's side accepts it. Both are
rules, written the same way as a resource node's permissions (resource
node §4: who may do what, with which, within what limits), checked by the
hub, and every connection made or dropped goes in the place's log.

- **The feed's side.** A feed record says who may use it: anyone, named
  places, members of the owner's BBS, or "ask me" (each request waits for
  the owner's yes). Its owner can withdraw it at any time, and every place
  using it drops it at once.
- **The place's side:** the **environment** of a place is a role. Its
  owner has it, and can give it to others (by DID, or a group such as a
  BBS's sysops or builders). Someone with it may write the place's event
  rules and connect feeds to them; nobody else can.
- **Or automatically,** by a rule the place's environment role sets once,
  so nobody has to wire each feed by hand. For example: "for `weather`,
  use a feed from someone who is here now, is a confirmed member of this
  BBS, and offers one for a town within 50 km of the place's; prefer my
  own, then the longest reliable; drop it when they leave or it goes
  stale, and fall back to the next, or to no weather." The rule names:
  - **the types** it takes automatically (weather yes, markets no);
  - **who qualifies:** present now, members, confirmed accounts, people
    with an attestation or standing (attestation.md §5), never anyone the
    place or the hub has blocked;
  - **how to choose** among several: the owner's own first, nearest,
    most reliable (§10.5), longest present;
  - **what happens when it goes:** the next one, or the place's default.

  The person providing the feed still has to allow it (the feed's side,
  above); a feed set to "ask me" is never taken automatically.
- **Or open to everyone,** as a place's setting: anyone may connect a feed
  to its events, or anyone's feed of the allowed types is taken as it
  comes, with no rule to choose among them. Good for a sandbox or a
  playground; noisy anywhere else. What still holds, open or not: the
  feed's own owner allows it, the place's rate limits (§11.3) and the
  types it allows, blocks by the place and the hub, and the log. A hub can
  forbid open places, or allow them only where it chooses.
- **Objects follow their owners.** A person's own object (their bell, their
  umbrella look) can react to their place's events, or follow a feed
  directly for its own looks (§11.1), under the feed's rules alone; that
  needs nothing from the place, since it changes nothing but their own
  object.
- **The hub over all of it:** the hub's admin can turn events off for any
  place, block a feed or a person from providing one (assets spec §9), and
  set the limits every place works within (§8).

## 12. Order

1. **Driven models:** models that declare their settings, viewers that
   apply them (assets spec, with the first glTF slice), and object state in
   the live model. State set by hand or by a test program.
2. **Programs on the hub,** for vetted programs, with fuel metering and the
   hub's settings.
3. **Capacity reports** from BBSes and resource nodes, and placement in
   order, without moving yet.
4. **Moving** programs between places.
5. **Groups and checking** (§6.2).
6. **Motion programs** in browsers (§5.3).
7. **Giving to everyone** (§9): the pool for compute, then mirrors for
   storage and bandwidth, then contributor awards.
8. **Data feeds** (§10): a first type (weather), feed objects in the
   world, then places and looks that follow them.
9. **Live events** (§11): places' rules that turn feed changes into
   events, with the environment role and feed owners' consent, set by
   hand first, then automatically from who is present; and models and
   looks that react by rule.

## 13. Open questions

- The WebAssembly runtime for the hub and nodes (Node's own, or Wasmtime
  through a small service), and how fuel is counted in each.
- How a viewer's browser says what it can draw (budget classes), and
  whether it can offer compute at all beyond its own view.
- How fuel, calibrated per machine, stays comparable as engines change.
- Whether an object's owner can pay a hub for more than its quota, and
  how, given that payment is a later feature (H9).
- The record shapes: `program` assets, model settings, and `object`
  entities in the live model.
- What awards there are, and how they're shaped as attestations; whether
  giving earns more than recognition (a larger quota of one's own, say).
- Whether a pool can span hubs, so one giver helps several.
- Which feed types come first, who agrees new ones, and whether a feed's
  history belongs on the hub at all.
- How a place's environment role relates to roles a BBS already has
  (sysops, groups), and to places with no single owner (the common
  space, under the hub's admin).
