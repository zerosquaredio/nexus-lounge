//  The files the model viewer is made of, checked as files: the copy of
//  three.js is the copy its README records, nothing in it or in the viewer
//  reaches for another address, and the viewer keeps inside the model page's
//  Content-Security-Policy. The part of the viewer that needs no browser
//  (web/model_file.js: what a model's file says of itself) is run here. What
//  the rest does in a browser is tried with test/viewer_harness.ts.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EditedModels, VendoredScripts, ViewerPolicy, ViewerScripts, routes } from './viewer_harness.ts';
import { editGlb, hostile, packGlb } from './glb.ts';

const control = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = join(control, 'vendor', 'three');
const modelsDir = join(control, 'test', 'fixtures', 'models');
const viewerPath = 'web/model_viewer.js';
//  the viewer's own scripts: where each is, from hub/control
const viewerPaths = ViewerScripts.map(name => `web/${name}`);

//  a plain browser script, loaded by its place so tsc does not look for
//  types it does not have
const modelFile = await import(pathToFileURL(join(control, 'web', 'model_file.js')).href);
const modelJson: (data: ArrayBuffer) => Record<string, any> = modelFile.modelJson;
const addressesNamed: (json: unknown) => string[] = modelFile.addressesNamed;
const animationLabel: (name: unknown, index: number) => string = modelFile.animationLabel;

//  a file's bytes as the browser's fetch hands them over
function bytesOf(file: Buffer): ArrayBuffer {
    const copy = new ArrayBuffer(file.length);
    new Uint8Array(copy).set(file);
    return copy;
}

//  every file under a folder, as paths with forward slashes
function filesUnder(dir: string, prefix = ''): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) {
            found.push(...filesUnder(join(dir, entry.name), path));
        } else {
            found.push(path);
        }
    }
    return found.sort();
}

//  the README's table of files: a path in backticks, then its SHA-256
function recordedHashes(): Map<string, string> {
    const readme = readFileSync(join(vendorDir, 'README.md'), 'utf8');
    const recorded = new Map<string, string>();
    for (const line of readme.split('\n')) {
        const match = /^\| `([^`]+)` \|.*\| `([0-9a-f]{64})` \|\s*$/.exec(line);
        if (match) {
            recorded.set(match[1]!, match[2]!);
        }
    }
    return recorded;
}

//  The code of a script without its comments, line by line. Rough, and
//  rough the safe way: a line is dropped only when it is plainly a comment,
//  so anything doubtful stays in and is checked.
function codeLines(source: string): string[] {
    const kept: string[] = [];
    let inBlock = false;
    for (const line of source.split('\n')) {
        const trimmed = line.trim();
        if (inBlock) {
            if (trimmed.includes('*/')) {
                inBlock = false;
            }
            continue;
        }
        if (trimmed.startsWith('//')) {
            continue;
        }
        if (trimmed.startsWith('/*')) {
            inBlock = !trimmed.includes('*/');
            continue;
        }
        //  a comment after code on the same line: "code; // words"
        kept.push(line.replace(/\s\/\/\s.*$/, ''));
    }
    return kept;
}

//  The same for the viewer's own scripts, which the hub's people write and
//  so can be held to a plainer rule: a comment is a whole line starting
//  "//". Every other line is kept whole, so nothing can hide after a
//  comment's end or behind a "//" inside a string.
function viewerLines(source: string, script: string): string[] {
    const kept: string[] = [];
    for (const line of source.split('\n')) {
        if (line.trim().startsWith('//')) {
            continue;
        }
        assert.doesNotMatch(line, /\/\*|\*\//, `${script} has a block comment: write comments as // lines`);
        kept.push(line);
    }
    return kept;
}

//  the code of any script the browser is given
function codeOf(script: string): string[] {
    const source = readFileSync(join(control, ...script.split('/')), 'utf8');
    return viewerPaths.includes(script) ? viewerLines(source, script) : codeLines(source);
}

//  what a script imports: "from '…'", "import '…'" and "import('…')"
//  Only lines that import are read ("import … from '…'", "export … from
//  '…'", the "} from '…'" that ends a long list, and "import '…'"). An
//  import made while running is refused outright.
function importsOf(code: string[], script: string): string[] {
    const found: string[] = [];
    const pattern = /^\s*(?:(?:import|export)\b[^'"]*\bfrom\s*|\}\s*from\s*|import\s*)(['"])([^'"\n]+)\1/;
    for (const line of code) {
        assert.doesNotMatch(line, /\bimport\s*\(/, `${script} imports while running`);
        const match = pattern.exec(line);
        if (match) {
            found.push(match[2]!);
        }
    }
    return found;
}

//  the scripts a browser is given: where each is, from hub/control
const scripts = [...viewerPaths, ...VendoredScripts.map(path => `vendor/three/${path}`)];

describe('the copy of three.js', () => {
    it('is exactly the files its README lists, each with the SHA-256 recorded', () => {
        const recorded = recordedHashes();
        const present = filesUnder(vendorDir).filter(path => path !== 'README.md');
        assert.deepEqual(present, [...recorded.keys()].sort());
        assert.ok(present.includes('LICENSE'));
        for (const path of present) {
            const hash = createHash('sha256')
                .update(readFileSync(join(vendorDir, ...path.split('/'))))
                .digest('hex');
            assert.equal(hash, recorded.get(path), `${path} is not the file the README records`);
        }
    });

    it('is the scripts the harness serves, no more and no fewer', () => {
        const present = filesUnder(vendorDir).filter(path => path.endsWith('.js'));
        assert.deepEqual(present, [...VendoredScripts].sort());
    });

    it('carries the MIT licence', () => {
        const licence = readFileSync(join(vendorDir, 'LICENSE'), 'utf8');
        assert.match(licence, /The MIT License/);
        assert.match(licence, /three\.js authors/);
    });
});

describe('the viewer and the copy of three.js', () => {
    it('import only each other: no package name, no address', () => {
        let count = 0;
        for (const script of scripts) {
            const code = codeOf(script);
            for (const target of importsOf(code, script)) {
                count++;
                assert.match(target, /^\.\.?\//, `${script} imports ${target}`);
                const resolved = posix.normalize(posix.join(posix.dirname(script), target));
                assert.ok(scripts.includes(resolved), `${script} imports ${target}, which is not served`);
                assert.ok(existsSync(join(control, ...resolved.split('/'))));
            }
        }
        //  the viewer's four, the module build's two, the loader's three,
        //  the controls' one and the two utilities' one each: the check
        //  above did look at something
        assert.ok(count >= 12, `only ${count} imports found`);
    });

    it("have no bare import of 'three' left", () => {
        for (const script of scripts) {
            const code = codeOf(script).join('\n');
            assert.doesNotMatch(code, /from\s*['"]three(?:\/[^'"]*)?['"]/, script);
            assert.doesNotMatch(code, /import\s*\(?\s*['"]three(?:\/[^'"]*)?['"]/, script);
        }
    });

    it('name no web address in their code', () => {
        //  an XML namespace is a name, not somewhere to fetch from: the
        //  library makes its elements with it
        const namesOnly = new Set(['http://www.w3.org/1999/xhtml']);
        for (const script of scripts) {
            const code = codeOf(script);
            code.forEach((line, index) => {
                for (const match of line.matchAll(/\b(?:https?|wss?|ftp):\/\/[^\s'"`)]*/g)) {
                    assert.ok(
                        namesOnly.has(match[0]),
                        `${script} names ${match[0]} in its code (code line ${index + 1})`
                    );
                }
                assert.doesNotMatch(line, /['"`]\/\/[a-z0-9]/i, `${script}: an address with no scheme`);
            });
        }
    });
});

describe('the viewer', () => {
    //  both of its scripts, as one text
    const code = viewerPaths.map(script => codeOf(script).join('\n')).join('\n');
    const viewer = codeOf(viewerPath).join('\n');

    it('is the scripts the harness serves, no more and no fewer', () => {
        assert.deepEqual(filesUnder(join(control, 'web')), [...ViewerScripts].sort());
    });

    it('uses nothing the model page forbids', () => {
        const forbidden: [RegExp, string][] = [
            [/\beval\s*\(/, 'eval'],
            [/\bnew\s+Function\b/, 'new Function'],
            [/\bFunction\s*\(/, 'Function()'],
            [/\bset(?:Timeout|Interval)\s*\(\s*['"`]/, 'a timer given a string to run'],
            [/\bWorker\b/, 'a worker'],
            [/\bimportScripts\b/, 'importScripts'],
            [/\bserviceWorker\b/, 'a service worker'],
            [/\bWebAssembly\b/, 'WebAssembly'],
            [/\bimport\s*\(/, 'an import made while running'],
            [
                /\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b|\bdocument\.write\b/,
                'markup from a string',
            ],
            [/setAttribute\(\s*['"]style['"]/, 'a style attribute'],
            [
                /createElement\(\s*['"`](?:script|style|iframe|link|img|image|picture|video|audio|source|object|embed|a|form)['"`]/i,
                'an element that can fetch or run something',
            ],
            [/\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\b/, 'another way to the network'],
            //  the ways a script asks for an address without fetch: a
            //  picture made in code, and an element's or the page's address
            [/\bImage\s*\(/, 'a picture made in code'],
            [/\.(?:src|srcset|href|action|data|poster)\b\s*=[^=]/, 'an address given to an element'],
            [
                /setAttribute\(\s*['"`](?:src|srcset|href|action|data|poster)['"`]/i,
                'an address given to an element',
            ],
            [/\blocation\b|\bwindow\.open\b|\.open\s*\(/, "the page's own address, or a new page"],
            [
                /\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|\bdocument\.cookie\b/,
                'something kept about the person',
            ],
        ];
        for (const [pattern, what] of forbidden) {
            assert.doesNotMatch(code, pattern, `the viewer uses ${what}`);
        }
    });

    it('fetches once, the model, and lets the loader open only what is inside the file', () => {
        assert.equal([...code.matchAll(/\bfetch\s*\(/g)].length, 1);
        assert.match(viewer, /view\.fetch\(url,/);
        //  the loader's rule, exactly as written: blob: addresses and no others
        assert.match(
            viewer,
            /setURLModifier\(address => \{\s*if \(typeof address === 'string' && address\.startsWith\('blob:'\)\) \{\s*return address;\s*\}\s*outside = outside \|\| new Error\([^)]*\);\s*throw outside;\s*\}\);/
        );
        assert.equal([...viewer.matchAll(/startsWith\(/g)].length, 1);
    });

    it("reads the model's own description for addresses before the loader is given it", () => {
        const check = viewer.indexOf('const named = addressesNamed(modelJson(data));');
        const refusal = viewer.indexOf('if (named.length > 0) {\n                throw new Error(');
        const loader = viewer.indexOf('new GLTFLoader(');
        const parse = viewer.indexOf('.parseAsync(data,');
        assert.ok(check !== -1, 'the viewer does not read the description');
        assert.ok(refusal > check, 'the viewer does not refuse what the description names');
        assert.ok(loader > refusal && parse > loader, 'the loader is given the model before the check');
        assert.equal([...viewer.matchAll(/parseAsync\(|\.parse\(|\.load\(|\.loadAsync\(/g)].length, 1);
    });

    it('sets the model up inside a try, so a fault there ends in the plain message', () => {
        //  from the model being read to the viewer saying it is ready: one
        //  block, whose catch fails the load
        assert.match(
            viewer,
            /\n        try \{\n            scene = new Scene\(\);\n(?:(?: {12}.*)?\n)*? {12}setState\('ready'\);\n(?:(?: {12}.*)?\n)*? {8}\} catch \(error\) \{\n(?: {12}.*\n)*? {12}fail\(Messages\.failed, error\);\n {8}\}\n {4}\}\n/
        );
        assert.equal([...viewer.matchAll(/setState\('ready'\)/g)].length, 1);
    });

    it('names the canvas as something that takes keys, with the key help as its description', () => {
        assert.match(viewer, /setAttribute\('role', 'application'\)/);
        assert.doesNotMatch(viewer, /setAttribute\('role', 'img'\)/);
        assert.match(viewer, /setAttribute\('aria-describedby', keysId\)/);
        assert.match(viewer, /keysHelp\.id = keysId;/);
        assert.match(viewer, /options\.label/);
        assert.match(viewer, /button\.textContent = animationLabel\(clip\.name, index\);/);
    });

    it("says at its top which directives it needs, all within the model page's policy", () => {
        const head = readFileSync(join(control, ...viewerPath.split('/')), 'utf8').split('\nimport ')[0]!;
        for (const needed of ["script-src 'self'", "connect-src 'self'", 'img-src blob:']) {
            assert.ok(head.includes(needed), `the viewer's opening comment does not name ${needed}`);
        }
        assert.match(ViewerPolicy, /script-src 'self';/);
        assert.match(ViewerPolicy, /connect-src 'self';/);
        assert.match(ViewerPolicy, /img-src 'self' blob:;/);
        assert.doesNotMatch(ViewerPolicy, /unsafe-eval|wasm-unsafe-eval|worker-src|\*|https?:/);
        assert.equal(
            ViewerPolicy,
            "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self' blob:; style-src 'self' 'unsafe-inline'"
        );
    });
});

describe("the viewer's reading of a model's file", () => {
    const samples = ['still.glb', 'animated.glb', 'skinned.glb', 'textured.glb'];
    const sample = (name: string) => readFileSync(join(modelsDir, name));

    it('finds no address in the sample models', () => {
        for (const name of samples) {
            const json = modelJson(bytesOf(sample(name)));
            assert.equal(json.asset.version, '2.0', name);
            assert.deepEqual(addressesNamed(json), [], name);
        }
    });

    it('finds a buffer or a picture kept outside the file, whatever the address', () => {
        assert.deepEqual(addressesNamed(modelJson(bytesOf(hostile.bufferUri()))), ['buffers[0]']);
        assert.deepEqual(addressesNamed(modelJson(bytesOf(hostile.bufferDataUri()))), ['buffers[0]']);
        assert.deepEqual(addressesNamed(modelJson(bytesOf(hostile.imageUri()))), ['images[0]']);
        assert.deepEqual(addressesNamed(modelJson(bytesOf(hostile.imageDataUri()))), ['images[0]']);
        const addresses = [
            '/logout',
            'probe.png',
            '//example.com/x.png',
            'https://example.com/x.png',
            'data:image/png;base64,AAAA',
            'blob:http://127.0.0.1/00000000-0000-0000-0000-000000000000',
            '',
            null,
            7,
        ];
        for (const uri of addresses) {
            const picture = editGlb(sample('textured.glb'), json => {
                json.images[0].uri = uri;
            });
            assert.deepEqual(addressesNamed(modelJson(bytesOf(picture))), ['images[0]'], String(uri));
            const data = editGlb(sample('still.glb'), json => {
                json.buffers[0].uri = uri;
            });
            assert.deepEqual(addressesNamed(modelJson(bytesOf(data))), ['buffers[0]'], String(uri));
        }
    });

    it('finds one in any buffer or picture, and in a list that is not a list', () => {
        assert.deepEqual(
            addressesNamed({ buffers: [{}, { uri: 'a' }], images: [{ bufferView: 0 }, {}, { uri: 'b' }] }),
            ['buffers[1]', 'images[2]']
        );
        //  the loader reads these by number, which an object answers too
        assert.deepEqual(addressesNamed({ images: { 0: { uri: '/logout' } } }), ['images[0]']);
        assert.deepEqual(addressesNamed({ buffers: 'x' }), ['buffers']);
        assert.deepEqual(addressesNamed({ images: null }), ['images']);
        assert.deepEqual(addressesNamed({}), []);
        assert.deepEqual(addressesNamed({ buffers: [{ byteLength: 4 }], images: [null, 3] }), []);
    });

    it('finds the address in each model the harness serves to fail for one', () => {
        const { served } = routes();
        for (const [name] of EditedModels) {
            const named = addressesNamed(modelJson(bytesOf(served.get(`/models/${name}`)!.body())));
            if (name === 'blank_name.glb') {
                assert.deepEqual(named, [], name);
            } else {
                assert.equal(named.length, 1, name);
            }
        }
    });

    it('refuses a file that is not one binary glTF model with one description, placed first', () => {
        const wrong: [string, Buffer][] = [
            ['words', Buffer.from('this is not a model', 'utf8')],
            ['nothing', Buffer.alloc(0)],
            ['a glTF description as text', Buffer.from('{"asset":{"version":"2.0"}}', 'utf8')],
            ['another magic', hostile.badMagic()],
            ['version 1', hostile.containerVersion()],
            ['a length past the end', hostile.lengthLonger()],
            ['a chunk past the end', hostile.chunkPastEnd()],
            ['two descriptions', hostile.twoJsonChunks()],
            ['the data first', hostile.binFirst()],
            ['bytes that are not UTF-8', hostile.invalidUtf8()],
            ['text that is not JSON', hostile.invalidJson()],
            ['a description that is a list', packGlb(Buffer.from('[1] ', 'utf8'))],
            ['a description that is null', packGlb(Buffer.from('null', 'utf8'))],
        ];
        for (const [what, file] of wrong) {
            assert.throws(() => modelJson(bytesOf(file)), what);
        }
    });

    it('reads the description the loader would: the second of two is never the one shown', () => {
        //  a clean description first and one naming an address after it,
        //  which the loader would take: refused, not passed as clean
        const clean = sample('textured.glb');
        const dirty = editGlb(clean, json => {
            json.images[0].uri = '/logout';
        });
        const head = (file: Buffer) => file.subarray(12, 20 + file.readUInt32LE(12));
        const body = Buffer.concat([head(clean), head(dirty), clean.subarray(20 + clean.readUInt32LE(12))]);
        const header = Buffer.alloc(12);
        header.write('glTF', 0, 'latin1');
        header.writeUInt32LE(2, 4);
        header.writeUInt32LE(12 + body.length, 8);
        assert.throws(() => modelJson(bytesOf(Buffer.concat([header, body]))), /two descriptions/);
    });
});

describe("the words on an animation's button", () => {
    it("are the animation's name, tidied", () => {
        assert.equal(animationLabel('idle', 0), 'idle');
        assert.equal(animationLabel('  walk \n cycle  ', 3), 'walk cycle');
        assert.equal(animationLabel('<b>spin</b>', 1), '<b>spin</b>');
        assert.equal(animationLabel('回る', 0), '回る');
    });

    it('are its place when the name has nothing to see or say', () => {
        assert.equal(animationLabel('', 0), 'Animation 1');
        assert.equal(animationLabel('   ', 1), 'Animation 2');
        assert.equal(animationLabel('\t\n\u00a0\u3000', 2), 'Animation 3');
        assert.equal(animationLabel('\u200b\u200d\ufeff', 3), 'Animation 4');
        assert.equal(animationLabel(undefined, 4), 'Animation 5');
        assert.equal(animationLabel(null, 5), 'Animation 6');
        assert.equal(animationLabel(12, 6), 'Animation 7');
    });

    it('are cut short when the name is long', () => {
        const long = animationLabel('x'.repeat(500), 0);
        assert.equal(long, `${'x'.repeat(48)}…`);
        assert.equal(animationLabel('y'.repeat(48), 0), 'y'.repeat(48));
        //  by whole characters, never through the middle of one
        assert.equal(animationLabel('😀'.repeat(60), 0), `${'😀'.repeat(48)}…`);
    });
});
