# Running a Hub

The day-to-day work of a hub's admin: deploying, looking after the BBSes on
it, moderating, the hub's own AT account, and backups. For the hub's
programs and its config file, see the [hub's README](../../hub/README.md);
for why it works this way, the [hub spec](../development/hub.md).

## 1. The admin command line

Everything here is done with the control plane's command line, on the hub's
server, as the user the hub runs as, with its config:

```sh
node src/cli.ts --config hub.json help
```

It's worth wrapping that in a short script (the public hub calls its wrapper
`hubctl`), which also loads the hub's secrets
(`HUB_FRPS_ADMIN_PASSWORD`, `HUB_CHAT_SECRET`), so it reads as:

```sh
sudo hubctl list
```

The examples below use `hubctl`. Changes take effect at once: the command
line and the running control plane share the same database, so nothing needs
restarting.

## 2. Deploying

`scripts/deploy.sh`, at the root of the repo, updates the hub from a
checkout on your own machine, over SSH, as a user with sudo on the server:

```sh
export HUB_SSH=admin@hub.example
scripts/deploy.sh status         # services, the deployed revision, the BBSes
scripts/deploy.sh hub            # deploy the hub's code at HEAD (or a commit)
scripts/deploy.sh rollback       # put back the code from before
scripts/deploy.sh configs        # regenerate frps's and Caddy's configs
```

- **`hub`** installs the new code beside the running one, swaps it in and
  restarts the control plane. If it doesn't answer its health check within
  30 seconds, the old code goes back by itself. Only committed code is
  deployed. The restart takes a few seconds; tunnels stay up.
- **`rollback`** puts back the previous version, for when a deploy came up
  healthy but is wrong.
- **`configs`** is needed when a change affects the generated configs: the
  release notes or the commit will say so. It restarts frps or Caddy only if
  its config actually changed. Restarting frps drops every tunnel for a few
  seconds, and the agents reconnect by themselves.

The script expects the layout described in the hub's README (code in
`/srv/hub/control`, run by the `hub` user as `hub-control`); settings in the
script's header change each part. For test boards the hub runs itself in
Docker, `board-image` and `board` build and swap an ENiGMA½ image.

## 3. BBSes

### Registering

Sysops register on the hub's site, signing in with their AT account, and get
their agent's config there, once. While `registration.open` is `false`, only
the admin registers BBSes:

```sh
sudo hubctl add coolbbs --sysop did:plc:... --out coolbbs-agent.toml
```

The token is printed once and only a hash is kept: send the output to the
sysop privately, or to `/dev/null` if the config file is all they need. The
sysop runs `frpc -c coolbbs-agent.toml` next to their BBS.

A BBS's own AT account, for its handle under the hub, is set with
`hubctl set-did coolbbs did:plc:...` or by the sysop on the site. The steps
are in [bbs_account.md](bbs_account.md).

### Seeing what's there

```sh
sudo hubctl list                 # every BBS: state, and whether connected
sudo hubctl show coolbbs         # one BBS in full
```

### Suspending

```sh
sudo hubctl suspend coolbbs
sudo hubctl resume coolbbs
```

Suspending a BBS takes effect at once for anything new: its agent can't log
in or open routes, no certificate is made for its name, its page on the hub
says it isn't available, and its handle stops working. An open tunnel, with
every session in it, is cut within a minute (in practice within about 20
seconds), when its next heartbeat is refused.

That relies on agents sending heartbeats. Configs the hub generates include
them; **a config written or kept from before needs these two lines**, or
frps closes its tunnel every minute:

```toml
transport.heartbeatInterval = 20
transport.heartbeatTimeout = 60
```

(The numbers follow `tunnel.heartbeatSeconds` in the hub's config.)

### Limits

Each BBS's traffic is capped by the tunnel server, which the BBS can't get
around: `tunnel.bandwidthLimit` in the hub's config, `1MB` a second by
default (in and out together), for its web pages and again for its terminal
connections. A BBS may ask for less in its agent's config, never more. Set
it to `""` for no limit; a change applies as each BBS's tunnel next
connects (restart frps to apply it to all at once).

Other limits in the config: how many BBSes one sysop may register
(`registration.maxBbsPerSysop`, 3), and how many chat connections one
person may have open (`space.chat.maxConnections`).

### Tokens

```sh
sudo hubctl rotate-token coolbbs --out coolbbs-agent.toml
```

The old token stops working at once, and the agent still using it is cut
within a minute, as with a suspension. The sysop can do the same on the site
("New token"); either way, the agent needs the new config. If the BBS also
reports presence to the hub, its copy of the token has to change too.

### Removing

`hubctl remove coolbbs` deletes the BBS and frees its name. Its observed
status record is taken down. To keep someone from coming back, ban them
first (below).

## 4. Moderation

The hub has two kinds of moderation, for two different things.

### BBSes: bans

```sh
sudo hubctl ban did:plc:... --reason "what it was for"
sudo hubctl bans
sudo hubctl unban did:plc:...
```

A ban is on a DID. It suspends every BBS that DID runs as sysop, or whose own
account it is, so their tunnels are cut within a minute; and it refuses that
DID registering another BBS, as sysop or as a BBS's account. A ban doesn't
end on its own. Unbanning leaves the BBSes suspended: resume each one that
should come back.

### The common space: blocks and reports

The common space (its map, presence and chat room) has its own blocks, which
take effect within seconds:

```sh
sudo hubctl space block did:plc:... --reason "..."          # from the whole space
sudo hubctl space block did:plc:... --room --for 7d         # only its chat, for a week
sudo hubctl space block alice@coolbbs                       # a BBS member without an AT account
sudo hubctl space block '*@coolbbs'                         # everyone from that BBS
sudo hubctl space blocks
sudo hubctl space unblock ID
```

People are told it was the hub's admin, and the reason given. A ban doesn't
block anyone from the space, and a block doesn't touch anyone's BBS: for
someone causing trouble in both, do both.

Anyone in the space can report someone from the map or the chat page. A
report carries what was said in the room in the minutes before it
(`space.chat.reportMinutes`), and nothing else is kept of the room:

```sh
sudo hubctl space reports        # the open ones
sudo hubctl space report ID      # one, with what was said
sudo hubctl space close ID --outcome "blocked for a week"
```

Closing a report lets go of what was said in it.

### The record

Bans and unbans, suspensions and resumptions, blocks and unblocks, and
reports as they come in and are closed all go in the moderation log:

```sh
sudo hubctl space log --limit 50
```

### The directory

The hub's front page lists BBSes from the AT network. To keep an account's
listing off it:

```sh
sudo hubctl directory hide did:plc:... --reason "..."
sudo hubctl directory hidden
sudo hubctl directory unhide did:plc:...
```

## 5. The hub's own AT account

The hub publishes whether each BBS's tunnel is up (observed status), as
public records from an AT account of its own, such as a Bluesky account made
for the hub. Connect it once:

```sh
sudo hubctl hub-account connect hubaccount.bsky.social
```

It prints a link. Open it, within 10 minutes, in a browser signed in as that
account, and approve; the browser lands on the hub's site, which says
"Hub account connected". The account is asked only to write its own observed
status records. On a hub with a public `https://` address the session lasts;
if the account is ever disconnected (`hubctl hub-account show` says so),
connect it again the same way.

```sh
sudo hubctl observed             # each BBS: what the hub sees, and what it published
```

A change is published once it has held for 20 seconds, so brief drops don't
show. Records are kept in the account's AT repository, where anyone can read
them; the hub takes down the record of a BBS that's removed. Publishing is
`observedStatus.enabled` in the config.

## 6. Watching the hub

### Status, for monitors

`https://hub.example/status.json` says whether the hub is working, for a
monitoring service outside the hub to check every few minutes and tell you
when it isn't:

```json
{ "ok": true, "tunnels": "ok", "chat": "ok", "bbses": { "coolbbs": "connected", "other": "disconnected" } }
```

It answers 200 when the hub can carry tunnels and chat, and 503 when the
tunnel server or the chat server is down (or the hub itself doesn't answer
at all). A BBS being offline doesn't count against the hub, since boards
come and go; to watch one BBS, check `status.json?bbs=coolbbs`, which
answers 503 while that BBS is offline. A sysop can watch their own board
the same way. Suspended BBSes aren't listed.

Any uptime monitor that checks a URL's status code will do, such as a free
plan of a hosted one; use two checks, the hub's and, if you like, each
board you care about.

### Usage

The hub keeps a summary for the long view, one row a day, kept after the
logs are gone:

```sh
sudo hubctl usage --days 30
sudo hubctl usage --days 365 --json
```

For the hub: BBSes registered, active and the most connected at once;
people with a profile, shown in the space, and signed in that day; the
most watching the map and in the chat at once; reports and blocks. For each
BBS, by name: hours connected, traffic in and out through its tunnel, and
the most connections at once. Totals only: no DIDs, nothing anyone said, no
addresses. It's counted while the control plane runs (traffic needs the
tunnel check, so `HUB_FRPS_ADMIN_PASSWORD` set), and it's in the database,
so it's in every backup.

## 7. Logs

The hub's programs log what happened, never what anyone said:

| Program | Logs |
|---|---|
| Control plane | Starts and stops; each BBS's agent logging in and opening routes, and refusals; certificates asked for; sign-ins, registrations and changes on the site, by DID; people's chat connections closed and why; reports filed (by number, not what they say) |
| frps (tunnel server) | Warnings only: refused agents, and requests for paths a BBS doesn't serve (the path, never the request's content) |
| Caddy (edge) | Its own certificates and errors; no access log |
| freeq (chat) | Connections and sign-ins, by DID; never messages |

Tokens and secrets are never logged, nor is the text of messages or
reports; tests check this. What was said in the room is kept only in a
report, in the database, until the report is closed.

The logs do hold DIDs, BBS names, and the addresses of agents that are
refused. How long they're kept is set by the server's journal (systemd's
default keeps them until they reach a size limit, which can be many months).
Set a limit that matches the hub's privacy notice, for example in
`/etc/systemd/journald.conf.d/retention.conf`:

```ini
[Journal]
MaxRetentionSec=3month
```

then `systemctl restart systemd-journald`. BBSes run in Docker on the hub's
server keep their own logs, under their own rules.

## 8. Backups

What a hub can't make again is small:

| What | Where (as in the hub's README) |
|---|---|
| The database: BBSes, sessions, profiles, moderation | `data/hub.sqlite` |
| The sign-in client's private key | `data/oauth_signing_key.json` |
| The chat server's keys | `data/chat/` |
| The config | `hub.json` |
| The secrets | the environment file holding `HUB_FRPS_ADMIN_PASSWORD` and `HUB_CHAT_SECRET` |

Certificates are made again on demand, and the chat room keeps no messages.

Copy the database with `sqlite3 data/hub.sqlite ".backup out.sqlite"` (and
`PRAGMA integrity_check` on the copy), not by copying the file, which can
catch it mid-write. Keep backups off the server, and make sure whatever
pulls them can't do anything else there.

To restore: stop the control plane, frps and the chat server; put the files
back, removing any `hub.sqlite-wal` and `hub.sqlite-shm` left beside the
database; give them back to the hub's user (the signing key readable by it
only); start everything again. BBSes' agents reconnect by themselves, and
people stay signed in. A hub older than the backup's code upgrades the
database when it starts. Right after a restore, `list` may show BBSes as
connected from when the backup was made; the control plane corrects that
from frps within seconds.

To test a backup, restore it somewhere private (on `127.0.0.1` only) with
`observedStatus`, `directory` and the chat turned off in its config. Above
all, a copy must never use the hub's own AT account while the real hub
runs: renewing the account's session there would end the real hub's.

To move the hub to another server, restore there, then point the DNS names
(the hub's name and the wildcard under it) at the new address.
