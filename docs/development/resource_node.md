# Resource Node Spec

Status: Draft (ideas, not yet built)
Last updated: 2026-11-26

A **resource node** is a leaf with no front end: a program that BBS
sysops, or anyone, can run on their own machine or server. It connects to
a hub through a tunnel, as a BBS does, and offers its owner, and whoever
the owner allows, three things:

- **storage:** files for the space, the owner's own or kept for other
  people, as a BBS keeps its members' files;
- **compute:** the backends of objects in the space, and programs those
  objects run, with controlled access to the internet;
- **agents:** AI agents working for their owner, privately or present in
  the space like a person.

It brings together ideas the
[vision](https://github.com/zerosquaredio/cyberspace-framework/blob/main/docs/vision.md)
has in separate places: the "small companion program" that runs an
object's backend on its owner's computer and trust groups sharing
computation (§8.8), and agents (§8.5). It hosts assets the way a leaf does
([assets spec](assets.md) §4.3, §5).

## 1. Overview

- **A leaf with no front end.** The node connects through a tunnel of
  its own, with a registration and a token of its own (kind `node`, §3),
  and links to the hub with its own AT account, as a BBS does. It never
  shares a BBS's token: a break-in on the node must not take the board
  with it. It has no terminal, so the hub doesn't route terminal sessions
  to it or put it on the map as a board.
- **A program of its own,** not part of the BBS (§3). It can run beside a
  BBS on the same server, and the BBS configures it when it's there.
- **Every role is off until its owner turns it on,** and everything not
  allowed is denied (§4). The smallest useful setup serves only its
  owner.
- **What it holds stays on it.** The owner's sign-ins to other services,
  their folders and their agents' model keys never go to the hub, to
  objects or to agents. Only results do, and only where a rule allows.
- **The owner pays and answers for it.** It runs on their machine, uses
  their accounts, and they are responsible under the hub's terms for what
  it does, as a sysop is for their board.
- **It can also be given to everyone:** compute, storage and bandwidth
  offered to the hub's pool, counted and recognised with contributor
  awards ([compute spec](compute.md) §9), and live data feeds, such as a
  weather station, that show up in the world as objects (compute spec
  §10).

## 2. Identity and linking

- **The node has its own AT account,** so anything it does is traceable
  to it and visibly not done by a person. Each agent can have one too
  (§7.1).
- **Serving only its owner needs no public record.** The owner registers
  the node with the hub while signed in, as a sysop registers a board, and
  the hub keeps the link privately.
- **Offering anything to others is public.** The node publishes a listing
  of kind `node`, naming its owner. The owner publishes a record naming the
  node. The link counts only when both records exist, as with a board
  linking to a hub. The owner cuts the node off by deleting their record.
- **Leaving out the owner's real location.** The records link two
  accounts, never an address; the hub knows the node's IP address, as it
  knows a board's, and keeps it to itself.

## 3. Running it

- **A separate program, not part of the BBS.** The node holds
  credentials, files and connections to the internet. A crash or a break-in
  shouldn't take the BBS with it. It runs as its own system user, with
  access only to the folders it's given.
- **One codebase for Windows, Linux and Mac:** Node.js and TypeScript, as
  the hub's control plane already is (ENiGMA½ is Node.js too), packaged
  as a single executable. Programs people run on it are WebAssembly (§6),
  which behaves the same everywhere.
- **Beside a BBS:** the node offers a settings API on the machine's own
  loopback address, guarded by a token in a file only the BBS's user can
  read. ENiGMA½ finds it there and adds a sysop screen for it. Without a
  node, the screen isn't shown (development plan F22).
- **On its own:** the owner configures it through a page it serves on
  loopback only, opened in their browser, and through its config file.
- **That page and the settings API are guarded like a site,** because any
  web page the owner visits, and any other user of the machine, can reach
  a loopback port: a token for every request (given to the browser once,
  from a link the node prints), requests refused unless their `Host` is
  the loopback address and their `Origin` the page's own (which stops DNS
  rebinding and forms posted from other sites), and nothing changed by a
  `GET`.
- **Toward the hub:** a tunnel (frp) of the same kind as a board's, with
  the node's own token, registered with kind `node`. The node opens no
  port to the internet: what people reach of it (their own drive's pages,
  §5.1) reaches it through the hub's tunnel, as a board's sign-in pages
  do, and only the paths the hub allows a node.

## 4. Permissions

The node works like a firewall: a list of rules, each allowing **who**
may do **what** with **which** resource. Anything no rule allows is
refused. A block list of people overrides every rule. How people see and
set these, as sentences with presets, is [settings_ui.md](settings_ui.md).

| Part | Is one of |
|---|---|
| Who | `owner`; a person by DID; a group the owner keeps (later, a leaf's members, vision §6.4); an agent; `room` (whoever is present where the thing is shown); `anyone` |
| Resource | a site; an account (a sign-in held on the node, §5.2); a folder; a workspace; a drive; compute; an agent |
| Action | `read`, `write`, `fetch` (from a site), `send` (mail or messages), `run`, `show` (display in the space, for now), `publish` (into the space as an asset others can use) |

Each rule can carry limits: how often, how much, which hours, and when it
expires. Every use is logged on the node, where the owner can see it,
kept for 3 months by default, as the hub's logs are.

```jsonc
{
  "rules": [
    // the owner's Twitch, shown only to the owner
    { "who": "owner", "resource": "account:twitch", "do": ["read", "show"] },
    // two friends may use the art drive and see deliverables
    { "who": ["did:plc:ana…", "did:plc:ben…"], "resource": "drive:art", "do": ["read"] },
    // the agent may read one folder and fetch from two sites
    { "who": "agent:remixer", "resource": "folder:D:/Art/Inbox", "do": ["read"] },
    { "who": "agent:remixer", "resource": "site:*.wikimedia.org", "do": ["fetch"],
      "limit": { "perHour": 60 } },
    // its deliverables go into the space only after the owner approves each one
    { "who": "agent:remixer", "resource": "drive:art", "do": ["publish"],
      "confirm": "owner" }
  ]
}
```

`show` and `publish` are different on purpose. Showing puts something on
a screen in the space for as long as it's shown, to the owner alone
unless a rule says otherwise. Publishing makes it an asset others can
use, copy or remix, under the assets spec's permissions (§7 there).

## 5. Storage

### 5.1 Folders, workspaces and drives

- **Folders** are places on the owner's machine they let the node use.
  They're read-only unless a rule allows writing. Every path is checked
  after links are followed, so nothing outside the folder can be reached,
  and hidden and system files are left out.
- **Workspaces** belong to agents (§7.2): private working folders,
  normally visible only to their owner. An owner can share a whole
  workspace with a rule, though most won't.
- **Drives** are where finished things go: deliverables, and assets the
  owner offers. A drive can be private, shared with named people or a
  group, or public.
- **Per-person storage:** a node can keep files for other people, as a
  BBS does for its members, each person with their own drive and a quota.
  People sign in to the node with Bluesky through the hub, as they sign in
  to a board on the web.

### 5.2 Into the space

Files go to the hub as a leaf's do ([assets spec](assets.md) §4.3, §5).
They're named by their SHA-256 and served at `/assets/<sha256>`. Assets
for others are published with the node's or the owner's records, or
claimed privately for one person. The hub checks and caches them as any
leaf's, so a home machine going offline doesn't take them out of the
space.

## 6. Compute and the internet

### 6.1 Programs

*How programs are placed, between the hub, people's own compute, groups,
BBSes and nodes, with their declared limits and capacity reports, is now
the [compute spec](compute.md). What follows is the node's side.*

- **Object backends:** the node is where an object's backend runs when
  its owner pays for it (vision §8.8, "the owner's own computer"). The hub
  relays its updates through the live model (vision §8.3) as for any
  remote backend. A node can also be a member's companion program in a
  trust group.
- **Programs are WebAssembly,** named by their hash and signed by their
  author's DID. The owner consents to a specific hash, as in a trust
  group; or, having chosen to give compute to everyone ([compute
  spec](compute.md) §9), to whatever the hub places there, within the
  limits they set. Each runs with a budget of instructions ("fuel") and memory, and
  can reach nothing except through functions the node gives it. Every one
  of those goes through the rules (§4).
- **Triggers:** who may start a program, from the space or by a message,
  is a rule like any other, with rate limits.

### 6.2 Reaching the internet

Unrestricted internet access would make the node an open proxy, a spam
relay or a way into the owner's home network. So:

- **Sites are a whitelist:** host names, with `https` only. Private and
  local addresses (the owner's router, `localhost`, cloud metadata
  addresses) are refused, wherever a name resolves to, unless a rule names
  one exactly. The address a name resolved to is the one connected to
  (checked once, then pinned), and every redirect is checked again as a
  new request. A wildcard (`*.example.org`) is a wide door, above all for
  agents (§7): an agent steered by text it read could send data out in a
  URL to any name under it, so wildcards are flagged when a rule for an
  agent uses one, and such rules can be limited to reading.
- **Accounts:** the owner signs in to services such as Twitch and Dropbox
  on the node's own page. The tokens are kept encrypted on the node, with
  the system's own key store where there is one (DPAPI on Windows, the
  keyring on Linux and Mac). Programs and agents use an account only
  through the node, and never see its token.
- **Mail and messages** go only to the owner, or to addresses a rule
  names. Anything else needs the owner's confirmation each time.
- **Streams and videos** go from their source straight to each viewer's
  client, never through the node or the hub. That saves bandwidth and
  keeps the hub from rebroadcasting others' work. The source then sees
  the viewer's IP address, so each viewer opts in.
- **Content behind the owner's sign-in** (a subscription, a private
  folder) is shown to the owner alone unless they share it. Whether
  sharing it is allowed is between them and the service; the node marks
  what it shows with its source.

## 7. Agents

### 7.1 Who an agent is

- An agent has its **own AT account**, or acts under the node's. It is
  always marked as an agent: its name tag in the space shows that, and
  whose it is, and text views say so too.
- It uses its owner's model account, with a spending limit; the hub
  doesn't pay for it (vision §8.5).
- It can work privately, reached only from the owner's page or messages,
  or be **present in the space** with a look, a voice and a place, like a
  person.

### 7.2 Workspaces and deliverables

- Each agent has a **workspace,** the only place it can write. It reads
  what rules allow: the owner's folders, drives, sites, and assets in the
  space.
- **Remixing** goes through the same tools and permissions as anyone's
  (assets spec §7). It copies only what the author's permissions allow,
  and every result carries its sources and credit.
- Finished work goes to a **drive as a deliverable,** by a rule or the
  owner's approval. From there it reaches the space only where a rule
  allows `publish`. Most owners will have it ask first.
- Its changes to shared things are marked as an agent's, and can be
  undone.

### 7.3 Who it listens to

An agent's model can be steered by anything it reads (prompt injection).
An instruction such as "only listen to Ana" is unreliable, because the
model can be talked out of it. So the node decides **in code** what
reaches the model at all:

- **Instructions** come only from its owner and the people a rule allows,
  identified by their signed-in DIDs, not by names in the text.
- **What it hears in the space** is filtered the same way. Speech from
  anyone else never reaches the model; at most, the agent is told that
  someone else is present. Text on objects reaches it only if an allowed
  person made the object.
- **Everything it reads is data, not instruction:** web pages, files,
  assets, and allowed people's quoting of others. This is what filtering
  can't cover, so the agent's actions still go through the rules (§4),
  however convincing the text that prompted them. Its tools are only what
  its task needs.
- **A stricter setting:** the owner can make the agent take part only
  while everyone present is allowed. When someone else arrives, it goes
  quiet: it stops listening and acting, and its name tag shows it's
  paused, until they leave or an allowed person admits them.

### 7.4 The hub and room owners

A hub sets its own rules for agents: whether they're allowed at all, how
often they may speak or act, and where. Rooms and leaves can refuse them.
Reports can name an agent; the hub can suspend one, or the whole node,
as it suspends a board.

## 8. The hub's side

- Registration of kind `node` (hub plan H3), with its token and tunnel;
  no session routing; suspend and ban as for boards (H8).
- Assets from nodes through the assets spec's paths (§4.3, §5, §6).
- Object backends relayed through the live model (vision §8.3), with
  bandwidth and update-rate limits per object.
- Its rules, set by the hub's admin: which roles nodes may offer, which
  kinds of program are banned (mining, mass mail), and bandwidth caps.
- Terms of service: an owner is responsible for their node, as a sysop is
  for their board. The legal review's section on assets covers what
  nodes publish.

## 9. Order

1. **Storage for its owner:** the program, its tunnel and registration,
   folders and drives, assets served to the hub (with assets spec step 2).
   ENiGMA½'s settings screen (F22).
2. **The owner's own accounts and sites,** shown to the owner alone.
3. **Sharing:** drives and per-person storage for others, groups, and
   showing to the room.
4. **Compute,** once objects and their WebAssembly rules exist
   ([world.md](https://github.com/zerosquaredio/cyberspace-framework/blob/main/docs/world.md)
   §9).
5. **Agents:** working privately in their workspaces first, then in the
   space under §7.3.

## 10. Open questions

- The name. "Resource node" for now.
- Whether a node can serve a group with no hub, directly.
- Names and registration. A node needs a name under the hub's domain for
  its tunnel, sharing the BBSes' names; and the hub's rules for sysops
  (an approval queue, a minimum account age, three BBSes each) weren't
  made for anyone at all running one. Nodes that serve only their owner
  could be let in by membership, as people are let into the space.
- How "shown to the owner alone" looks to others in the space: nothing,
  or a screen marked private.
- How groups map onto a leaf's vouched membership (vision §6.4).
- Agents' voices and looks: their own assets, marked as an agent's.
- Which model providers to support first, and how spending limits work
  with each.
