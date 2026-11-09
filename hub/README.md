# The Nexus Lounge hub

The hub lets BBSes run behind home firewalls and makes them reachable at
`name.hub.example` ([hub spec](../docs/hub.md),
[hub plan](../docs/hub_development_plan.md)). Three programs run on the hub's
machine:

| Program | Role |
|---|---|
| **Caddy** (the edge) | Public HTTPS. Makes a certificate for a name only after asking the control plane; refuses odd paths; forwards only a BBS's allowed paths |
| **frps** (the tunnel server) | Accepts the tunnels BBSes open outward, and carries requests down them. Asks the control plane before accepting any agent or route |
| **control** (this repo, `control/`) | The registry of BBSes, the tunnel's approval hook, the certificate check, handle verification, and the hub's own site, where sysops sign in with AT and register their BBSes |

Each BBS runs **frpc** (the tunnel agent) next to it, with a config the hub
generates.

The control plane is TypeScript run directly by Node 24 (which strips the
types), with Node's built-in SQLite. Its one runtime dependency is the AT
OAuth library, for signing sysops in.

## Status

Local only so far (2026-11-09): everything below runs on one machine on
`127.0.0.1`, with Caddy's own test certificate authority. Real certificates
and DNS wait for the public server.

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

At each BBS's own address, `name.<domain>`, the hub serves the BBS's page
and its own pinned copy of enig-term (set `webTerminal.root` to enig-term's
release directory). The terminal runs in the visitor's browser and connects
to `wss://name.<domain>/ws`, which goes down the BBS's tunnel.

Sysops can also register themselves on the hub's site
(`site.publicUrl`, by default `http://127.0.0.1:7210` for development): they
sign in with their AT account, and the site gives them the same token and
agent config, once. Signing in at a public `https://` address isn't built
yet.

**Suspending a BBS** refuses its agent's logins, new routes and new
certificates at once. An open tunnel stays up until it drops: frp's agents
send no heartbeats by default, and a dishonest one could stop them anyway.
Restart the tunnel server to cut it; every other BBS reconnects within
seconds.

## End-to-end test

`test/e2e.sh` runs the whole hub on one machine in front of a real ENiGMA½
board: certificates, allowed and odd paths, a terminal session over `wss://`,
ten dishonest agents, handle verification, and suspension.

```sh
BIN=/path/to/frp-and-caddy BBS_WEB_PORT=8080 BBS_WS_PORT=8810 test/e2e.sh
```
