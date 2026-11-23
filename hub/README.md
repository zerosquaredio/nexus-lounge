# The Nexus Lounge hub

The hub lets BBSes run behind home firewalls and makes them reachable at
`name.hub.example` ([hub spec](../docs/hub.md),
[hub plan](../docs/hub_development_plan.md)). Three programs run on the hub's
machine:

| Program | Role |
|---|---|
| **Caddy** (the edge) | Public HTTPS. Makes a certificate for a name only after asking the control plane; refuses odd paths; forwards only a BBS's allowed paths |
| **frps** (the tunnel server) | Accepts the tunnels BBSes open outward, and carries requests down them. Asks the control plane before accepting any agent or route |
| **control** (this repo, `control/`) | The registry of BBSes, the tunnel's approval hook, the certificate check, handle verification, the directory of BBS listings from the AT network, observed status (whether each BBS's tunnel is up, published from the hub's own AT account), and the hub's own site, where sysops sign in with AT and register their BBSes |

Each BBS runs **frpc** (the tunnel agent) next to it, with a config the hub
generates.

The control plane is TypeScript run directly by Node 24 (which strips the
types), with Node's built-in SQLite. Its one runtime dependency is the AT
OAuth library, for signing sysops in and for the hub's own account.

## Status

Updated 2026-11-23: a public hub runs at `hub.cyberspace.nexus`, with real
certificates and a test board at `test.hub.cyberspace.nexus`; registration
there is closed for now. Everything below also runs on one machine on
`127.0.0.1`, with Caddy's own test certificate authority.

## Using it

```sh
cd control
npm install            # the AT OAuth library, and the dev tools
npm test               # unit tests
npm run typecheck

#  the admin command line (a JSON config file, merged over the defaults
#  in src/config.ts; without one, the domain is hub.test)
node src/cli.ts --config hub.json add coolbbs --sysop did:plc:... --out coolbbs-agent.toml
node src/cli.ts --config hub.json list
node src/cli.ts --config hub.json frps-config > frps.toml
node src/cli.ts --config hub.json caddyfile > Caddyfile

#  the control plane itself
node src/main.ts hub.json
```

`add` prints the BBS's token once (only a hash is kept) and writes its agent
config, which the sysop runs with `frpc -c coolbbs-agent.toml`.

The hub's own address shows the directory: its own BBSes first, then
others listed on the AT network. It gathers listings with a first sweep and
then follows the network's changes (`directory` in the config; the admin can
`directory hide` an account).

At each BBS's own address, `name.<domain>`, the hub serves the BBS's page
and its own pinned copy of enig-term (set `webTerminal.root` to enig-term's
release directory). The terminal runs in the visitor's browser and connects
to `wss://name.<domain>/ws`, which goes down the BBS's tunnel.

Sysops can also register themselves on the hub's site
(`site.publicUrl`, by default `http://127.0.0.1:7210` for development): they
sign in with their AT account, and the site gives them the same token and
agent config, once. On `http://127.0.0.1` the site signs people in as AT's
loopback client. On a public `https://` address it is a public client: the
site serves its metadata at `/oauth/client-metadata.json` and its public key
at `/oauth/jwks.json`, and keeps the signing key in `site.signingKey`
(`./data/oauth_signing_key.json` by default), made on first start and
readable by the hub's user only.

### The common space

Off by default (`"space": { "enabled": true }` turns it on). With it on,
anyone who signs in gets a small profile, keyed by their DID, at `/me`:
their handle, when they first came, and whether they are shown in the
common space (presence), which is off until they turn it on. They can
remove the profile there, which also signs them out everywhere. Nobody
needs to run a BBS to sign in.

**Presence** comes from the BBSes: each reports, with its tunnel token, the
members who chose to be shown and whether they are on
(`POST /api/bbs/presence`; on the ENiGMA½ side, `atProto.hub.presence`).
`/space` lists who is around, for people allowed in. A member reported by
DID appears as `alice via coolbbs` until they confirm that BBS at `/me`.
Who may join is `space.join` (`members` of a BBS here, the default, or
`anyone`), with `memberDays` and `excludeOpenBbses`; members without an AT
account are shown only from BBSes listed in `space.vouchedFrom`.

**Chat** (`"space": { "enabled": true, "chat": { "enabled": true } }`) runs on
[freeq](https://github.com/freeq-irc/freeq), built from source (tested at
commit `f59840eb`), which only the hub can reach. Give the control plane and
freeq the same secret, of at least 32 characters:

```sh
export HUB_CHAT_SECRET="$(openssl rand -hex 32)"
mkdir -p data/chat
eval "$(node src/cli.ts --config hub.json chat-command --binary /path/to/freeq-server)"
```

Messages stay in freeq's memory and are gone when it restarts. Don't give it
a database or expose its ports: the hub is what checks who may join, and it
retakes the room after a restart before letting anyone in. Someone allowed in
gets a single-use login from `POST /space/chat/token` and connects to
`/chat/irc` on the hub's address. People are named by the DID on each
message, not by their nick. The hub closes that connection when they
sign out or stop being allowed (checked every `checkSeconds`, 30 by default).
The chat itself is at `/space/chat`, for anyone signed in who may join.

**The live model** (`"live": { "enabled": true }` in `space`) is a stream of
who is where, for views of the space such as a map or a BBS door: a
WebSocket at `/space/live` on the hub's address, for people allowed in. It
sends the whole state, then changes. The format is in
[docs/live_model.md](../docs/live_model.md). With it on, `/space` is a map
drawn from that stream, and opening a board from the map shows the person
there while they keep it open. A BBS's door (F19 in the BBS plan) uses the
same stream, and the chat room, for its members, with its tunnel token:
`/api/bbs/live`, `/api/bbs/chat/token` and `/api/bbs/chat`. Only members
who confirmed that BBS at the hub can chat from it.

Moderation (H18): the admin blocks people from the space or its room with
`node src/cli.ts space block`, and reads reports with `space reports` and
`space report ID`. A report carries what was said in the room in the last
`space.chat.reportMinutes`. Anyone in the space can mute someone for
themselves, from the map or chat page, or `/mute` in a BBS's door. See
`node src/cli.ts help`.

### Observed status

The hub publishes whether each BBS's tunnel is up, from its own AT account,
one `observedStatus` record per BBS with a DID (keyed by that DID), once a
change has held for 20 seconds. Connect the account once:

```sh
node src/cli.ts --config hub.json hub-account connect cyberspacehub.bsky.social
node src/cli.ts --config hub.json observed     # what the hub sees, and what it published
```

`connect` prints a link to approve in a browser, then waits for the browser
to come back to `127.0.0.1:7220` (`hubAccount.callbackPort`); from another
machine, forward that port first. The account is asked only to write its
observed status records.

The control plane also asks frps which tunnels are really up, so a tunnel
server that restarted or crashed doesn't leave BBSes shown as connected.
Start **both** frps and the control plane with the same
`HUB_FRPS_ADMIN_PASSWORD` in their environment: the generated `frps.toml`
reads it from there, and without it frps's admin API (on `127.0.0.1` only)
has no password.

**Suspending a BBS** refuses its agent's logins, new routes and new
certificates at once. An open tunnel stays up until it drops: frp's agents
send no heartbeats by default, and a dishonest one could stop them anyway.
Restart the tunnel server to cut it; every other BBS reconnects within
seconds.

## Connecting a BBS

A sysop registers on the hub's site and runs the tunnel agent with the
config it gives them. On the BBS (ENiGMA½), the settings for running behind
the hub are in its docs, under
[Behind a Proxy, Tunnel or Hub](https://github.com/zerosquaredio/enigma-bbs/blob/atproto-login/website/src/content/docs/servers/contentservers/atproto-handler.md#behind-a-proxy-tunnel-or-hub):
in short, `contentServers.web.overrideUrlPrefix` set to
`https://name.<domain>`, and `proxied: true` for the web and WebSocket
servers. For the BBS's listing to appear under its name in the directory,
give the BBS's own Bluesky account on the hub's site; the listing then
names the hub address by itself.

## End-to-end test

`test/e2e.sh` runs the whole hub on one machine in front of a real ENiGMA½
board: certificates, allowed and odd paths, a terminal session over `wss://`,
ten dishonest agents, handle verification, and suspension.

```sh
BIN=/path/to/frp-and-caddy BBS_WEB_PORT=8080 BBS_WS_PORT=8810 test/e2e.sh
```
