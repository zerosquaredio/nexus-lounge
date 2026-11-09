import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeConfig } from '../src/config.ts';
import { Registry } from '../src/registry.ts';
import { createSite } from '../src/site.ts';
import { SignIn } from '../src/signin.ts';
import { clientConfig, endpointFor, loadWebTerm, policy } from '../src/webterm.ts';
import { OtherSysopDid, SysopDid } from './helpers.ts';

const InlineScript = "\n    document.title = 'x';\n  ";

//  a small stand-in for an enig-term release
function fakeRelease(): string {
    const root = mkdtempSync(join(tmpdir(), 'enig-term-'));
    writeFileSync(
        join(root, 'index.html'),
        `<!doctype html><script type="module" src="enig-term.js"></script><script type="module">${InlineScript}</script>`
    );
    writeFileSync(join(root, 'enig-term.js'), 'export {};');
    writeFileSync(join(root, 'core.wasm'), Buffer.from([0, 97, 115, 109]));
    writeFileSync(join(root, 'config.json'), '{"endpoint":"wss://elsewhere.example"}');
    mkdirSync(join(root, 'fonts', 'pc'), { recursive: true });
    writeFileSync(join(root, 'fonts', 'pc', 'cp437-8x16.psf'), 'font');
    return root;
}

const config = makeConfig({ domain: 'hub.test', edge: { httpsPort: 7443 } });

describe('the web terminal release', () => {
    let root: string;
    before(() => (root = fakeRelease()));
    after(() => rmSync(root, { recursive: true, force: true }));

    it('loads every file but config.json, which is made per BBS', () => {
        const term = loadWebTerm(root);
        assert.deepEqual([...term.files.keys()].sort(), [
            'core.wasm',
            'enig-term.js',
            'fonts/pc/cp437-8x16.psf',
            'index.html',
        ]);
        assert.equal(term.files.get('core.wasm')?.type, 'application/wasm');
        assert.equal(term.files.get('enig-term.js')?.type, 'text/javascript; charset=utf-8');
    });

    it('has a fingerprint, and refuses a release that is not the pinned one', () => {
        const term = loadWebTerm(root);
        assert.match(term.digest, /^[0-9a-f]{64}$/);
        assert.equal(loadWebTerm(root, term.digest).digest, term.digest);
        writeFileSync(join(root, 'enig-term.js'), 'export {}; // changed');
        assert.throws(() => loadWebTerm(root, term.digest), /isn't the pinned release/);
        writeFileSync(join(root, 'enig-term.js'), 'export {};');
    });

    it('refuses a directory with no enig-term in it', () => {
        const empty = mkdtempSync(join(tmpdir(), 'empty-'));
        assert.throws(() => loadWebTerm(empty), /no index\.html/);
        rmSync(empty, { recursive: true, force: true });
    });

    it("locks each BBS's terminal to that BBS", () => {
        assert.equal(endpointFor(config, 'coolbbs'), 'wss://coolbbs.hub.test:7443/ws');
        assert.equal(
            endpointFor(makeConfig({ edge: { httpsPort: 443 } }), 'coolbbs'),
            'wss://coolbbs.hub.test/ws'
        );
        assert.deepEqual(JSON.parse(clientConfig(config, 'coolbbs')), {
            version: 1,
            endpoint: 'wss://coolbbs.hub.test:7443/ws',
            lockEndpoint: true,
            title: 'coolbbs.hub.test',
        });
    });

    it('allows only its own scripts, its inline script by hash, and its own BBS', () => {
        const csp = policy(loadWebTerm(root), config, 'coolbbs');
        const hash = createHash('sha256').update(InlineScript).digest('base64');
        assert.match(
            csp,
            new RegExp(`script-src 'self' 'wasm-unsafe-eval' 'sha256-${hash.replace(/[+/]/g, '\\$&')}'`)
        );
        assert.match(csp, /connect-src 'self' wss:\/\/coolbbs\.hub\.test:7443(;|$)/);
        assert.match(csp, /frame-ancestors 'none'/);
        //  WebAssembly needs 'wasm-unsafe-eval'; plain eval and inline scripts stay off
        assert.doesNotMatch(csp, /[ ']'unsafe-eval'|script-src[^;]*'unsafe-inline'/);
    });
});

describe("a BBS's own address on the hub", () => {
    let root: string;
    let server: Server;
    let port: number;
    let registry: Registry;

    const get = (host: string, path: string, headers: Record<string, string> = {}) =>
        new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
            const req = request(
                { host: '127.0.0.1', port, path, headers: { Host: host, ...headers }, agent: false },
                res => {
                    let body = '';
                    res.on('data', d => (body += d));
                    res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
                }
            );
            req.on('error', reject);
            req.end();
        });

    before(async () => {
        root = fakeRelease();
        registry = new Registry(':memory:', config.registration);
        registry.add('coolbbs', SysopDid);
        registry.add('banned', OtherSysopDid);
        registry.setState('banned', 'suspended');
        server = createSite({
            config,
            registry,
            signin: new SignIn(registry.db, config),
            webterm: loadWebTerm(root),
        });
        await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
        port = (server.address() as AddressInfo).port;
    });

    after(() => {
        server.closeAllConnections();
        server.close();
        rmSync(root, { recursive: true, force: true });
    });

    it('shows the BBS, whether it is online, and a way to connect', async () => {
        let page = await get('coolbbs.hub.test:7443', '/');
        assert.equal(page.status, 200);
        assert.match(page.body, /coolbbs\.hub\.test/);
        assert.match(page.body, /hasn't connected to the hub yet/);
        assert.match(page.body, /href="\/_enig\/ws-term\/\?connect=1"/);

        registry.proxyOpened('coolbbs', 'coolbbs.ws', 'r');
        assert.match((await get('coolbbs.hub.test', '/')).body, /Online/);
        registry.proxyClosed('coolbbs', 'coolbbs.ws');
        page = await get('coolbbs.hub.test', '/');
        assert.match(page.body, /Offline.*Last seen/s);
    });

    it('serves the web terminal, with its policy and its own config', async () => {
        const index = await get('coolbbs.hub.test', '/_enig/ws-term/');
        assert.equal(index.status, 200);
        assert.match(
            String(index.headers['content-security-policy']),
            /connect-src 'self' wss:\/\/coolbbs\.hub\.test:7443/
        );

        const conf = JSON.parse((await get('coolbbs.hub.test', '/_enig/ws-term/config.json')).body);
        assert.equal(conf.endpoint, 'wss://coolbbs.hub.test:7443/ws');

        const wasm = await get('coolbbs.hub.test', '/_enig/ws-term/core.wasm');
        assert.equal(wasm.headers['content-type'], 'application/wasm');
        const again = await get('coolbbs.hub.test', '/_enig/ws-term/core.wasm', {
            'If-None-Match': String(wasm.headers.etag),
        });
        assert.equal(again.status, 304);

        assert.equal((await get('coolbbs.hub.test', '/_enig/ws-term')).status, 303);
    });

    it('serves nothing outside the release', async () => {
        for (const path of [
            '/_enig/ws-term/../../etc/passwd',
            '/_enig/ws-term/%2e%2e/x',
            '/_enig/ws-term/fonts',
            '/_enig/ws-term/nothing.js',
            '/elsewhere',
        ]) {
            assert.equal((await get('coolbbs.hub.test', path)).status, 404, path);
        }
    });

    it('has no page for unknown or suspended BBSes', async () => {
        assert.equal((await get('nobody.hub.test', '/')).status, 404);
        assert.equal((await get('nobody.hub.test', '/_enig/ws-term/')).status, 404);
        assert.equal((await get('banned.hub.test', '/')).status, 410);
        assert.equal((await get('banned.hub.test', '/_enig/ws-term/config.json')).status, 410);
    });

    it("never runs the hub's own forms on a BBS's address", async () => {
        assert.equal((await get('coolbbs.hub.test', '/bbs')).status, 404);
        assert.equal((await get('coolbbs.hub.test', '/oauth/callback?code=x')).status, 404);
    });
});
