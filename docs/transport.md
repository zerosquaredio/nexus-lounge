# Transport Spec

Status: Draft
Last updated: 2026-10-28

## 1. Goals

- Sysops can run a BBS on a home machine **without opening inbound firewall
  ports**.
- Users can connect from a browser with nothing installed, or from a native
  client.
- One public endpoint carries everything the BBS needs: the terminal session,
  AT OAuth (client metadata + callback), and verifier webhooks
  ([attestation.md](attestation.md) §7).

AT Protocol provides no peer-to-peer or NAT-traversal support. It is
client-server over HTTPS and every AT service has a public endpoint. Reachability
is solved by the transport layer described here, not by AT.

## 2. Primary transport: HTTPS + WebSocket

- The BBS serves a single HTTPS listener (locally plain HTTP is fine when a
  tunnel or the hub terminates TLS).
- The terminal session runs over a **WebSocket**: an HTTPS request upgraded to
  a persistent, bidirectional connection.
- Clients:
  - **Web terminal:** enig-term, ENiGMA½'s browser terminal, speaking the
    terminal protocol over WebSocket. When the BBS runs behind the hub, the
    hub serves this client ([hub.md](hub.md) §4).
  - **Native client:** a terminal app speaking the same WebSocket protocol.
- The same listener serves the OAuth client metadata, OAuth callback, and
  `/cb/...` webhook routes.

### 2.1 Endpoints

Logical endpoints. ENiGMA½'s actual routes and ports are mapped in
[enigma_integration.md](enigma_integration.md) §3.3 and §6.

| Path | Purpose |
|---|---|
| `/ws` | Terminal session (WebSocket) |
| `/peer` | BBS-to-BBS peering (WebSocket; [networking.md](networking.md)) |
| `/oauth/client-metadata.json` | AT OAuth client metadata (the `client_id`) |
| `/oauth/callback` | AT OAuth redirect target |
| `/login/<code>` | Browser handoff landing page ([attestation.md](attestation.md) §7.1) |
| `/cb/<verifier-id>/...` | Verifier callbacks and webhooks |
| `/assets/...` | Graphics and 3D assets the BBS offers to a hub's shared space ([hub.md](hub.md) §5.3) |

The tunnel carries all of these, so a home-based BBS needs no open ports.
Direct ports (SSH, telnet) are an optional extra a sysop may open, as is a
direct `https://` source for assets; the tunnel stays the default.

### 2.2 Terminal protocol

Use ENiGMA½'s existing WebSocket login server: the terminal byte stream
(telnet-style) carried over WebSocket, as used by enig-term and other
WebSocket-capable BBS terminals.

- CP437 and ANSI are passed through as-is; enig-term renders CP437 fonts
  natively, so no UTF-8 conversion is needed.
- Terminal size and capabilities are negotiated in-band, as on telnet.
- Keepalive pings so tunnels and proxies don't drop idle sessions.

## 3. Reachability options

The BBS code is identical in every case; only how the public URL reaches it
differs.

| Option | Inbound ports needed | Central party | Can the central party read traffic? |
|---|---|---|---|
| Direct (public IP / port forward) | Yes | None | No |
| Cloudflare Tunnel | No | Cloudflare | Yes (TLS ends at Cloudflare) |
| ngrok | No | ngrok | Yes, by default |
| Tailscale Funnel | No | Tailscale | Believed no (TLS ends on the device); to be confirmed |
| Self-hosted frp/rathole on a VPS | No (on the BBS machine) | The sysop | Only the sysop |
| **Project hub** ([hub.md](hub.md)) | No | Hub operator | Yes in v1 |

How a tunnel works: an agent on the BBS machine opens an **outbound**
connection to the tunnel service and keeps it alive. Users connect to the
service's public URL, and the service forwards their traffic down that
connection. Firewalls allow outbound connections, so nothing needs opening.

WebSocket is chosen over raw TCP because tunnels, proxies, and CDNs handle
HTTPS well, while raw TCP (SSH, telnet) is often unsupported, needs client-side
tooling, or costs extra. Browsers can only speak HTTP/WebSocket.

## 4. Optional transport: SSH

- Sysops who can expose a port may enable ENiGMA½'s SSH login server.
- SSH sessions get the same terminal experience; authentication uses the
  bound SSH key ([attestation.md](attestation.md) §3.2) after an initial
  OAuth login via browser handoff.
- SSH is not available through the hub in v1.

## 5. Telnet

ENiGMA½ includes a telnet server, and sysops may keep it for retro clients.
Telnet is plaintext, so **AT login is not offered over telnet**
([enigma_integration.md](enigma_integration.md) §3.4). Sysops should restrict
telnet to guest or local use.

## 6. Backlog: peer-to-peer

Not in v1. A possible future direction:

- Use a P2P transport such as **iroh** (QUIC with hole punching and relay
  fallback) or **libp2p**, dialing a BBS by its public key.
- Use AT as the directory: the BBS publishes its node key in its listing
  record ([publishing.md](publishing.md) §3.1).
- Costs: requires a native client; relays are still needed when hole punching
  fails; AT OAuth needs a reachable callback, so identity would need another
  mechanism (e.g. a signed challenge against a key in the user's repo).

## 7. Open questions

- Whether enig-term should be served by each BBS when not behind the hub
  (ENiGMA½ can already do this), or always loaded from a canonical project URL.
