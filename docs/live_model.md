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
reconnect after 4403. Clients send nothing; the hub ignores what they send
apart from WebSocket control frames.

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

`you` is the viewer's own person, or `null` if they aren't shown (their
presence is off, for example).

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
| `person` | `label`, `did`, `kind` | `kind`: `account` (signed in to the hub, or a BBS they confirmed), `via` (a BBS's word, unconfirmed: `label` is "name via bbs", `did` is null), `vouched` (a BBS member with no AT account: "name@bbs") |
| `leaf` | `name`, `title`, `url`, `online` | A BBS on this hub. `title` comes from its listing, if it has one; `online` is whether its tunnel is up |
| `room` | `name` | The chat room |

**presence:** `person`, `place` (a leaf or room id), `since`.
One item per person per place.

**groups:** `place`, `members` (person ids). Who is together: for now,
who is in the room.

**links:** `from`, `to`, `kind`. None yet; reserved for links between
people and things.

## Who appears

The same rules as presence (hub plan H14): only people whose own setting
is on, only from BBSes that are connected, reporting, and rated for this
hub, and a BBS's unconfirmed word about a DID is never tied to that DID.
Someone in the chat room appears there only with their hub presence on.
Every viewer currently sees the same state; blocking (H18) will make it
differ per viewer.
