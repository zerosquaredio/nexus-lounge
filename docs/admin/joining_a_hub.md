# Joining a Hub: a Sysop's Guide

How to put your BBS on a Nexus Lounge hub, such as `hub.cyberspace.nexus`,
from nothing to listed: what you need, registering, the tunnel agent, the
board's settings, its own Bluesky account, and leaving again. It is written
for sysops who are at home in a Linux shell and with Docker; it doesn't
assume you've run ENiGMA½ before.

The examples use a board called `coolbbs` on the hub `hub.example`. Put in
your own names; on the public hub that's `coolbbs.hub.cyberspace.nexus`.

> **Before you start:** the public hub registers new boards by arrangement
> with its admin while it is being tested. Its sign-in page says whether
> registration is open. If it isn't, write to the address at the foot of
> its front page.

## 1. What a hub does for you

A hub gives your board a public address, `https://coolbbs.hub.example`,
even when the board runs at home behind a router with no open ports. Your
board runs a small **tunnel agent** that connects *out* to the hub and
carries visitors' connections back in. The hub then:

- serves your board's page at that address, with a **Connect in your
  browser** button (the web terminal, enig-term) and an offline page, with
  your hours, when the board is down;
- answers for the Bluesky handle `@coolbbs.hub.example`, if you want your
  board's own account to have it;
- lists your board in its directory, from the listing your board publishes
  on Bluesky;
- if you and your members want it, shows them in the hub's common space,
  where people from all its boards see each other and chat.

Only web traffic goes through the hub: the terminal's WebSocket and the
sign-in pages. SSH and telnet don't. If you want those, open them on your
own address as usual.

## 2. What you need

- **A machine to run the board.** A small server, a home VM or a spare
  machine all work, with about 1 GB of memory free. It needn't be up all
  the time: give your hours (§6.3) and the hub shows them while you're
  off.
- **Docker**, or Node.js 22 or later to run it without Docker.
- **The tunnel agent:** [frp](https://github.com/fatedier/frp/releases)'s
  `frpc`. The hub is tested with **0.72.0**; use that or later. Only the
  `frpc` binary is needed.
- **Your own Bluesky account,** to sign in to the hub and to your board as
  its sysop. It must be at least 30 days old to register a board (the
  hub's default; the sign-in page says if yours is too new, and when it
  won't be).
- **A second Bluesky account, for the board itself** (§7). It publishes
  the board's listing, so the board speaks for itself rather than through
  your personal account. Any Bluesky account will do, with its own email
  address (with Gmail, `you+coolbbs@gmail.com` counts as a new one).
- **A name** for the board on the hub: 2 to 32 characters, lower-case
  letters, digits and single hyphens, not starting or ending with a
  hyphen. Some names are kept for the hub (`www`, `admin`, `chat`, `test`
  and the like). It becomes part of the address, so choose with care: if
  you remove a board later, its name stays held for 90 days.

## 3. Get ENiGMA½ with AT support

Hub boards run ENiGMA½ from the Cyberspace Framework's fork, branch
`atproto-login`, which adds Bluesky login, the board's own account and the
hub's features. There is no ready-made image yet, so build one:

```sh
git clone -b atproto-login https://github.com/zerosquaredio/enigma-bbs.git
cd enigma-bbs
docker build -t enigma-bbs:hub -f docker/Dockerfile .
```

The build takes several minutes. Then make the folders the board keeps
outside the container, and run it once, interactively, to write a starter
config:

```sh
sudo mkdir -p /srv/coolbbs/{config,db,logs}
docker run -it --rm \
  -v /srv/coolbbs/config:/enigma-bbs/config \
  -v /srv/coolbbs/db:/enigma-bbs/db \
  -v /srv/coolbbs/logs:/enigma-bbs/logs \
  enigma-bbs:hub
```

It asks for the board's name, its first message area and a few other
basics (`oputil.js config new`), writes `config/config.hjson` and the menu
files under `config/menus/`, and starts the board. Stop it (Ctrl-C) once
it says it's up: the next sections change the config before the board goes
on the hub.

Without Docker, follow ENiGMA½'s
[installation docs](https://github.com/zerosquaredio/enigma-bbs/tree/atproto-login/website/src/content/docs/installation)
with the fork's repository in place of upstream's.

> **Keep your art in `config/`.** If you add your own art, keep it under
> the `config` folder (for example `config/art/`) and point the config at
> it. The image's `art/` folder isn't one you keep between versions.

## 4. Register on the hub

1. Open the hub's site and choose **Sign in** (or "Run a BBS? Register it
   on this hub"). Sign in with **your own** Bluesky handle, confirming the
   hub's minimum age and its
   [terms](https://hub.cyberspace.nexus/terms) and
   [privacy notice](https://hub.cyberspace.nexus/privacy). The hub asks
   Bluesky only who you are: it can't post or read anything in your
   account.
2. On **Your BBSes** (`/bbs`), fill in the form:
   - **Name:** the board's name on the hub (§2).
   - **Ports:** where the agent will find your board on its own machine.
     Leave them at **8080** (web) and **8810** (WebSocket) unless you
     change them in §6.
   - **Your BBS's own Bluesky account:** the board's account (§2), by
     handle or DID. You can leave it empty and set it later on the same
     page.
   - **A note for the admin** (when the hub approves boards by hand):
     anything that helps, such as what the board is about.
   - **The rating:** confirm your board is suitable for the audiences the
     hub lists. The public hub lists all-ages boards only.
3. **Wait for approval.** The page shows your application as waiting, with
   a **Withdraw** button. The hub doesn't email you: check back. If it is
   turned down, the page says why for 30 days, and you may apply again.
4. **Once approved,** your board appears in the table. Press **New token**
   to get its **agent config**.

> **The agent config is shown once.** It holds your board's token, which is
> its password on the hub. Copy it straight away into a file on the
> board's machine, `coolbbs-agent.toml`, readable only by you. If you lose
> it, press **New token** again: the old token stops working at once.

A sysop may register up to 3 boards on a hub, counting applications still
waiting.

## 5. Run the tunnel agent

The agent config tells `frpc` where the hub is, checks the hub's
certificate before sending your token, keeps a heartbeat going (the hub
closes a tunnel without one), and forwards only the paths the hub carries:
`/ws` to the board's WebSocket port, and the sign-in pages and `/assets/`
to its web port. You don't need to change anything in it.

Try it by hand first:

```sh
frpc -c coolbbs-agent.toml
```

It should log that it logged in to the server and that the `ws` and `web`
proxies started. Then run it as a service, so it comes back after a
restart. With systemd, as a user of its own:

```ini
#  /etc/systemd/system/coolbbs-agent.service
[Unit]
Description=Tunnel agent (frpc) for coolbbs on the hub
After=network-online.target
Wants=network-online.target

[Service]
User=coolbbs
ExecStart=/usr/local/bin/frpc -c /srv/coolbbs/agent.toml
Restart=always
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

```sh
sudo useradd --system --no-create-home coolbbs
sudo install -o coolbbs -m 600 coolbbs-agent.toml /srv/coolbbs/agent.toml
sudo systemctl enable --now coolbbs-agent
```

If the hub is down or restarting, the agent keeps trying; it reconnects by
itself. Your board's row on **Your BBSes** shows **connected** once the
agent is in.

## 6. Set the board up for the hub

All of this goes in `config/config.hjson` (in `/srv/coolbbs/config/`).
`config new` doesn't ask about any of it yet. Each setting is explained in
the fork's
[AT Protocol docs](https://github.com/zerosquaredio/enigma-bbs/blob/atproto-login/website/src/content/docs/servers/contentservers/atproto-handler.md);
this is what a hub board needs.

### 6.1 The settings

Merge these into the config (the blocks may exist already; add the keys to
them). Replace `coolbbs`, the hub's address and the DID.

```hjson
contentServers: {
    web: {
        //  the board's address on the hub
        domain: coolbbs.hub.example
        overrideUrlPrefix: "https://coolbbs.hub.example"
        //  connections come through the agent, on this machine
        proxied: true
        http: {
            enabled: true
            port: 8080
        }
        handlers: {
            atProto: {
                enabled: true
            }
        }
    }
}

loginServers: {
    webSocket: {
        //  the hub took the connection over https: it counts as secure
        proxied: true
        ws: {
            enabled: true
            port: 8810
        }
    }
}

users: {
    //  Bluesky login only (leave this out to keep passwords as well)
    allowedAuthFactor1Types: [ "atproto" ]
}

atProto: {
    enabled: true
    oauth: {
        //  the board signs its requests with a key of its own, made at
        //  first start; required behind a hub
        clientMode: public
    }
    login: {
        //  your own DID: you become the sysop the first time you log in
        rootDid: "did:plc:your-did-here"
    }
    //  "Connect in your browser" on the hub signs people in on the web
    webSignIn: {
        enabled: true
    }
    admission: {
        //  who may join: open, invite, invite-code, sysop-approval
        policy: [ "open" ]
    }
    hub: {
        //  the hub's own address
        url: "https://hub.example"
        //  "subdomain" and "metadatas.token" in your agent config
        name: coolbbs
        token: "@file:security/hub_token"
        presence: {
            enabled: true
        }
    }
    publishing: {
        enabled: true
        listing: {
            description: "Door games and ANSI art since 1994"
            tags: [ "doors", "ansi" ]
            howToJoin: "Log in with Bluesky and apply"
            rating: general
        }
    }
}
```

Notes:

- **Your DID** is the permanent ID behind your handle. To find it, open
  `https://bsky.social/xrpc/com.atproto.identity.resolveHandle?handle=you.bsky.social`
  in a browser. Only that DID can become the board's first user, who is
  its sysop. Without `rootDid`, a board that allows Bluesky login only has
  no way to get a sysop.
- **The token** is kept in a file of its own rather than in the config:
  copy the value of `metadatas.token` from the agent config (without the
  quotes) into `config/security/hub_token`, readable only by you. A path
  after `@file:` is taken from the config's folder. If the file can't be
  read, the board only logs a warning and the hub refuses its reports, so
  check the log after starting (§6.4). When you press **New token** on the
  hub, change it in both places.
- **Ports:** if you change 8080 or 8810, register the same ones on the hub
  (they're in the agent config it makes).
- **Admission** decides who becomes a member once they've logged in with
  Bluesky. `open` lets anyone in. The fork's docs describe the others
  ([Admission](https://github.com/zerosquaredio/enigma-bbs/blob/atproto-login/website/src/content/docs/servers/contentservers/atproto-handler.md#admission)).
- **The rating** must be one the hub lists, or the board isn't listed. On
  the public hub that's `general`.

### 6.2 The menus

Several of the screens the hub needs are in the menu files but commented
out, so a board offers nothing it isn't set up for. In
`config/menus/` (the files `config new` wrote, named after your board):

- **The login menu** (`…-login.hjson`): uncomment the **bluesky login**
  option on the login matrix:

  ```hjson
  {
      text: bluesky login
      data: atproto
  }
  ```

- **The main menu** (`…-main.hjson`): one commented out block holds four
  commands. Uncomment it to get them:
  - `AT`: a member's own Bluesky settings (linking an account);
  - `BA`: the **board account** screen, for sysops (§7);
  - `HP`: **hub presence**, where members choose whether the hub shows
    them;
  - `HS`: the **hub's space** as a door: who is around on the hub, and its
    chat room.

  The stock main menu art doesn't name these commands; add them to your
  art, or tell your members.

### 6.3 Hours (for boards that aren't always up)

If the board runs only some of the time, say when, and the hub shows it on
the board's page and in the directory while you're off:

```hjson
atProto: {
    publishing: {
        listing: {
            hours: {
                timezone: "America/Los_Angeles"
                weekly: [ { days: [ "fri", "sat" ], from: "19:00", to: "23:00" } ]
                note: "Weekend evenings"
            }
        }
    }
}
```

### 6.4 Start the board

Run the container for good, publishing its ports **to this machine only**
(the agent is the only thing that should reach them):

```sh
docker run -d --name coolbbs --restart unless-stopped --memory 1g \
  -p 127.0.0.1:8080:8080 -p 127.0.0.1:8810:8810 \
  -v /srv/coolbbs/config:/enigma-bbs/config \
  -v /srv/coolbbs/db:/enigma-bbs/db \
  -v /srv/coolbbs/logs:/enigma-bbs/logs \
  enigma-bbs:hub
```

Check its log (`/srv/coolbbs/logs/enigma-bbs.log`, one JSON line per event)
for warnings about the config or the token file.

Then open `https://coolbbs.hub.example`: your board's page, marked online.
Press **Connect in your browser**, choose **bluesky login**, enter your
handle and approve in the browser. As `rootDid`, you become user #1, the
sysop. Fill in the application that follows.

## 7. The board's own account

Your board's listing, status and announcements are published from its own
Bluesky account (§2): this is how the hub's directory learns about it. Two
steps tie it in:

1. **Tell the hub which account it is,** on **Your BBSes** ("Your BBS's
   Bluesky account"), if you didn't when registering.
2. **Connect it to the board.** Logged in as the sysop, open **BA** from
   the main menu, enter the board account's handle and press ENTER, then
   approve in a browser (with the link, or the QR code shown at the bottom
   right, from a phone). Sign in to Bluesky **as the board's account** when
   you approve, not your own.

The board asks only for what it needs: to write its listing and status
records and its art, to post, and to upload files. Once connected it
publishes its listing straight away, and again whenever the config
changes. Your board's row on **Your BBSes** then shows **listed**; if it
says "not listed yet", the listing doesn't name the board's hub address
yet (check `overrideUrlPrefix`), or the hub hasn't seen it yet (it can take
a few minutes).

From **BA** you can also post an announcement, publish the listing at once,
turn the splash screen on or off, or disconnect the account. The same
things are at the shell, with the board running or not:
`./oputil.js atproto board`, `publish`, `status`, `post`, `splash on|off`
(in Docker: `docker exec -it coolbbs ./oputil.js atproto board`).

**Optionally, a handle under the hub,** such as `@coolbbs.hub.example`,
which shows people the account really is the board at that address: see
[A BBS's AT Account and Hub Handle](bbs_account.md) §4.3.

> **If the board asks to be connected again:** the names of the records the
> board publishes are still drafts (`nexus.cyberspace.dev.*`). When they
> become final, or the board publishes something new, **BA** and
> `./oputil.js atproto board` say the account must be connected again.
> Connecting again keeps everything else.

### 7.1 Its splash screen and emblem

With the account connected, the board offers the hub its login screen as a
**splash**, the picture the hub shows for it in the directory and on its
page, and, if you set `atProto.publishing.emblem.art`, a small **emblem**
for the hub's map. Connecting turns the splash on; **splash** on **BA** (or
`./oputil.js atproto splash off`) turns it off, and the hub stops showing
it within minutes. Only offer art that is yours to share: the stock theme's
art belongs to its artists. See [Where your art lives](../user/where_your_art_lives.md).

The hub shows boards' own art only once its admin has turned it on for
them, which on the public hub waits for its terms to cover art. Until
then it shows a splash of its own choosing.

## 8. Your members and the hub

- **Logging in.** Members choose **bluesky login** and approve in a
  browser, or press **Connect in your browser** on the board's page, which
  signs them in on the web. Over SSH, after a Bluesky login, they're
  offered the SSH key they connected with, so next time they can skip the
  browser.
- **Being shown on the hub** is each member's choice, off until they turn
  it on with **HP**. You can keep anyone off the hub, whatever they choose:
  `./oputil.js user hub USERNAME withhold` (`allow` undoes it). The board
  tells the hub only which members who chose it are on, by their Bluesky
  ID and user name here; nothing is published.
- **The hub's space** (**HS**) shows who is around on all the hub's boards,
  and its chat room. Members who confirmed your board at the hub can talk
  there. The hub's admin moderates it, and members can mute and report
  people from inside it.

## 9. Keeping it running

- **Updating** the board: pull the branch, build a new image, then stop and
  remove the container and run it again from the new image, with the same
  `docker run` line (§6.4). Your config, database and logs are in the
  folders you gave it.
- **Back up** `/srv/coolbbs/config` and `/srv/coolbbs/db`. They hold the
  board's signing key (`config/security/atproto_oauth_key.json`), the hub
  token, and the members' sessions: keep them private.
- **A new token:** press **New token** on **Your BBSes**, then put the new
  agent config in place of the old one, the token in `hub_token`, and
  restart the agent and the board.
- **Status for monitors:** `https://hub.example/status.json?bbs=coolbbs`
  answers 200 while the board is connected and 503 when it isn't, for an
  uptime monitor to watch.
- **Limits:** the hub limits each board's traffic (1 MB a second each way
  on the public hub), plenty for terminals.

## 10. If something doesn't work

| Symptom | Likely cause |
|---|---|
| The agent logs a certificate error | The machine's clock is wrong, or its certificate authorities are out of date (`ca-certificates`) |
| The agent logs "token" or login failures | The token in the agent config is old (a new one was made), or the board was suspended (**Your BBSes** says why) |
| The agent is connected, but the board's page says offline | The board isn't running, or not on the ports in the agent config |
| **bluesky login** says to use a secure connection | `loginServers.webSocket.proxied` isn't `true` |
| Approving in the browser ends on an error page | `overrideUrlPrefix` isn't the board's hub address, or `clientMode` isn't `public` |
| Your first Bluesky login is refused (the log says "Only atProto.login.rootDid may become the first user") | `rootDid` isn't your DID, or you approved as another account |
| The board is "not listed yet" | The board account isn't connected (§7), the listing doesn't name the hub address, or its rating isn't one the hub lists |
| Members don't appear on the hub | They haven't turned it on (**HP**), the token file isn't read (see the board's log), or the hub has no common space |

## 11. Leaving the hub

On **Your BBSes**, type the board's name and press **Remove**. The tunnel
stops, the hub stops answering for its handle, and its listing leaves the
directory. The name is held for 90 days, so nobody else takes it straight
away; the hub's admin can free it sooner. Stop and remove the agent
yourself.

The board keeps its own Bluesky account and everything published from it.
If it moves to another hub or its own address, change `overrideUrlPrefix`
and the hub settings; with `atProto.publishing.triggers.moved` on, the
board posts its new address for its followers.

A suspended board can't be removed, given a new token or a new account by
its sysop: ask the hub's admin, at the address the page gives.
