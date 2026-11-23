# Overte Evaluation and VR Plan

Status: Draft (decision recorded; nothing built yet)
Last updated: 2026-11-08

This records the choice of 3D and VR software for the social space
([hub.md](hub.md) §5.3; [vision](https://github.com/zerosquaredio/cyberspace-framework/blob/main/docs/vision.md) §8).
The shortlist and the reasons other candidates were set aside are in
hub.md §5.3.

## 1. Decision

- **Overte** is the world server and the native (desktop and PC VR)
  client.
- **Vircadia's web SDK and web interface** (Apache-2.0) are the starting
  point for a browser and WebXR client that joins the same Overte domains.
  Vircadia has stopped developing them (§6), so we fork them and update
  their protocol code to match current Overte.

This follows the rule decided on 2026-11-07: the core 3D layer is software
we fully control and can fork.

## 2. Background

- **Lineage:** High Fidelity (open-sourced, wound down around 2020) →
  Vircadia (community continuation) → Overte (forked from Vircadia in 2022
  over governance and direction; run by the nonprofit Overte e.V.).
- **Engine:** its own C++ and Qt engine, not Unity. Scripts are
  JavaScript, physics is Bullet, and it imports FBX, glTF and OBJ.
- **License:** Apache-2.0, compatible with the framework's BSD 2-Clause
  code.
- **Activity** (checked 2026-11-08): commits to `overte-org/overte` as
  recently as 2026-11-07; the domain server Docker image is at 2025.12.1;
  monthly progress reports and a weekly community event. Nonprofit
  governance suits a self-hosted, community-run project.

## 3. How Overte fits the hub and leaf model

| Overte part | Framework part |
|---|---|
| Domain (self-hosted world server) | A leaf's room, or the hub's common space |
| Metaverse server (accounts, user keys, directory) | The hub: AT login and the directory (§4.1) |
| ICE server (finds a path through home routers) | Run by the hub (§4.2) |
| Asset server, or plain HTTP URLs | A leaf's assets, over the tunnel by default (§4.3) |

- **Bridging to BBSes:** Overte scripts can open WebSockets, and Web
  entities show HTML in the world. A terminal (enig-term, or xterm.js
  behind a telnet or SSH gateway) on a screen in a room can show an
  ENiGMA½ board. That makes a good first demonstration, and leads into
  building in the space and the visible network (vision §8.1, §8.2).

## 4. Points to work out

### 4.1 Identity

Overte has its own accounts. A domain decides who a visitor is by trusting
a metaverse server, which holds accounts and signs users' keys; domains
don't depend on the central one. So the likely path is **a metaverse
server run by the hub that offers "log in with Bluesky"**: any domain set
to trust it gets AT identity without changing the domain server, the same
pattern as AT login on a BBS. The fallbacks are an authentication path in
the domain server, or a gate in front of it.

To check first: which metaverse server Overte runs today, whether it can
be self-hosted, and how domains are told to trust it.

### 4.2 Networking

Domains use UDP with their own NAT traversal, so the hub's tunnel, which
carries BBS connections over a WebSocket, can't carry Overte traffic as it
is. That doesn't leave the hub only listing and linking domains:

- Overte finds paths through home routers with an **ICE server**, the
  same idea as WebRTC's STUN. The hub can run its own.
- When no direct path exists, a **relay** at the hub, like WebRTC's TURN,
  carries the traffic.

With both, a home-based leaf can host a domain without opening any ports.
That keeps "easy by default", with direct UDP ports as the optional faster
path, as for BBS connections and assets. The relay costs bandwidth, so it
belongs in the hub's sizing. Web clients need STUN and TURN servers in any
case.

### 4.3 Assets

A domain serves assets from its own asset server, over its own connection,
or from plain HTTP URLs. That matches the rule already decided: over the
tunnel by default, with an optional direct source (hub.md §5.3).

### 4.4 Reach

The native client is a desktop install, and VR means PC headsets. There is
no maintained browser client today (§5).

## 5. Mixing native and web users in one world

1. **Native route (recommended).** Overte's domain server includes a
   WebRTC signaling server, inherited from Vircadia's web client work, so
   web clients connect over WebRTC data channels alongside native UDP
   clients. Confirmed 2026-11-08: Overte's networking library still has
   `WebRTCSignalingServer`, `WebRTCDataChannels` and `WebRTCSocket`, and
   builds include them by default on Windows and Linux. The Vircadia web
   SDK (TypeScript, `@vircadia/web-sdk`) speaks the protocol in the
   browser.
   - Expect protocol drift: the SDK targets Vircadia's protocol, and
     Overte has changed since the fork.
   - Connecting is the easy part. Showing avatars and entities, audio, and
     running entity scripts are most of the work. First target: avatars,
     movement, voice and chat.
2. **Bridge route.** A relay joins both an Overte domain and a separate
   WebXR server, mirroring avatar positions and chat. Quicker to
   prototype, but each side sees only puppets of the other, and shared
   objects and physics don't sync well.
3. **Hub route.** Share presence and chat at the hub, with no shared 3D
   space. Fits the common space, and is worth building whatever else is
   chosen: the hub's web page is the simple 2D view, Overte the
   high-detail one, both reading the same presence data.

## 6. Overte and Vircadia today

Checked 2026-11-08:

- **Overte** is clearly active, and maintains both the native engine and
  the domain server's WebRTC support.
- **Vircadia** has moved its work to a new platform, Vircadia World; the
  old engine's README says "see Vircadia World for current development",
  and the new SDK describes itself as early and subject to change.
  `vircadia-native-core` was last pushed in July 2025 and
  `vircadia-web-sdk` in December 2025; neither is archived. Treat the web
  SDK as frozen: fork it rather than expect updates.

## 7. Next steps

None of this competes with current work. It is a stage after M3 (the hub,
tunnels and BBS images), and the identity and ICE work wait until the hub
(F11) exists.

1. Run an Overte domain on the VM (Docker), and the desktop client on
   Windows; see how accounts and the metaverse server work.
2. Prototype AT login through a self-hosted metaverse server (§4.1).
3. Put an in-world Web entity terminal on an ENiGMA½ board (§3).
4. Get the Vircadia web SDK connecting to a current Overte domain and
   showing avatar positions, to measure protocol drift (§5).
5. Design hub-level presence and chat across leaves (§5, route 3).
6. Try a hub-run ICE server and relay with a home-based domain (§4.2).

Also to check: VRM avatar support (hub.md §5.3).

## Sources

- [Overte on GitHub](https://github.com/overte-org/overte)
- [Overte website](https://overte.org/)
- [Overte domain server Docker image](https://hub.docker.com/r/overte/overte-server/tags)
- [Overte documentation](https://overte-website-sphinx.readthedocs.io)
- [Vircadia on GitHub](https://github.com/vircadia)
- [Vircadia web SDK](https://github.com/vircadia/vircadia-web-sdk)
- [Vircadia web interface announcement](https://www.fosslife.org/vircadia-web-interface-announced)
- [ICE, STUN and TURN in WebRTC](https://blog.webrtc.ventures/2022/04/ice-in-webrtc)
