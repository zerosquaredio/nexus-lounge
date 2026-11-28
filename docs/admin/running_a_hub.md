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

### The tunnel's certificate

Agents check the tunnel server's certificate before sending their token
(the hub's README, "Agents check the hub's certificate"). frps uses the
certificate Caddy already has for the hub's own name, copied over by
`scripts/tunnel-cert.sh`, which checks it and restarts frps when it has
changed. Caddy renews it every couple of months; frps reads it only when it
starts, so the script runs daily. Set it up once, as root:

```sh
install -m 755 scripts/tunnel-cert.sh /usr/local/sbin/hub-tunnel-cert
hub-tunnel-cert hub.example          # copies it to /etc/hub/tunnel-tls/
```

with these two units in `/etc/systemd/system/`, then
`systemctl enable --now hub-tunnel-cert.timer`:

```ini
# hub-tunnel-cert.service
[Unit]
Description=Hub: give the tunnel server the edge's certificate
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/hub-tunnel-cert hub.example

# hub-tunnel-cert.timer
[Unit]
Description=Hub: check the tunnel's certificate daily
[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true
[Install]
WantedBy=timers.target
```

Then set `tunnel.tlsCertFile` to `/etc/hub/tunnel-tls/tunnel.crt` and
`tunnel.tlsKeyFile` to `/etc/hub/tunnel-tls/tunnel.key` in the hub's config,
run `scripts/deploy.sh configs`. Agent configs made from then on check the
certificate. Configs made before need two lines, after
`transport.tls.enable = true` (the hub's domain in place of `hub.example`):

```toml
transport.tls.serverName = "hub.example"
transport.tls.useSystemCa = true
```

An agent without them still connects, but can't tell the hub from an
impostor. Tell the sysops of existing BBSes.

If the certificate can't be copied (Caddy has none yet, it is about to
expire, or it doesn't match its key), the script says so and leaves frps
as it was: check `journalctl -u hub-tunnel-cert`.

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

### Approving new BBSes

With `registration.open` on, two settings decide who gets in from the site:

- **`registration.approval`** (on by default): registering sends an
  application, with a note from the sysop about their BBS, and holds its
  name. You decide:

  ```sh
  sudo hubctl applications          # those waiting, oldest first
  sudo hubctl approve coolbbs
  sudo hubctl reject coolbbs --reason "tell us more about it"
  ```

  An approved BBS is registered at once; its sysop gets the agent config from
  their page on the site (**New token**). A rejected one shows the sysop
  your reason for 30 days, and they may apply again. Applications count
  toward the per-sysop limit, and sysops can withdraw their own. The hub
  sends no email, so the sysop finds out only by looking: `approve` and
  `reject` end with a reminder to tell them, with the handle their account
  names.
- **`registration.minAccountAgeDays`** (30 by default): a sysop's AT account
  must be this old, from when the PLC directory first recorded its DID. A
  `did:web` account records no such date: with approval on, it may still
  apply (`applications` marks it), and without approval it can't register.
  Set it to `0` for any age.

These are what make a ban stick: someone banned can make a new account, but
it has to wait out the age, and get past you. Approvals and rejections go in
the moderation log.

A BBS's own AT account, for its handle under the hub, is set with
`hubctl set-did coolbbs did:plc:...` or by the sysop on the site. The steps
are in [bbs_account.md](bbs_account.md).

### Seeing what's there

```sh
sudo hubctl list                 # every BBS: state, and whether connected
sudo hubctl show coolbbs         # one BBS in full
```

### Suspending (probation)

```sh
sudo hubctl suspend coolbbs --reason "reports of spam; write to us to sort it out"
sudo hubctl resume coolbbs
```

A suspension is probation while a problem is worked out: the BBS stays
registered, and its sysop sees the reason on their page on the hub, with
the abuse address to write to. Resuming it reinstates it. If it can't be
worked out, ban its sysop (below), which removes it for good.

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

`hubctl remove coolbbs` deletes the BBS; its name is held for 90 days
(below). Its observed status record is taken down. To keep someone from coming back, ban them
first (below).

### Terms, age and ratings

The hub's terms of service and privacy notice are HTML files it serves at
`/terms` and `/privacy` (`policy.termsFile` and `policy.privacyFile` in the
config; the public hub's are in `hub/policy/`). People confirm the hub's
minimum age (`policy.minimumAge`, 16 by default) and agree to those terms
before signing in; sysops confirm their BBS's rating before registering.
The age has to fit the ratings the directory lists (`directory.ratings`): 16
or more for `mature`, 18 or more for `adult`. `policy.operator` names who
runs the hub, at the foot of its front page.

When a BBS is removed, its name is held for 90 days;
`hubctl release NAME` frees it early.

## 4. Moderation

The hub has two kinds of moderation, for two different things.

### BBSes: bans

```sh
sudo hubctl ban did:plc:... --reason "what it was for"
sudo hubctl bans
sudo hubctl unban did:plc:...
```

A ban is for good, and on a DID. It removes every BBS that DID runs as sysop,
or whose own account it is, so their tunnels drop within a minute and their
names are held for 90 days; and it refuses that DID registering another BBS,
as sysop or as a BBS's account. The DID stays on the ban list until you
`unban` it, which lets it register again but brings nothing back.

A ban stops an account, not a person: someone banned can make a new AT
account and try again. While registration is by arrangement with the admin
(`registration.open` is `false`), that's caught at the door; once it's open,
approval and the minimum account age (above) are.

### Abuse reports

Anyone can report a BBS, or the hub itself, at `/report` on the hub's site,
signed in or not; the directory and every BBS's page link to it. A report
says what it's about, what kind of problem (illegal content, harassment,
spam or scams, someone's private information, copyright, a security
problem, or something else), what's wrong, and, if they like, how to reach
them. One address can send 5 an hour, and the hub takes 200 a day at most.

```sh
sudo hubctl abuse reports        # the open ones
sudo hubctl abuse report ID      # one in full
sudo hubctl abuse close ID --outcome "suspended coolbbs"
```

Closing a report deletes what it said, how to reply, and who sent it; what
it was about, its kind and the outcome stay. Set the address people can
write to instead in the config, `contact.abuse` (shown on the report page);
make sure mail to it reaches you.

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

### Art

The art on the hub, the hub's own library and what it took from BBSes
(their splash screens, emblems and published pieces), by whose it is:

```sh
sudo hubctl assets
```

To take a piece down, block one of its files by its hash (the whole
64 digits, or the first 12 or more, as the gallery's links and reports
show them). The hub stops showing it and serving any of its files
everywhere within half a minute, and refuses the same bytes if any BBS
offers them again:

```sh
sudo hubctl asset block 1c300dbb83be --reason "not theirs to share"
sudo hubctl asset unblock 1c300dbb83be
```

To take no art at all from an account (a BBS's own account), and let go of
everything taken from it, its splash screen and emblem too:

```sh
sudo hubctl asset refuse did:plc:... --reason "keeps posting others' art"
sudo hubctl asset accept did:plc:...
```

**People's pictures on the map** are moderated the same way. `hubctl
assets` lists them by account; blocking a picture's hash stops it being
shown or served; `asset refuse` with a person's DID means they get no
picture at all (a dot instead). A profile that labels itself with content
the hub's directory doesn't list (the labels Bluesky accounts put on
themselves: nudity, graphic media, and so on) gets no picture either, with
nothing for you to do.

Anyone can report a piece from the gallery (its **Report** link), as "Art
on the hub" or "Art copied without permission"; `hubctl abuse report ID`
then shows its hash. Art a BBS withdraws (stops publishing or offering, or
replaces) is let go of on its own, files and all.

**3D models** BBSes publish are off until you turn them on, and then come
only from the BBSes in `assets.boardArt`:

```json
"assets": { "boardArt": ["coolbbs"], "models": { "enabled": true } }
```

with `maxBytes` (the largest model file, 8 MB), `perBoard` (5) and
`totalBytes` (200 MB for all of them) beside `enabled` if you want others.
The hub checks each model and its preview picture, keeps cleaned copies in
`board-models/` beside the database, lists them in the gallery by their
picture, and gives each a page (`/art/` and the first 12 digits of its
hash) where people can turn it and play its animations. `hubctl assets`
lists models with the rest, and `asset block`, `asset refuse` and reports
work on them as on art. Keep them off for BBSes other than your own until
your terms cover them.

### Live objects

A **live object** is something a BBS publishes that the hub keeps up to
date by running a small program, such as the weather in a town. The program
is a WebAssembly module the BBS publishes with its source. The object names
the program and gives it its input, such as a place. The hub shows each
object as a badge by its BBS on the map, as a line in the BBS door's map,
and on a page of its own (`/objects/<bbs>/<name>`) with its readings, its
credits, its program and its source. (See the build spec,
[build_live_object_slice.md](../development/build_live_object_slice.md),
and [compute.md](../development/compute.md) for the design.)

They are **off** until you turn them on, and then the hub runs only:

- objects from the BBSes you list;
- programs you have vetted, by the SHA-256 hash of their module;
- fetches to sites that both the program's manifest and your `fetch` list
  allow.

```json
"compute": {
  "enabled": true,
  "owners": ["test2"],
  "programs": ["a37a816ebddd31c0a301c58a8e2531c3097ef0cd4e8468e3bb4f6a2c6530869e"],
  "fetch": ["api.open-meteo.com", "geocoding-api.open-meteo.com"]
}
```

Restart the hub after changing it (`sudo systemctl restart hub-control`).
`"owners": "registered"` takes objects from every BBS registered here. Keep
to your own BBSes until the program runner has had an outside security
review and your terms cover objects.

**The limits.** Each is a default you can change, beside the settings
above:

| Setting | Default | What it limits |
|---|---|---|
| `minInterval` | 600 | The fewest seconds between an object's updates (60 to 86400). |
| `maxObjects` | 50 | Objects in all (0 to 10000). |
| `perOwner.objects` | 3 | Objects from one BBS (0 to 1000). |
| `perStep.fuel` | 50000000 | Instructions in one step of a program, counted as it runs. |
| `perStep.memoryPages` | 16 | A program's memory, in 64 KB pages (1 MB). |
| `perStep.ms` | 2000 | The time one step may take, as a backstop to fuel. |
| `perStep.fetches` | 2 | The fetches one step may ask for (0 to 8). |
| `perStep.fetchBytes` | 16384 | The largest reply a program is given. |

For example, `"perOwner": { "objects": 5 }` lets each BBS have five.

**Vetting a program.** When an object names a program you haven't listed,
the hub doesn't fetch it, and logs once an hour:

```
board objects: test2's Weather in Berlin runs a program the hub hasn't vetted (<hash>)
```

To vet it:

1. Read its source: the object's page shows it, and the hash.
2. If you can, build the source and check that it gives the same hash. The
   weather program's README in [programs/weather/](../../programs/weather/)
   shows how; the hub doesn't check this itself yet.
3. Check the sites its manifest reaches and the terms of their services.
   Open-Meteo, for example, is free for non-commercial use only, and wants
   its credit shown next to its data.
4. Add its hash to `programs`, and the sites you allow to `fetch`, then
   restart.

Before you allow a new site, think about what the hub's address asks it.
Every object's input goes to the sites its program reaches, from the hub.
Name the service in the privacy notice (§8) as Open-Meteo is.

**Watching them.** The hub reads objects within half a minute of starting
and then every hour, and sooner when a BBS publishes a change. Each runs at
its own interval. An object's page shows its last reading, when it was
updated, and its last log lines. One that misses three updates in a row is
shown as **not updated lately**, in grey on the map, keeping its last
reading. Fetches and refusals show in the hub's log, under `live objects:`
and `board objects:`. The hub keeps everything under `board-objects/`
beside the database: programs' files, the objects it took, and each
object's last state (`running/state.json`).

**Taking one down.** Programs are moderated as art is:

- `hubctl assets` lists them.
- `hubctl asset block <hash>` on a program's module (or its source) stops
  every object that runs it, on every BBS.
- `hubctl asset refuse <did>` takes no objects or programs from that
  account.
- To stop one BBS's objects, take its name out of `owners` and restart.
- To stop them all, set `enabled` to `false` and restart.

Objects a BBS takes off its list are let go of on their own.

### The record

Bans and unbans, suspensions and resumptions, blocks and unblocks (of
people and of art), and reports of both kinds as they come in and are
closed all go in the moderation log (by number, never what they say):

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
