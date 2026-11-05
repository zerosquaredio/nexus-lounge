# Networking Spec

Status: Draft
Last updated: 2026-10-29

## 1. Overview

BBSes can connect to each other to share message boards, files, and games,
in the tradition of FidoNet-style networks. Sysops agree to peer, each BBS
logs into the other as a peer, and the two exchange data over a WebSocket.

In ENiGMA½, peering is implemented as a scanner/tosser message network
module alongside the existing FidoNet/binkp and ActivityPub ones
([enigma_integration.md](enigma_integration.md) §7).

Networking is planned in phases:

| Phase | Capability |
|---|---|
| 1 | **Peering:** shared message boards between BBSes (§2–§6) |
| 2 | **Shared resources:** file areas and door games across peers (§7) |
| 3 | **Clusters:** several BBSes acting as one, with shared membership, load sharing, and failover (§8) |

## 2. Peering model

- Every BBS has its own AT account and DID ([publishing.md](publishing.md)
  §2). A peer BBS is identified by that DID.
- The sysop adds a peer by its DID (or handle, resolved to a DID) and grants
  it the `peer` role, scoped to specific shared boards. This uses the
  existing roles and policies ([attestation.md](attestation.md) §5).
- Either side may dial. The dialing BBS opens an outbound WebSocket to the
  other's `/peer` endpoint, via the hub or the peer's own tunnel
  ([hub.md](hub.md) §4). One connection carries traffic in both directions,
  so only one side needs to be reachable.
- Peering is private: messages are exchanged server-to-server and are not
  written to AT repos, so networks can be members-only.

## 3. Peer authentication

Peers can't use OAuth, which requires a person to approve in a browser.

**Preferred: AT service auth.**

1. BBS A requests a short-lived service-auth token from its own account
   server (`com.atproto.server.getServiceAuth`), with BBS B's DID as the
   audience.
2. A presents the token when opening the `/peer` WebSocket.
3. B verifies the signature against the signing key in A's DID document and
   checks that A's DID has the `peer` role.

**Alternative: published key.** Each BBS generates a keypair, publishes the
public key in its listing record ([publishing.md](publishing.md) §3.1), and
signs a challenge on connect. This avoids depending on the account server
being reachable at connect time.

Open question: support both, or only one for v1 (§9).

## 4. Message exchange

### 4.1 Message identity

Each message has a globally unique ID:

```
<origin BBS DID> / <author DID> / <origin-local unique ID>
```

Receiving BBSes deduplicate by this ID, so a message that arrives by more
than one route is stored once.

### 4.2 Store and forward

- Outbound messages for a peer are queued while the peer is unreachable and
  delivered when the connection is restored.
- Delivery is acknowledged per message; unacknowledged messages are resent.
- Queues have a retention limit, configurable by the sysop.

### 4.3 Multi-hop and loop prevention

If A peers with B and B peers with C, a message can travel A → B → C.

- Each message carries a **path**: the DIDs of every BBS it has passed
  through (like FidoNet's SEEN-BY/PATH).
- A BBS never forwards a message to a BBS already on its path.
- Whether a board is forwarded beyond direct peers is set per board.

### 4.4 Edits and deletes

To be specified. Edits and deletes propagate as messages referencing the
original ID; receiving BBSes apply them on a best-effort basis.

## 5. Trust and authorship

- A message is labeled with its author's DID, but the receiving BBS cannot
  verify authorship directly (users' signing keys live on their account
  servers). It trusts the **peer that relayed it**, the same trust model as
  FidoNet.
- Sysops should peer only with BBSes they trust, and can drop a peer at any
  time.

## 6. Moderation

- Author identities are global DIDs, so a sysop can **ban a remote user by DID**
  across every networked board on their BBS.
- A sysop can block a peer entirely, or stop accepting a specific board from
  it.
- Optional: share ban lists between peers (each sysop decides whether to
  honor them).

## 7. Phase 2: shared resources

### 7.1 File areas

- A shared file area is replicated between peers.
- Files are identified by content hash, so duplicates are stored once and
  transfers can be resumed or verified.
- Each BBS chooses whether to mirror files fully or fetch them on demand.

### 7.2 Door games

- A door game is hosted on one BBS and played by users of peer BBSes: the
  user's BBS proxies their terminal session to the host over the peer
  connection.
- The host sees the player's DID (vouched for by the peer), so scores and
  saves follow the user across BBSes.
- Multi-node games with shared state are a later extension.

## 8. Phase 3: clusters

A cluster is a group of BBSes whose sysops trust each other fully and present
one BBS to users.

Goals:

- **Shared membership:** a member admitted on one node is admitted on all.
  Implemented by honoring each other's attestations (e.g. a
  `peer-attested` verifier; [attestation.md](attestation.md) §8).
- **Shared login:** a user can connect to any node. DIDs already make
  identity portable; saved credentials ([attestation.md](attestation.md) §3.2)
  would need to be shared or re-bound per node.
- **Load sharing:** users are directed to any available node.
- **Stability and backup:** boards, files, and user data are replicated, so
  the cluster survives a node going offline.
- **Failover:** the cluster's listing advertises multiple node URLs; clients
  and the hub fall back to another node when one is down. This needs a
  listing-record change (a cluster ID; the listing already allows several
  `endpoints`).

Hard problems to solve before building:

- **User data replication:** private mail, read pointers, settings. Requires
  a replication and conflict-resolution strategy.
- **Consistency for live features:** chat and presence across nodes.
- **Governance:** how nodes join or leave, and who can change cluster-wide
  policy.
- **Privacy:** every node holds every member's private data, so each node's
  sysop must be trusted with it. Members should be told which sysops can see
  their data.

## 9. Open questions

- Peer authentication: service auth only, published keys only, or both.
- Wire protocol for peer messages (framing, versioning, acknowledgements).
- Board naming across a network: how a shared board is identified, and who
  owns it.
- Edit and delete semantics (§4.4).
- Whether the hub should offer a peer directory (BBSes advertising boards
  available for peering).
