# Related Tools

Software that may be useful around Nexus Lounge boards and the hub: making
art for boards, testing terminals, and the pieces the hub is built from. A
list to grow as we find things; an entry here is not a dependency.

Each entry says what it is, where it comes from, and why it might matter to
us. "Checked" is when someone last looked at its page.

## ANSI art

### TheDraw

| | |
|---|---|
| What | A DOS program for drawing ANSI screens, a mainstay of the BBS scene. By Ian E. Davis |
| Where | [syaross.org/thedraw](https://www.syaross.org/thedraw/): `TDRAW463.ZIP` (version 4.63), and two font packs by the page's author (`TDCALVIN.ZIP`: Calvin, CalvinLight, CalvinSmCaps, Classic; `TDHOBBES.ZIP`: Hobbes) |
| Version | 4.63. The page says it is the last real release, and that 5.00 and anything later is fake |
| Licence | Not stated on the page |
| Running it | The page says it works in [DOSBox](https://www.dosbox.com/), which has ANSI support |
| Why for us | Making or touching up art for board menus and themes (ENiGMA½ themes are ANSI art), and TheDraw's fonts for large lettering. ENiGMA½ doesn't read TheDraw's own font files itself as far as we know (no mention in its source or docs, checked 2026-11-23) |
| Checked | 2026-11-23 |

## Already in use

For reference: what the hub and the test boards are built from. Versions and
checksums are pinned where they are installed (the hub's README, the fork's
Dockerfile).

| Tool | Role |
|---|---|
| [ENiGMA½](https://github.com/NuSkooler/enigma-bbs) | The BBS software (our fork adds AT login and the hub integration) |
| [enig-term](https://github.com/NuSkooler/enig-term) | The browser terminal, served by the hub and by boards |
| [frp](https://github.com/fatedier/frp) | The hub's tunnels (frps on the hub, frpc next to each board) |
| [Caddy](https://caddyserver.com/) | The hub's edge: HTTPS with certificates made on demand |
| [freeq](https://github.com/freeq-irc/freeq) | The hub's chat server, which knows people by DID |
| [three.js](https://threejs.org/) | Draws 3D models in the browser for the hub's model viewer. Licence MIT. Version 0.187.0, the npm package `three`, copied into the repo (`hub/control/vendor/three`, with its licence and each file's checksum) and served from the hub's own address, never a CDN |
