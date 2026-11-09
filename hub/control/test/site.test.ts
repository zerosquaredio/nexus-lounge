import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { makeConfig } from '../src/config.ts';
import { Registry } from '../src/registry.ts';
import { clientMetadata, SignIn, type Identity } from '../src/signin.ts';
import { createSite, type SignInLike } from '../src/site.ts';
import { OtherSysopDid, SysopDid } from './helpers.ts';

//  the AT step stood in for: "start" goes to a fake account host, and
//  "finish" reports whoever the test says signed in
class FakeSignIn extends SignIn {
    next: Identity = { did: SysopDid, handle: 'sysop.example' };
    started: string[] = [];
    override async start(handle: string): Promise<string> {
        this.started.push(handle);
        return `https://account.example/authorize?for=${encodeURIComponent(handle)}`;
    }
    override async finish(params: URLSearchParams): Promise<Identity> {
        if ('good' !== params.get('code')) {
            throw new Error('bad code');
        }
        return this.next;
    }
}

let server: Server;
let port: number;
let origin: string;
let registry: Registry;
let signin: FakeSignIn;

interface Reply {
    status: number;
    location?: string;
    cookie?: string;
    headers: Record<string, string | string[] | undefined>;
    body: string;
}

function call(
    method: string,
    path: string,
    options: {
        form?: Record<string, string>;
        cookie?: string;
        origin?: string | null;
        forwardedFor?: string;
    } = {}
): Promise<Reply> {
    const body = options.form ? new URLSearchParams(options.form).toString() : '';
    const headers: Record<string, string> = {};
    if (options.form) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        headers['Content-Length'] = String(Buffer.byteLength(body));
    }
    if ('POST' === method && null !== options.origin) {
        headers.Origin = options.origin ?? origin;
    }
    if (options.cookie) {
        headers.Cookie = options.cookie;
    }
    if (options.forwardedFor) {
        headers['X-Forwarded-For'] = options.forwardedFor;
    }
    return new Promise((resolve, reject) => {
        //  a fresh connection each time: each test has its own server on this port
        const req = request({ host: '127.0.0.1', port, method, path, headers, agent: false }, res => {
            let text = '';
            res.on('data', d => (text += d));
            res.on('end', () => {
                const setCookie = res.headers['set-cookie']?.[0];
                resolve({
                    status: res.statusCode ?? 0,
                    location: res.headers.location,
                    cookie: setCookie?.split(';')[0],
                    headers: res.headers,
                    body: text,
                });
            });
        });
        req.on('error', reject);
        req.end(body);
    });
}

async function signedIn(identity: Identity = { did: SysopDid, handle: 'sysop.example' }): Promise<string> {
    signin.next = identity;
    const reply = await call('GET', '/oauth/callback?code=good&state=x&iss=https://account.example');
    assert.equal(reply.status, 303);
    assert.equal(reply.location, '/bbs');
    assert.ok(reply.cookie?.startsWith('hub_session='));
    return reply.cookie as string;
}

before(async () => {
    //  a fixed port, as the site's public address names it
    const probe = (await import('node:net')).createServer();
    await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
    port = (probe.address() as AddressInfo).port;
    await new Promise<void>(r => probe.close(() => r()));
    origin = `http://127.0.0.1:${port}`;
});

beforeEach(async () => {
    await stop();
    const config = makeConfig({ database: ':memory:', site: { port, publicUrl: origin } });
    registry = new Registry(':memory:', config.registration);
    signin = new FakeSignIn(registry.db, config);
    server = createSite({ config, registry, signin: signin as SignInLike });
    await new Promise<void>(r => server.listen(port, '127.0.0.1', r));
});

after(() => stop());

function stop(): Promise<void> {
    if (!server) {
        return Promise.resolve();
    }
    server.closeAllConnections();
    return new Promise(r => server.close(() => r()));
}

describe('the hub site', () => {
    it('offers sign-in, and sends a handle to its account host', async () => {
        const home = await call('GET', '/signin');
        assert.equal(home.status, 200);
        assert.match(home.body, /Sign in with your Bluesky/);
        assert.match(String(home.headers['content-security-policy']), /frame-ancestors 'none'/);
        assert.equal(home.headers['referrer-policy'], 'same-origin');

        const go = await call('POST', '/signin', { form: { handle: '@Sysop.Example' } });
        assert.equal(go.status, 303);
        assert.equal(go.location, 'https://account.example/authorize?for=Sysop.Example');
    });

    it('refuses things that are not handles', async () => {
        for (const handle of [
            '',
            'nodots',
            'a b.example',
            'https://evil.example',
            'x'.repeat(300) + '.com',
        ]) {
            assert.equal((await call('POST', '/signin', { form: { handle } })).status, 400, handle);
        }
        assert.deepEqual(signin.started, []);
    });

    it('accepts forms only from its own pages', async () => {
        assert.equal(
            (await call('POST', '/signin', { form: { handle: 'a.example' }, origin: 'https://evil.example' }))
                .status,
            403
        );
        assert.equal(
            (await call('POST', '/signin', { form: { handle: 'a.example' }, origin: null })).status,
            403
        );
        assert.deepEqual(signin.started, []);
    });

    it('limits sign-in attempts per address', async () => {
        for (let i = 0; i < 10; i++) {
            assert.equal(
                (
                    await call('POST', '/signin', {
                        form: { handle: 'a.example' },
                        forwardedFor: '203.0.113.9',
                    })
                ).status,
                303
            );
        }
        assert.equal(
            (await call('POST', '/signin', { form: { handle: 'a.example' }, forwardedFor: '203.0.113.9' }))
                .status,
            429
        );
        assert.equal(
            (await call('POST', '/signin', { form: { handle: 'a.example' }, forwardedFor: '203.0.113.10' }))
                .status,
            303
        );
    });

    it('signs in on a good callback only, with a cookie the page script cannot read', async () => {
        const bad = await call('GET', '/oauth/callback?code=forged');
        assert.equal(bad.status, 400);
        assert.equal(bad.cookie, undefined);

        signin.next = { did: SysopDid, handle: 'sysop.example' };
        const good = await call('GET', '/oauth/callback?code=good');
        const raw = String((good.headers['set-cookie'] as string[])[0]);
        assert.match(raw, /HttpOnly/);
        assert.match(raw, /SameSite=Lax/);
        assert.doesNotMatch(raw, /Secure/); //  plain http on 127.0.0.1 in development
    });

    it('needs a session to see or change BBSes', async () => {
        assert.equal((await call('GET', '/bbs')).location, '/signin');
        assert.equal((await call('POST', '/bbs', { form: { name: 'coolbbs' } })).location, '/signin');
        assert.equal((await call('GET', '/bbs', { cookie: 'hub_session=made-up' })).location, '/signin');
        assert.equal(registry.list().length, 0);
    });

    it('registers a BBS, showing its token and agent config once', async () => {
        const cookie = await signedIn();
        const reply = await call('POST', '/bbs', {
            cookie,
            form: { name: 'CoolBBS', webPort: '9080', wsPort: '9810' },
        });
        assert.equal(reply.status, 200);
        const bbs = registry.mustGet('coolbbs');
        assert.equal(bbs.sysopDid, SysopDid);
        assert.equal(bbs.webPort, 9080);
        const token = /metadatas\.token = &quot;(hub_[A-Za-z0-9_-]+)&quot;/.exec(reply.body)?.[1];
        assert.ok(token, 'the token is in the agent config');
        assert.equal(registry.authenticate('coolbbs', token)?.name, 'coolbbs');
        assert.match(reply.body, /localPort = 9810/);
        assert.equal(reply.headers['cache-control'], 'no-store');

        //  and never again
        const list = await call('GET', '/bbs', { cookie });
        assert.match(list.body, /coolbbs/);
        assert.doesNotMatch(list.body, new RegExp(token as string));
    });

    it('explains a refused registration', async () => {
        const cookie = await signedIn();
        assert.match((await call('POST', '/bbs', { cookie, form: { name: 'admin' } })).body, /reserved/);
        assert.match(
            (await call('POST', '/bbs', { cookie, form: { name: 'x', webPort: '8080' } })).body,
            /2 to 32/
        );
        assert.match(
            (await call('POST', '/bbs', { cookie, form: { name: 'ok', webPort: '99999' } })).body,
            /Ports are/
        );
        await call('POST', '/bbs', { cookie, form: { name: 'mine' } });
        const other = await signedIn({ did: OtherSysopDid, handle: 'other.example' });
        assert.match(
            (await call('POST', '/bbs', { cookie: other, form: { name: 'mine' } })).body,
            /already registered/
        );
    });

    it('lets a sysop rotate or remove only their own BBSes', async () => {
        const mine = await signedIn();
        await call('POST', '/bbs', { cookie: mine, form: { name: 'coolbbs' } });
        const theirs = await signedIn({ did: OtherSysopDid, handle: 'other.example' });

        assert.equal(
            (await call('POST', '/bbs/rotate', { cookie: theirs, form: { name: 'coolbbs' } })).status,
            404
        );
        assert.equal(
            (await call('POST', '/bbs/remove', { cookie: theirs, form: { name: 'coolbbs' } })).status,
            404
        );
        assert.ok(registry.get('coolbbs'));

        const rotated = await call('POST', '/bbs/rotate', { cookie: mine, form: { name: 'coolbbs' } });
        assert.equal(rotated.status, 200);
        assert.match(rotated.body, /old one has stopped working/);

        registry.setState('coolbbs', 'suspended');
        assert.equal(
            (await call('POST', '/bbs/remove', { cookie: mine, form: { name: 'coolbbs' } })).status,
            403
        );
        registry.setState('coolbbs', 'active');
        assert.equal(
            (await call('POST', '/bbs/remove', { cookie: mine, form: { name: 'coolbbs' } })).location,
            '/bbs'
        );
        assert.equal(registry.get('coolbbs'), null);
    });

    it('stops at the per-sysop limit', async () => {
        const cookie = await signedIn();
        for (const name of ['one', 'two', 'three']) {
            await call('POST', '/bbs', { cookie, form: { name } });
        }
        const page = await call('GET', '/bbs', { cookie });
        assert.match(page.body, /the most this hub allows/);
        assert.doesNotMatch(page.body, /Register a BBS/);
    });

    it('escapes what it shows', async () => {
        const cookie = await signedIn({ did: SysopDid, handle: '<script>x</script>.example' });
        const page = await call('GET', '/bbs', { cookie });
        assert.doesNotMatch(page.body, /<script>x/);
        assert.match(page.body, /&lt;script&gt;/);
    });

    it('signs out', async () => {
        const cookie = await signedIn();
        const out = await call('POST', '/signout', { cookie });
        assert.equal(out.location, '/');
        assert.match(String((out.headers['set-cookie'] as string[])[0]), /Max-Age=0/);
        assert.equal((await call('GET', '/bbs', { cookie })).location, '/signin');
    });
});

describe('sign-in sessions', () => {
    it('keep only a hash, and expire', () => {
        let clock = Date.UTC(2026, 10, 9);
        const db = new DatabaseSync(':memory:');
        new Registry(':memory:', makeConfig().registration).db.close();
        const reg = new Registry(':memory:', makeConfig().registration);
        const s = new SignIn(reg.db, makeConfig(), () => clock);
        const token = s.createSession({ did: SysopDid, handle: 'a.example' });
        assert.equal(s.session(token)?.did, SysopDid);
        assert.ok(!JSON.stringify(reg.db.prepare('SELECT * FROM web_session').all()).includes(token));
        clock += 8 * 24 * 60 * 60 * 1000;
        assert.equal(s.session(token), null);
        db.close();
    });

    it('use a loopback AT client in development', () => {
        const meta = clientMetadata(makeConfig({ site: { port: 7210, publicUrl: 'http://127.0.0.1:7210' } }));
        assert.equal(meta.scope, 'atproto');
        assert.deepEqual(meta.redirect_uris, ['http://127.0.0.1:7210/oauth/callback']);
        assert.match(meta.client_id, /^http:\/\/localhost\?redirect_uri=http%3A%2F%2F127\.0\.0\.1%3A7210/);
    });

    it('say plainly that public sign-in is not built yet', () => {
        assert.throws(
            () => clientMetadata(makeConfig({ site: { publicUrl: 'https://hub.example' } })),
            /not built yet/
        );
    });
});
