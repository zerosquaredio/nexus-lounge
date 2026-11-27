# Media Sources: Where Free Art Comes From

Last updated: 2026-11-27

Places to find pictures, textures, 3D models, sounds and fonts that the
project, or a sysop, may remix. What matters is the licence of **each
item**, not the site: many sites mix licences, and the item's own page
says which applies. Check it every time, and keep its name, author and
link with what you make from it.

## 1. What can go into the project's own art

The project's art (`art/` in the hub's repo, the fork's own theme, test
models) is released under **CC BY 4.0**, so anyone may reuse it. A source
can go into it only if its licence lets a remix be released that way:

| Licence of the source | Into our CC BY art? | What we owe |
|---|---|---|
| **CC0**, or public domain | Yes | Nothing, but credit anyway |
| **CC BY** (any version) | Yes | Credit the author, link the licence, say what we changed |
| **CC BY-SA** | No: a remix must stay BY-SA. Use it only in something released under BY-SA itself | Credit, and the same licence |
| **Any NC** (non-commercial) or **ND** (no derivatives) | No | — |
| **A site's own licence** (Pixabay, Unsplash, Pexels) | No, as far as we can tell: they allow modifying, but grant no right to release a remix under another licence, and only their full terms are binding | Fine for inspiration and colour schemes, and for a sysop's own board art |
| **No licence stated** | No: all rights reserved | — |

Not copyrightable, so free to use whatever the source: a **colour
scheme**, a **style** or genre (synthwave's grid and sun), an **idea**.
The first synthwave screen took its palette from a Pixabay image and
drew everything itself.

**AI-generated images** (decided 2026-11-27): treated as free to use,
since in the US a purely AI-generated image gets no copyright, which
needs a human author. With three cautions: the creator's word is what
says it is AI-generated (any hand-editing would be theirs); the site's
own terms still bind whoever downloads it (Pixabay's grant no right to
relicense, a small risk we accept); and an AI image can resemble
someone's work or a real person, so look first. Credit the source all
the same. Our own changes to one (drawn parts, hand finishing) are ours,
and released under CC BY with the rest. The first: the main menu's
figure, from BrianPenny's image on Pixabay (7499159).

Never, whatever the licence: **logos and trademarks** (the Khronos and
Cesium logos inside some sample models, NASA's insignia), and **people's
faces** without a model release.

## 2. Sites

### Free for anything (CC0 or public domain)

| Site | What | Notes |
|---|---|---|
| [Openverse](https://openverse.org) | Search across many sites' openly licensed pictures and sounds | Filter by licence (CC0, public domain); check the item's own page |
| [Wikimedia Commons](https://commons.wikimedia.org) | Pictures, diagrams, sounds, video | Licence per file: many CC0 and public domain, many BY-SA |
| [Poly Haven](https://polyhaven.com) | HDR skies, textures, 3D models | All CC0 |
| [ambientCG](https://ambientcg.com) | Textures and materials | All CC0 |
| [Kenney](https://kenney.nl) | Game art: sprites, tiles, UI, low-poly 3D models | CC0 |
| [Quaternius](https://quaternius.com) | Low-poly 3D models, many animated | CC0 |
| [NASA Image and Video Library](https://images.nasa.gov) | Space photos and video | Generally not copyrighted; insignia and some third-party images excepted |
| [Smithsonian Open Access](https://www.si.edu/openaccess) | Museum pictures and 3D scans | Items marked CC0 |
| [The Met Open Access](https://www.metmuseum.org/about-the-met/policies-and-documents/open-access) | Artworks | Items marked Open Access are CC0 |

### Free with credit (check each item)

| Site | What | Notes |
|---|---|---|
| [Sketchfab](https://sketchfab.com) | 3D models | Filter to downloadable, CC BY or CC0; many are BY-NC or BY-SA |
| [Khronos glTF Sample Assets](https://github.com/KhronosGroup/glTF-Sample-Assets) | 3D models made to test glTF | Licence per model in its `metadata.json`: CC0, CC BY, and some others (SCEA for the Duck); several carry logos |
| [OpenGameArt](https://opengameart.org) | Game art, sounds, music | Mixed: CC0, CC BY, BY-SA, GPL per item |
| [Freesound](https://freesound.org) | Sound effects | Per sound: CC0, CC BY, or BY-NC |
| [Free Music Archive](https://freemusicarchive.org) | Music | Per track; many NC |

### Inspiration only, for the project's own art

| Site | What | Notes |
|---|---|---|
| [Pixabay](https://pixabay.com) | Photos and illustrations, much cyberpunk and synthwave | Pixabay Content License: modify freely, no credit needed, but no grant to relicense |
| [Unsplash](https://unsplash.com), [Pexels](https://www.pexels.com) | Photos | Their own licences, as for Pixabay |

### ANSI and text art

| Site | What | Notes |
|---|---|---|
| [Roy/SAC's ANSI gallery](http://www.roysac.com/roy_ansishow.html) | Roy of Superior Art Creations' own ANSI and ASCII art, nearly all of it, with a zip of the lot | **Public domain:** he released all his own ASCIIs and ANSIs in 2006 ([his post](http://www.roysac.com/blog/2006/07/important-decision-made-regarding-my-text-art/)), free to download, change and use. He asks, as thanks, not as a condition, for his name and a link to his site: give both. Only his own art: other artists' work on the site, the TheDraw font collection and his tools come with no such terms |
| [16colo.rs](https://16colo.rs) | The ANSI art scene's archive | The art belongs to its artists: ask before using any |

### Themes and colour schemes

| Source | What | Notes |
|---|---|---|
| [Netrunner theme for Omarchy](https://github.com/Pierre-Aoki/omarchy-netrunner-theme) | A cyberpunk desktop theme: a crimson, yellow and turquoise palette on red-tinted black, mapped onto all 16 ANSI colour slots (`colors.toml`), generated backgrounds built from text (hex grids, corner brackets), and the Python generators that drew them | **MIT** for the palette, the generators and the six backgrounds numbered `1-` to `6-` (keep the copyright notice). Its `wallhaven-*` backgrounds are **not** covered: their artists are unknown. Good for a hub view (assets spec §3.6) and for text-made screens. Some of it is styled after the game Cyberpunk 2077 ("Breach Protocol"): take the general look, not the game's own screens or names |

### Fonts

| Source | Notes |
|---|---|
| [The Ultimate Oldschool PC Font Pack](https://int10h.org/oldschool-pc-fonts/) | CC BY-SA 4.0; the hub draws art with its IBM VGA font (credited on the art page). Drawing with a font doesn't make the picture BY-SA |

### Tools

| Tool | What | Notes |
|---|---|---|
| [Moebius](https://github.com/blocktronics/moebius) | A free, open-source editor for ANSI art in the 16 colours and the IBM PC character set | For finishing art by hand: tidying stray pixels after a conversion, as ANSI artists do |
| The project's own scripts (`art-drafts/scripts/`, not in git yet) | Picture to 16-colour ANSI with half-blocks, with cleaning and a limited palette; a figure on a drawn, shaded background; pieces drawn from code; a preview drawn by the hub's own renderer | What made the first theme art |
| [ANSI-Art](https://github.com/EtoDemerzel0427/ANSI-art) (Apache-2.0) | Pictures and GIFs to coloured text in a terminal | **Truecolour only** (24-bit, Unicode): BBS clients and the hub show 16 colours in the IBM PC character set, so its output doesn't carry over. Its plain ASCII mode (characters chosen by how dark they look) does |
| [image-to-ansi](https://dom111.github.io/image-to-ansi/) | In the browser: a picture to coloured half-blocks | Truecolour too, as above |

## 3. When using one

1. Save the item's page address, author and licence as you download it.
2. Credit it where the result lives: in the SAUCE record of ANSI art (its
   author and group fields, and a comment), in an asset record's
   `credit` and `licence`, and in a list beside the files (as
   `test/fixtures/models/README.md` does for the test models).
3. Say what was changed ("converted to ANSI", "recoloured").
4. Keep logos out.
