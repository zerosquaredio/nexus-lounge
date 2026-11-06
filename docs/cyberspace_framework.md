# Cyberspace Framework

Status: Vision (draft)
Last updated: 2026-11-06

This is the long-range picture that the other specs build toward. It records
direction and decisions, not a schedule: features become plans in
[development_plan.md](development_plan.md) and
[hub_development_plan.md](hub_development_plan.md) only when they are near.

## 1. Goal

A stylized, practical interface to the internet that recalls the cyberspace
of cyberpunk fiction: a **shared space** you and other people move around in
while you use BBSes, chats, games, and VR worlds. It is built in stages,
each useful on its own, from text terminals today toward 3D and VR spaces.

Nexus Lounge (BBSes plus a hub) is the first piece of it.

## 2. Terms

| Term | Meaning |
|---|---|
| **Leaf** | Any endpoint people connect to through a hub: a BBS today; later chats, games, VR worlds, other services. Run by its own admin (for a BBS, the sysop) |
| **Hub** | A public server that leaves register with. It is a login point and directory for users, can relay traffic to leaves through tunnels, and can host a common space ([hub.md](hub.md)) |
| **Common space** | Where people on a hub meet, whatever leaf they are using: text, voice, avatars, and later 3D environments |
| **Client tier** | What a person's client can do: web page, desktop app, VR headset. Everyone takes part at the level their client supports |

## 3. Layers and stages

| Stage | Hub provides | Users get |
|---|---|---|
| **1. Directory and tunnel** (planned: F10, F11) | Directory, handles, terminal and web traffic relayed to leaves behind firewalls | Find and connect to BBSes from one place, with one identity |
| **2. Common space, 2D** | Presence, text and voice chat, shared interfaces | A web page showing who is around; chat while connected to one or more BBSes (tiled); optionally broadcast your screen to others |
| **3. Assets** | Avatars and icons, cached and relayed | Each person shown with their own avatar or ANSI art; new users get defaults |
| **4. 3D and VR** | Environments from the hub and from leaves; real-time relay where affordable | A 3D space in the browser, a desktop client, or a headset, with a pop-up "desktop" showing your BBS sessions, chat controls, and other apps |
| **5. Hub federation** | Hubs connected to each other | One larger space across hubs |

Everyone can be present at every stage their client supports: someone without
VR still appears (as a small avatar) and can chat with people who are in VR.

Leaves may also run their own private spaces (for example a VR-only leaf)
that people use separately from the hub's common space.

## 4. Hubs and leaves

### 4.1 Offers, requests, and agreements

The relationship between a hub and a leaf is a handshake, published as AT
records so anyone can check it:

| Record | In whose repo | Says |
|---|---|---|
| **Offer** | Hub | What the hub relays, bandwidth limits, theme or community, rules, terms (free, a suggested contribution, or a price) |
| **Request** | Leaf | The leaf's services, the traffic it expects, the offer terms it accepts |
| **Agreement** | Both: one record each, pointing at the other | The leaf is carried by the hub on these terms. Either side ends it by deleting its half |

Because offers are public records, a leaf admin can browse hubs by theme,
capabilities, or price without any central marketplace. Over time leaves are
expected to move to hubs with similar leaves, more capability, or lower cost
(§6.1).

### 4.2 Money

Agreements record terms, not payments. Payment happens outside the protocol,
through whatever the hub admin uses (Open Collective, Liberapay, Stripe, …);
handling money ourselves would bring refunds, fraud, tax, and payment
provider rules into the project.

Metering is the trust problem: a leaf paying toward bandwidth can't see what
the hub measured. To start, the hub publishes per-leaf usage summaries and
leaves compare them with their own logs. Stronger measures can come later.

### 4.3 Hub software

Any hub runs the same open software, and nothing ties a leaf to one hub. A
hub and a leaf may also run on the same machine.

## 5. Transport

### 5.1 Policy: as much as the hub can carry, configurable

Ideally everything a leaf serves goes through the hub, so leaf admins need no
open ports, domains, or certificates. Whether that is affordable depends on
the hub's location and budget, so it is a policy, set per hub and per leaf:

- **Hub admin:** which kinds of traffic the hub relays, bandwidth budgets,
  per-leaf quotas and exceptions.
- **Leaf admin:** whether to offer direct addresses at all. A leaf behind a
  firewall with no domain has only the hub's relay.
- What happens is where the two overlap. When neither path exists for a
  service (the hub won't relay it and the leaf has no direct address), the
  directory says the service is unavailable rather than letting clients fail.

This is a proven pattern: Tailscale relays through its servers when a direct
path isn't possible, and WebRTC falls back to a relay server (TURN).

### 5.2 Route tables

A hub hands out **routes, not just listings**. Each leaf's directory entry
lists its services (terminal, web, assets, real-time world connection) and,
for each, how to reach it: through the hub's relay, at a direct address, or
both, in order of preference. Clients always follow the route table, so a
leaf can switch between relayed and direct without any client change.

### 5.3 Traffic classes

| Class | Examples | Relaying |
|---|---|---|
| Terminal and web | SSH, telnet, WebSocket terminals, web pages | Cheap. The planned tunnel (F10, F11). SSH stays end-to-end encrypted; telnet and plain web are readable by the hub ([hub.md](hub.md) §7) |
| Assets | Avatars, icons, ANSI art, environments | Affordable with caching: assets addressed by content hash (CID) never change, so the hub fetches each once and serves it to everyone |
| Real-time | Voice, VR positions and world state | Expensive, and needs a UDP-capable relay (TURN, QUIC, or WebTransport), because TCP tunnels add stutter. Optional per hub and per leaf |

Same-machine leaves need no tunnel: the hub proxies to a local socket.

## 6. Identity

### 6.1 Decision: every leaf has its own DID

*Proposed 2026-11-06.* This confirms the BBS account in
[publishing.md](publishing.md) §2 and extends it to every kind of leaf.

**A leaf is an AT account with its own `did:plc` DID, separate from its
admin's personal account, hosted on any PDS the admin chooses, with the admin
holding the DID's rotation key.**

Alternatives considered:

| Leaf identity | Works for firewalled leaves | Can move hubs | Problem |
|---|---|---|---|
| Hub-issued ID or address | Yes | No | The hub owns the identity; leaving means starting over |
| Its own domain | No | Yes | Excludes the admins tunnels are meant to help |
| A self-generated key pair | Yes | Yes | Reinvents DIDs, with no repo to publish records in |
| **Its own AT DID** | **Yes** | **Yes** | Needs an account on some PDS |
| The admin's personal DID | Yes | Yes | Mixes person and leaf; the leaf can't change hands; one admin's leaves collide |

What it commits us to:

- **`did:plc`, not `did:web`.** `did:web` is tied to a domain, which brings
  back the domain requirement.
- **Hosting is the admin's choice:** a Bluesky account created for the leaf
  (handle like `coolbbs.bsky.social`), the admin's own PDS, or a PDS the hub
  runs for its leaves ([hub_development_plan.md](hub_development_plan.md)
  H11). AT account migration means none of these locks the leaf in. If a hub
  hosts the account, the admin still holds the rotation key, so the hub can't
  keep the identity when the leaf leaves.
- **The leaf publishes.** It writes its listing, request, and agreement
  records, so it needs a write-capable OAuth session for its account (F9),
  beyond the identity-only login users get.
- **Hubs authenticate leaves by DID.** A tunnel proves it belongs to the
  leaf's DID (AT service auth, signed with the DID's key), and the hub checks
  that against the agreement ([hub.md](hub.md) §1.2 already has tunnels
  authenticate as the BBS's DID).
- **Hub-issued handles and addresses are conveniences, not identity.** A
  leaf moving hubs keeps its DID; its handle can change.

What follows from it:

- **Migration:** a new agreement with the new hub, the leaf's directory entry
  updated, clients following the new routes. The old hub keeps a forwarding
  note for a grace period, like an HTTP 301. Users are bound to DIDs too, so
  their accounts on the leaf don't depend on the hub.
- **Multi-homing:** a leaf may be carried by more than one hub at once (say
  a themed hub and a high-bandwidth one), if the hubs' rules allow it.

### 6.2 User identity

AT accounts (Bluesky or any other PDS) are the first identity provider for
users, as on the BBS today. They are not required to be the only one: hubs
and leaves keep identity behind an interface so a better mechanism (passkeys,
another federated identity) can be added alongside. On the BBS this already
exists as login types (`users.allowedAuthFactor1Types`).

## 7. Assets and avatars

### 7.1 Where assets live

| Asset | Where |
|---|---|
| Icons, 2D avatars, ANSI art | The user's AT repo |
| Small 3D avatars (glTF/VRM, a few MB) | The user's AT repo, if their PDS accepts the size |
| Large avatars, environments, leaf-specific art | Hosted by the leaf |
| Defaults for new users | The hub, or defaults a leaf supplies |

An asset reference is therefore either "blob in this AT repo" or "URL on this
leaf", and clients handle both.

AT blob limits (checked 2026-11-06): the protocol sets none; each PDS sets
its own and reports it (`blobUploadLimit` in `describeServer`). The reference
PDS default is now 100 MB. bsky.social's actual limit and any per-account
quota are unconfirmed, so large assets on users' Bluesky accounts should be
treated as a courtesy, not a right. Bluesky's own record types cap images at
1 MB; our record types set their own limits.

Assets are public once used: blobs referenced by records are publicly
readable, and assets shown to other people can't be protected anyway. The
hub fetches and caches them rather than having browsers load them from
users' PDSes, which the spec advises against.

### 7.2 Different avatars in different places

A user keeps a **wardrobe** of assets and a **default**. Each place decides
which one applies, so being one avatar on one leaf and another elsewhere, at
the same time, is no problem.

Per-leaf choices are **stored on the leaf, privately, not in the AT repo**.
Everything in an AT repo is public, so records like "my avatar for BBS X"
would reveal which leaves a person uses.

Resolution order on a leaf:

1. The avatar the user chose on that leaf (stored on the leaf)
2. An avatar the leaf hosts for that user
3. The user's AT default (our record type)
4. Their Bluesky profile picture
5. The hub's or leaf's default

The hub uses the same order, starting from the user's hub choice.

The at3d.app draft record types for 3D identity and VRM avatars
([hub.md](hub.md) §5.3) may cover the wardrobe; follow or help shape them
rather than defining our own where they fit.

## 8. Common space and presence

- **Presence** (who is on which leaf, and where) is the core of the shared
  space. It is opt-in, like member activity elsewhere
  ([publishing.md](publishing.md) §5): off unless the person turns it on.
- Interaction depends on the leaves connected, each person's client tier,
  and the hub admin's settings. New users (with no account on any leaf) may
  be allowed in, if the hub admin chooses.
- Chat and voice: consider [Matrix](https://matrix.org) (federated rooms,
  end-to-end encrypted direct messages, voice and video via MatrixRTC)
  rather than building our own.
- 3D and VR: Overte is the current favorite ([hub.md](hub.md) §5.3). Its
  domain servers map onto leaves or the hub's default space, and its
  metaverse server onto the hub directory, so the work is linking its
  accounts and directory to AT identities rather than building an engine.

## 9. Hub federation

Hubs can register with each other to form a larger space, or let their users
visit each other's leaves. IRC shows the risk: one shared state across a tree
of servers splits when a link breaks (netsplits). Two lighter models avoid
that:

- **Each room is owned by one hub**, and other hubs relay into it. A broken
  link isolates only that link; nothing needs merging afterwards.
- **Replicated rooms built to heal after splits**, as in Matrix.

For the directory, AT itself does most of the work: each hub's listings are
records, and other hubs subscribe to them.

## 10. Open questions

- **Record type names for non-BBS leaves.** The decided root is
  `io.zerosquared.bbs.*` ([publishing.md](publishing.md) §3). Leaves that
  aren't BBSes, and hub offers and agreements, may need a broader root (for
  example a separate `io.zerosquared.*` group). Settle before any of these
  records are published, since names are permanent.
- Which tunnel software also carries real-time UDP traffic, or whether that
  needs a separate relay (TURN, QUIC).
- Exact offer, request, and agreement fields; how usage summaries are
  published.
- Rules for multi-homed leaves (directory duplicates, which hub's rules apply).
- Whether presence and common-space features are part of the hub or a
  separate service beside it.
- Federation model for common spaces (§9).
