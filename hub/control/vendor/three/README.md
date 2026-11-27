# three.js, as copied into the hub

The hub's 3D model viewer (`web/model_viewer.js`) draws with
[three.js](https://threejs.org/). This folder is a copy of the parts of it
the viewer uses, served by the hub from its own address. Nothing here is
fetched from a CDN or built: the browser runs these files as they are.
It is the hub's only third-party script
([build spec](../../../../docs/development/build_3d_slice.md), decision 1).

| | |
|---|---|
| Package | [`three`](https://www.npmjs.com/package/three) on npm |
| Version | **0.187.0** (release r187, published 2026-10-30) |
| Licence | MIT: see `LICENSE`, copied from the package |
| Tarball | `three-0.187.0.tgz`, SHA-256 `ff540832ded0cfe919764d24a3d88f3e2a05f23303f876423e4f893841e90728`, npm's own `shasum` `face29ee2de9bcc31a1b573a76f224e35e0b2894` |
| Copied | 2026-11-26 |

## The files

Each file is at the same path here as in the package, under `package/` in
the tarball.

| File | What it is | SHA-256 as copied |
|---|---|---|
| `LICENSE` | The licence | `8b378ebe60e2fe500158cb0ac71cb5e8b7d92953c2abcc63a0eb90499653b5bc` |
| `build/three.module.js` | The library as a module (the WebGL renderer). Imports `./three.core.js` | `104f56145899722094556490d787aae0617cc2fc3382f31df02d724ea1aee341` |
| `build/three.core.js` | The rest of the library, which the file above imports | `613e370f76638fdef83926642bf256dc9615684922de1ce1f63a8583e5d78578` |
| `examples/jsm/loaders/GLTFLoader.js` | Reads `.glb` models | `008ec07cc51409a175fe6f9e24d9998a97069e1de0a42298cd9fdad93bf2bc22` |
| `examples/jsm/controls/OrbitControls.js` | Turning and zooming with mouse and touch | `c7980ea949c527a829cf7416afa8f4dcf50aff31079685e6827d188d3635cc34` |
| `examples/jsm/utils/BufferGeometryUtils.js` | Imported by the loader | `fa8b3930d2c5bc6366516c636dee51fedcaecf51bfd3c245b350bda655fe194b` |
| `examples/jsm/utils/SkeletonUtils.js` | Imported by the loader | `9e53f7de94e1a632b88113536c1c404e243dac973bad2e8e6d514ff49b569e65` |

This release of the package has no minified build (`build/` holds only
the full files), so the full ones are copied: about 2.1 MB together
before the web server compresses them.

## The one change

The four files under `examples/jsm/` import the library by its package
name, which a browser cannot follow without an import map or a build step,
and the hub's pages have neither. In each, that one line:

    } from 'three';

is changed to:

    } from '../../../build/three.module.js';

Nothing else is changed. `LICENSE` and the two files under `build/` are
byte for byte the package's. The line ends are the package's (LF), which
the repo's `.gitattributes` keeps.

## Checked by a test

`test/viewer_files.test.ts` fails if a file here does not match its
SHA-256 above, if a file is here that the table does not list, if any
import names a package or an address and not a file in this folder, or if
any of the code names a web address to fetch from.

## Updating

1. Choose a stable release at least two weeks old, and read its
   [migration notes](https://github.com/mrdoob/three.js/wiki/Migration-Guide)
   for the loader, the controls and the renderer.
2. In a scratch folder outside the repo: `npm pack three@<version>` and
   unpack the tarball. Do not add the package to `package.json`.
3. Copy the files in the table from `package/` to the same paths here.
   See what the copied files import (`grep -n "^import\|^} from"`) and
   copy anything new they ask for; remove anything no longer imported.
4. Make the one change above in each file under `examples/jsm/`.
5. Put the new version, date, tarball hash and each file's SHA-256
   (`sha256sum`) in this file, and update the list of files in
   `test/viewer_harness.ts` if it changed.
6. Run `node --test test/viewer_files.test.ts`, then try every sample
   model in a real browser with `node test/viewer_harness.ts 8917`.
7. Update the version in `docs/admin/related_tools.md`.
