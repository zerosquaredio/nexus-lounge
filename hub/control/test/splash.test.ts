import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeConfig } from '../src/config.ts';
import { Registry } from '../src/registry.ts';
import { SignIn } from '../src/signin.ts';
import { createSite } from '../src/site.ts';
import { AssetLibrary } from '../src/assets.ts';
import { bake } from '../src/bake.ts';
import { ansiHtml } from '../src/art_html.ts';
import { OtherSysopDid, SysopDid, testFont } from './helpers.ts';

//  a splash: bright green blocks, a red word on blue, and a blank last row
const Splash = Buffer.from('\x1b[1;32m\xdb\xdb\x1b[0m \x1b[31;44m<b>\x1b[0m\r\n\r\n', 'latin1');

function library(): AssetLibrary {
    const dir = mkdtempSync(join(tmpdir(), 'hub-splash-'));
    try {
        writeFileSync(join(dir, 'WELCOME.ANS'), Splash);
        bake(
            [join(dir, 'WELCOME.ANS')],
            join(dir, 'lib'),
            {
                font: testFont(dir),
                mci: false,
                licence: { id: 'CC-BY-4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
                rating: 'general',
                themes: [],
                author: 'Ana',
                group: 'ACiD',
                note: '',
            },
            { name: 'Test art', description: '' }
        );
        return AssetLibrary.load(join(dir, 'lib'));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

describe("a BBS's splash screen, and views on every page", () => {
    const config = makeConfig({
        domain: 'hub.test',
        database: ':memory:',
        edge: { httpsPort: 443 },
        site: { publicUrl: 'https://hub.test' },
        assets: { splashes: { coolbbs: 'welcome', otherbbs: 'NOTHING' } },
    });
    let server: Server;
    let port = 0;

    const call = (
        method: string,
        host: string,
        path: string,
        headers: Record<string, string> = {},
        body = ''
    ) =>
        new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
            const req = request(
                {
                    host: '127.0.0.1',
                    port,
                    method,
                    path,
                    headers: { Host: host, ...headers, 'Content-Length': String(Buffer.byteLength(body)) },
                    agent: false,
                },
                res => {
                    let text = '';
                    res.on('data', d => (text += d));
                    res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
                }
            );
            req.on('error', reject);
            req.end(body);
        });
    const chooseView = (from: string, view: string, back: string) =>
        call(
            'POST',
            'hub.test',
            '/view',
            { Origin: from, 'Content-Type': 'application/x-www-form-urlencoded' },
            new URLSearchParams({ view, back }).toString()
        );

    before(async () => {
        const registry = new Registry(':memory:', config.registration);
        registry.add('coolbbs', SysopDid);
        registry.add('otherbbs', OtherSysopDid);
        server = createSite({ config, registry, signin: new SignIn(registry.db, config), art: library() });
        await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
        port = (server.address() as AddressInfo).port;
    });

    after(() => {
        server.closeAllConnections();
        server.close();
    });

    it('draws ANSI as escaped, coloured characters, without its empty last rows', () => {
        const html = ansiHtml(Splash, 'a <splash>', 'full');
        assert.match(html, /^<pre class="ansi" role="img" aria-label="a &lt;splash&gt;" style="--cols: 6">/, "sized to the art itself");
        assert.match(html, /<span class="f10 b0">██<\/span>/);
        assert.match(html, /<span class="f1 b4">&lt;b&gt;<\/span>/);
        assert.doesNotMatch(html, /<b>/);
        assert.doesNotMatch(html, /\n<\/pre>$/);
        assert.match(ansiHtml(Splash, 'x', 'card'), /class="ansi card"/);
    });

    it('shows each BBS with its splash on the directory, as the view draws art', async () => {
        const pictures = await call('GET', 'hub.test', '/');
        assert.match(pictures.body, /<a class="splash" href="https:\/\/coolbbs\.hub\.test\/"[^>]*><img class="splash card" src="\/assets\/[0-9a-f]{64}"/);
        assert.equal(pictures.body.split('class="splash"').length, 2, 'otherbbs names no art the hub has');

        const ansi = await call('GET', 'hub.test', '/', { Cookie: 'hub_view=bbs' });
        assert.match(ansi.body, /<pre class="ansi card" role="img"/);
        assert.match(ansi.body, /font-family: "Hub VGA"/);

        const text = await call('GET', 'hub.test', '/', { Cookie: 'hub_view=text-only' });
        assert.match(text.body, /data-view="hub"/, 'an unknown view is the hub\'s own');
    });

    it("shows the splash at full size on the BBS's own page, credited, in the viewer's view", async () => {
        const page = await call('GET', 'coolbbs.hub.test', '/', { Cookie: 'hub_view=pink' });
        assert.match(page.body, /data-view="pink" data-art="ansi"/);
        assert.match(page.body, /<pre class="ansi" role="img"/);
        assert.match(page.body, /WELCOME, by Ana of ACiD\./);
        //  pink and white recolours ANSI, its black the page's own
        assert.match(page.body, /html\[data-view\] pre\.ansi \{ background: #fff5f9; \}/);
        //  its view menu posts to the hub's site and comes back here
        assert.match(
            page.body,
            /<form class="inline view-pick" method="post" action="https:\/\/hub\.test\/view"><input type="hidden" name="back" value="https:\/\/coolbbs\.hub\.test\/">/
        );
        const plain = await call('GET', 'otherbbs.hub.test', '/');
        assert.doesNotMatch(plain.body, /class="ansi|class="splash/);
        //  so that browsers name its origin when the menu posts to the hub
        assert.equal(page.headers['referrer-policy'], 'strict-origin-when-cross-origin');
        assert.equal((await call('GET', 'hub.test', '/')).headers['referrer-policy'], 'same-origin');
    });

    it("draws from the hub's own address on a BBS's page, where /assets/ is the BBS's", async () => {
        const page = await call('GET', 'coolbbs.hub.test', '/', { Cookie: 'hub_view=hub' });
        assert.match(page.body, /<img class="splash" src="https:\/\/hub\.test\/assets\/[0-9a-f]{64}"/);
        assert.match(String(page.headers['content-security-policy']), /img-src 'self' https:\/\/hub\.test;/);
        //  and the font, at the BBS's own address, so its page may use it
        const font = await call('GET', 'coolbbs.hub.test', '/fonts/vga-8x16.woff');
        assert.equal(font.status, 200);
        assert.equal(font.headers['content-type'], 'font/woff');
    });

    it('follows the view where people sign in and report, too', async () => {
        for (const path of ['/signin', '/report']) {
            const page = await call('GET', 'hub.test', path, { Cookie: 'hub_view=bbs' });
            assert.match(page.body, /data-view="bbs"/, path);
            assert.match(page.body, /<form class="inline view-pick"/, path);
        }
    });

    it("keeps the view for the hub's whole domain, chosen from the hub or a BBS's page", async () => {
        const fromHub = await chooseView('https://hub.test', 'bbs', '/signin');
        assert.equal(fromHub.status, 303);
        assert.equal(fromHub.headers.location, '/signin');
        assert.match(String(fromHub.headers['set-cookie']), /^hub_view=bbs; Path=\/; Domain=hub\.test; SameSite=Lax/);

        const fromBoard = await chooseView('https://coolbbs.hub.test', 'pink', 'https://coolbbs.hub.test/');
        assert.equal(fromBoard.status, 303);
        assert.equal(fromBoard.headers.location, 'https://coolbbs.hub.test/');
    });

    it('goes back only to this hub and its BBSes, and takes no other form from a BBS', async () => {
        for (const back of [
            'https://evil.example/',
            'https://coolbbs.hub.test.evil.example/',
            'https://coolbbs.hub.test/bbs',
            'https://a.b.hub.test/',
            '//evil.example/',
        ]) {
            const reply = await chooseView('https://hub.test', 'bbs', back);
            assert.equal(reply.headers.location, '/', back);
        }
        const elsewhere = await chooseView('https://evil.example', 'bbs', '/');
        assert.equal(elsewhere.status, 403);
        const report = await call(
            'POST',
            'hub.test',
            '/report',
            { Origin: 'https://coolbbs.hub.test', 'Content-Type': 'application/x-www-form-urlencoded' },
            'kind=bbs&bbs=otherbbs&details=x'
        );
        assert.equal(report.status, 403, "a BBS's page can't post the hub's other forms");
    });
});
