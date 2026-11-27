//  A small local server for trying the model viewer in a real browser, as
//  the hub will serve it: a bare page, the copy of three.js, the viewer and
//  the sample models, all from one address, under the model page's own
//  Content-Security-Policy. Not a test by itself (node --test does not pick
//  it up): a person or a browser-driving test opens what it serves.
//
//      node test/viewer_harness.ts <port> [--strict-styles]
//
//  It listens on 127.0.0.1 only, serves a fixed list of files and nothing
//  else, and prints each request, so that anything the page asked for can be
//  seen. --strict-styles drops 'unsafe-inline' from style-src, to show that
//  the viewer does not need it.

import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { editGlb } from './glb.ts';
import type { Json } from './glb.ts';

const here = dirname(fileURLToPath(import.meta.url));
const control = join(here, '..');
const modelsDir = join(here, 'fixtures', 'models');

//  the policy the model page is to have (build_3d_slice.md §5)
export const ViewerPolicy =
    "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self' blob:; style-src 'self' 'unsafe-inline'";
export const StrictStylesPolicy = ViewerPolicy.replace(" 'unsafe-inline'", '');

//  the viewer's own scripts, in web/, and the copy of three.js, by the
//  paths the viewer and its files import: the hub's own lists, which it
//  serves by (model_files.ts)
export { VendoredScripts, ViewerScripts } from '../src/model_files.ts';
import { VendoredScripts, ViewerScripts } from '../src/model_files.ts';

const Types = {
    html: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    glb: 'model/gltf-binary',
    text: 'text/plain; charset=utf-8',
} as const;

interface Served {
    type: string;
    body: () => Buffer;
}

function file(path: string, type: string): Served {
    return { type, body: () => readFileSync(path) };
}

function text(body: string, type: string): Served {
    return { type, body: () => Buffer.from(body, 'utf8') };
}

function escapeHtml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

const PageStyle = `
:root { color-scheme: light dark; }
body { font-family: system-ui, sans-serif; max-width: 48rem; margin: 1rem auto; padding: 0 1rem;
    background: #f4f1ea; color: #1c1c1c; }
@media (prefers-color-scheme: dark) { body { background: #14161a; color: #e8e8e8; } }
#viewer { border: 1px solid currentColor; min-height: 2rem; margin: 1rem 0; }
.model-viewer-buttons { display: flex; flex-wrap: wrap; gap: 0.5rem; padding: 0.5rem; }
.model-viewer-buttons [aria-pressed="true"] { font-weight: bold; }
.model-viewer-status { margin: 0.5rem; }
#violations { color: #b00020; }
`;

//  the page's own script: the policy allows none written into the page
const PageScript = `
import { createModelViewer } from '/web/model_viewer.js';

const violations = document.getElementById('violations');
document.addEventListener('securitypolicyviolation', event => {
    const line = document.createElement('li');
    line.textContent = event.violatedDirective + ' blocked ' + (event.blockedURI || '(inline)');
    violations.append(line);
});

const name = new URLSearchParams(location.search).get('model');
const container = document.getElementById('viewer');
const load = document.getElementById('load');
const close = document.getElementById('close');
let viewer = null;

function open() {
    viewer = createModelViewer(container, '/models/' + encodeURIComponent(name),
        { stats: document.getElementById('stats'), label: name });
}

if (name) {
    open();
    load.addEventListener('click', () => {
        if (viewer.state() === 'closed') {
            open();
        }
        viewer.load();
    });
    close.addEventListener('click', () => viewer.dispose());
} else {
    load.disabled = true;
    close.disabled = true;
}
`;

function page(models: string[], chosen: string | null): string {
    const links = models
        .map(name => `<li><a href="/?model=${encodeURIComponent(name)}">${escapeHtml(name)}</a></li>`)
        .join('\n');
    const title = chosen === null ? 'Choose a model' : escapeHtml(chosen);
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Model viewer harness</title>
<link rel="stylesheet" href="/harness.css">
<script type="module" src="/harness.js"></script>
</head>
<body>
<h1>Model viewer harness</h1>
<ul>
${links}
</ul>
<h2 id="chosen">${title}</h2>
<p><button type="button" id="load">Load 3D</button> <button type="button" id="close">Close</button></p>
<div id="viewer"></div>
<p id="stats"></p>
<ul id="violations"></ul>
</body>
</html>
`;
}

//  everything the harness will serve, by path. Nothing is read from a path
//  a request gives: a request either names one of these or gets 404
export function routes(): { served: Map<string, Served>; models: string[] } {
    const served = new Map<string, Served>();
    served.set('/harness.css', text(PageStyle, Types.css));
    served.set('/harness.js', text(PageScript, Types.js));
    for (const name of ViewerScripts) {
        served.set(`/web/${name}`, file(join(control, 'web', name), Types.js));
    }
    for (const path of VendoredScripts) {
        served.set(
            `/vendor/three/${path}`,
            file(join(control, 'vendor', 'three', ...path.split('/')), Types.js)
        );
    }
    const models = existsSync(modelsDir)
        ? readdirSync(modelsDir)
              .filter(name => /^[a-z0-9_-]+\.glb$/.test(name))
              .sort()
        : [];
    for (const name of models) {
        served.set(`/models/${name}`, file(join(modelsDir, name), Types.glb));
    }
    //  models that must fail, each with a plain message and no request
    //  beyond the model's own: one that is not a model at all, one that is
    //  not there (no route), and three that name an address where everything
    //  should be inside the file: a picture at /probe.png, the model's data
    //  at /probe.bin (neither must ever be asked for), and a picture at a
    //  blob: address, which goes nowhere and is refused all the same
    served.set('/models/broken.glb', text('this is not a model', Types.glb));
    const made = ['broken.glb', 'missing.glb'];
    for (const [name, from, edit] of EditedModels) {
        if (models.includes(from)) {
            served.set(`/models/${name}`, {
                type: Types.glb,
                body: () => editGlb(readFileSync(join(modelsDir, from)), edit),
            });
            made.push(name);
        }
    }
    return { served, models: [...models, ...made] };
}

//  models made from the samples as they are asked for: the name served, the
//  sample it starts from, and what is changed in its description. All but
//  the last must fail; blank_name.glb must load, with its second animation's
//  button reading "Animation 2"
export const EditedModels: [string, string, (json: Json) => void][] = [
    [
        'outside.glb',
        'textured.glb',
        json => {
            json.images = [{ uri: '/probe.png' }];
        },
    ],
    [
        'outside_data.glb',
        'still.glb',
        json => {
            json.buffers[0].uri = '/probe.bin';
        },
    ],
    [
        'blob_address.glb',
        'textured.glb',
        json => {
            json.images = [{ uri: 'blob:http://127.0.0.1/00000000-0000-0000-0000-000000000000' }];
        },
    ],
    [
        'blank_name.glb',
        'animated.glb',
        json => {
            json.animations[1].name = '   ';
        },
    ],
];

function answer(
    res: ServerResponse,
    status: number,
    type: string,
    body: Buffer,
    policy: string,
    head: boolean
): void {
    res.writeHead(status, {
        'Content-Type': type,
        'Content-Length': body.length,
        'Content-Security-Policy': policy,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
    });
    res.end(head ? undefined : body);
}

export function startHarness(
    port: number,
    policy: string = ViewerPolicy,
    log: (line: string) => void = () => {}
) {
    const { served, models } = routes();
    const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const head = req.method === 'HEAD';
        const done = (status: number, type: string, body: Buffer) => {
            log(`${status} ${req.method} ${url.pathname}${url.search}`);
            answer(res, status, type, body, policy, head);
        };
        if (req.method !== 'GET' && !head) {
            done(405, Types.text, Buffer.from('GET only\n'));
            return;
        }
        if (url.pathname === '/') {
            const chosen = url.searchParams.get('model');
            done(200, Types.html, Buffer.from(page(models, chosen), 'utf8'));
            return;
        }
        if (url.pathname === '/favicon.ico') {
            //  browsers ask for one unbidden; an empty answer keeps their
            //  consoles clear of an error that is not the viewer's
            done(204, Types.text, Buffer.alloc(0));
            return;
        }
        const entry = served.get(url.pathname);
        if (!entry) {
            done(404, Types.text, Buffer.from('not here\n'));
            return;
        }
        let body: Buffer;
        try {
            body = entry.body();
        } catch {
            done(500, Types.text, Buffer.from('could not read that file\n'));
            return;
        }
        done(200, entry.type, body);
    });
    server.listen(port, '127.0.0.1');
    return server;
}

function usage(): void {
    console.log(`The model viewer's test harness.

    node test/viewer_harness.ts <port> [--strict-styles]

Serves, on http://127.0.0.1:<port>/ only: a bare test page, the hub's
viewer (web/model_viewer.js), the copy of three.js (vendor/three) and the
sample models (test/fixtures/models), with the model page's policy:

    Content-Security-Policy: ${ViewerPolicy}
    X-Content-Type-Options: nosniff

Open the address in a browser, choose a model, press Load 3D. Five of the
models listed are meant to fail with a plain message: broken.glb,
missing.glb, outside.glb, outside_data.glb and blob_address.glb. The
addresses those name (/probe.png and /probe.bin) must never show in the
requests printed here. blank_name.glb loads, and its second animation's
button reads "Animation 2".

--strict-styles serves style-src 'self' with no 'unsafe-inline'.
Stop it with Ctrl+C.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const args = process.argv.slice(2);
    const port = Number(args.find(arg => /^\d+$/.test(arg)));
    const unknown = args.filter(arg => !/^\d+$/.test(arg) && arg !== '--strict-styles');
    if (!Number.isInteger(port) || port < 1 || port > 65535 || unknown.length > 0) {
        usage();
        process.exitCode = args.length === 0 ? 0 : 1;
    } else {
        const policy = args.includes('--strict-styles') ? StrictStylesPolicy : ViewerPolicy;
        const server = startHarness(port, policy, line => console.log(line));
        server.on('listening', () => {
            console.log(`The viewer harness is at http://127.0.0.1:${port}/`);
            console.log(`Content-Security-Policy: ${policy}`);
        });
        server.on('error', error => {
            console.error(`Could not listen on 127.0.0.1:${port}: ${error.message}`);
            process.exitCode = 1;
        });
    }
}
