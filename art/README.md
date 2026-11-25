# The project's own ANSI art

ANSI art made for Nexus Lounge, so the hub and its test boards have art
that is free to use, show, change and share. It is drawn by code
([make.ts](make.ts)): block letters from an alphabet made here (not taken
from any font), turned into ANSI's half-block characters.

| File | What | Size |
|---|---|---|
| `TEST2.ANS` | The second test board's logo, pink and white | 78 × 15 |
| `TEST2EMB.ANS` | Its emblem for the hub's map: a pink diamond with T2 | 14 × 4 |
| `NEXUS.ANS` | A "Cyberspace Nexus" banner for the hub, cyan on black | 78 × 13 |

To draw them again after changing `make.ts`:

```sh
node art/make.ts
```

To offer them on a hub, bake them (hub plan H20; [hub README](../hub/README.md)):

```sh
cd hub/control
npm run bake -- --out ./art --font cp437-8x16.psf --licence CC-BY-4.0 \
    --licence-url https://creativecommons.org/licenses/by/4.0/ ../../art/*.ANS
```

Their SAUCE records credit "Nexus Lounge" of "cyberspace.nexus", so the
baker needs no `--author`.

## Licence

The art in this directory is under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), like the
project's docs: use it, change it and share it, crediting Nexus Lounge.
`make.ts` is code, under the project's BSD 2-Clause licence.
