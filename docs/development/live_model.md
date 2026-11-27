# The live model, version 1 (draft)

The hub's live model of its common space (hub plan H16,
[vision](https://github.com/zerosquaredio/cyberspace-framework/blob/main/docs/vision.md)
§8.3): who is there, where, and who is together, sent as a stream, never as
AT records. Views render it: the hub's map (H17), the BBS door (F19), and
later others. This is the first draft of the small core every hub serves.
Its names are the development ones, `nexus.cyberspace.dev.space.*`, until
the shapes are final.

## Connecting

A WebSocket to `/space/live` on the hub's own address, from the hub's own
pages, with the person signed in. The hub accepts it only for someone the
join rule lets into the space, and closes it with code **4403** when that
stops being true (signed out, or no longer a member). A client shouldn't
reconnect after 4403.

A BBS can open the same stream for one of its members, to show the space
inside the BBS (its door): a WebSocket to `/api/bbs/live?bbs=<name>&did=<did>`
(or `&user=<name>` for a member with no AT account), with
`Authorization: Bearer <its tunnel token>` and no `Origin`. The hub accepts
it for a member the BBS reported, on a BBS that is up and shown on this hub,
who may join; `you` is how the model knows that member, which is their DID
only once they confirmed that BBS at the hub.

A browser may send one kind of message, saying which board the viewer has
opened from the hub's page (or `null` when they close it):

```json
{ "$type": "nexus.cyberspace.dev.space.at", "place": "leaf:coolbbs" }
```

The hub shows them there (`source` `hub`, below) while their presence is
on, the board is online, and the connection stays open. It is the viewer's
own word about themselves. Anything else a client sends is ignored, and so
is more than 20 messages a minute.

## Messages

JSON text frames. Every message has `$type`, `version` (1) and `seq`, which
counts up across the hub's messages.

**Snapshot,** first, and only once per connection:

```json
{
  "$type": "nexus.cyberspace.dev.space.snapshot",
  "version": 1,
  "seq": 12,
  "you": "person:did:plc:...",
  "entities": [],
  "presence": [],
  "groups": [],
  "links": []
}
```

`you` is the id of the viewer's own person. It is in `entities` only while
they are shown (not with their presence off, for example).

**Change,** whenever something changes:

```json
{
  "$type": "nexus.cyberspace.dev.space.change",
  "version": 1,
  "seq": 13,
  "put": { "presence": [] },
  "remove": { "entities": ["person:..."] }
}
```

`put` holds whole items, new or replacing the item with the same `id`;
`remove` holds ids. Only collections that changed appear. Applying changes
in order to the snapshot gives the current state. A client that falls far
behind is disconnected, and a new connection starts with a fresh snapshot.

## The state

Four collections, each a list of items with an `id`. Unknown fields and
unknown types must be ignored, never treated as an error: the core only
grows within a version.

**entities**

| `type` | Fields | Notes |
|---|---|---|
| `person` | `label`, `did`, `kind`, `picture` | `kind`: `account` (signed in to the hub, or a BBS they confirmed), `via` (a BBS's word, unconfirmed: `label` is "name via bbs", `did` is null), `vouched` (a BBS member with no AT account: "name@bbs"). `picture` is their Bluesky profile picture as the hub serves it (`url` on the hub, `width`, `height`), for `account` people who haven't turned it off, or null (added 2026-11-26, a field a version 1 viewer may ignore) |
| `leaf` | `name`, `title`, `url`, `online`, `terminal`, `emblem` | A BBS on this hub. `title` comes from its listing, if it has one; `online` is whether its tunnel is up; `terminal` is the hub's web terminal for it, or null; `emblem` is its small picture for the map (`url` on the hub, `width`, `height`, `label`), or null (added 2026-11-26, F21; a field a version 1 viewer may ignore) |
| `room` | `name` | The chat room |
| `zone` | (planned) `name`, `title`, `owner`, `open`, `exits` | A zone of the common space ([compute spec](compute.md) §4.4; world.md §2.1): `owner` the person or group holding it, or null for the hub's own; `open` false while its place is away; `exits` the zones it leads to. Each viewer is sent the objects, presence and signals of their own zone, and the zones themselves |
| `object` | (planned) `owner`, `title`, `kind`, `zone`, `position`, `look`, `values`, `updatedAt`, `stale`, `record` | A live object ([compute spec](compute.md) §1.1, §1.2): `owner` is a person or leaf id; `kind` its shared value type, if it has one (`weather`); `zone` the zone it is in, or null for the common space; `look` what to draw (a model, a badge) with its credit; `values` its state, the settings its program sets (§5.2), checked against its record's declaration; `stale` once it has missed three updates; `record` its AT record's URI, for its page. Where its program runs is never sent. First built for the weather slice ([build_live_object_slice.md](build_live_object_slice.md)) |
| `feed` | (planned) | A live data feed from a leaf, such as the weather in a town: its type, place and current values ([compute spec](compute.md) §10). Not built yet. In the compute spec's one model of a live object (§1.1) this is an `object` whose values come from the world, so it may be carried as one |

*Planned too:* **live events** ([compute spec](compute.md) §11), such as a
market opening, which a place makes from the feeds it listens to: sent
once as their own message (`signal`, so as not to be confused with a
BBS's calendar events) to the people in that place, with their type, the
place and feed, the time and how long they stay news, never kept in the
state. A signal goes to one zone, or, for the hub's own global ones, to
everyone.

**presence:** `person`, `place` (a leaf or room id), `since`, and
`source`: how the hub knows (`bbs`, the BBS's report; `hub`, a board opened
from the hub's page; `chat`, the room). One item per person per place; when
a BBS and the hub's page both say so, the BBS's report is the one shown.

**groups:** `place`, `members` (person ids). Who is together: for now,
who is in the room.

**links:** `from`, `to`, `kind`. None yet; reserved for links between
people and things. (*Planned, 2026-11-27*) The **technical view** draws
them (world.md §2.2): `kind` `fetch` (an object and a site it reads,
`to` being the site's host name), `call` (an object and one it calls),
`feed` (a feed and the zone or object following it), `event` (an object
and the zone that takes its events). Links between objects, zones and
sites go to anyone who may see both ends; a link to a **person** (the
objects or agents they use) goes only to that person unless they make it
public.

## Who appears

The same rules as presence (hub plan H14): only people whose own setting
is on, only from BBSes that are connected, reporting, and rated for this
hub, and a BBS's unconfirmed word about a DID is never tied to that DID.
Someone in the chat room appears there only with their hub presence on.
Someone the hub's admin blocked from the space is in nobody's state
(hub plan H18). The state differs between viewers only by whom each one
muted: those people are left out of that viewer's state, from the
snapshot on, and nobody else's. A viewer who mutes or unmutes someone gets
an ordinary change. A BBS's door has mutes only for members the hub knows
as themselves (they confirmed that BBS).

When the hub closes a stream with **4403**, its reason says why:
`blocked by the admin of <hub>` if the admin blocked them, otherwise
`access ended`. `seq` still counts up, but a viewer may see gaps in it.
