import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeConfig } from '../src/config.ts';
import { Registry } from '../src/registry.ts';
import { clientMetadata, ClientMetadataPath, JwksPath, SignIn, type Identity } from '../src/signin.ts';
import { createSite, type SignInLike } from '../src/site.ts';
import { HubAccount, HubAccountMetadataPath, HubAccountWebCallbackPath } from '../src/hub_account.ts';
import { Profiles } from '../src/profiles.ts';
import { AbuseReports } from '../src/abuse.ts';
import type { AtClient } from '../src/atproto.ts';
import { AssetLibrary } from '../src/assets.ts';
import { bake } from '../src/bake.ts';
import { viewProblems, Views } from '../src/views.ts';
import { OtherSysopDid, SysopDid, testConfig, testFont, testRegistry } from './helpers.ts';

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
const logs: string[] = [];

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

async function signedIn(
    identity: Identity = { did: SysopDid, handle: 'sysop.example' },
    home = '/bbs'
): Promise<string> {
    signin.next = identity;
    const reply = await call('GET', '/oauth/callback?code=good&state=x&iss=https://account.example');
    assert.equal(reply.status, 303);
    assert.equal(reply.location, home);
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

beforeEach(() => start(false));

async function start(
    space: boolean,
    registration: Record<string, unknown> = {},
    at: AtClient | null = null,
    art: AssetLibrary | null = null
): Promise<void> {
    await stop();
    const config = makeConfig({
        database: ':memory:',
        site: { port, publicUrl: origin },
        space: { enabled: space },
        //  registering at once; approval and account age have their own tests
        registration: { approval: false, minAccountAgeDays: 0, ...registration },
    });
    registry = new Registry(':memory:', config.registration);
    signin = new FakeSignIn(registry.db, config);
    logs.length = 0;
    server = createSite({
        config,
        registry,
        signin: signin as SignInLike,
        at,
        art,
        log: line => logs.push(line),
    });
    await new Promise<void>(r => server.listen(port, '127.0.0.1', r));
}

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

        const go = await call('POST', '/signin', { form: { handle: '@Sysop.Example', agree: 'yes' } });
        assert.equal(go.status, 303);
        assert.equal(go.location, 'https://account.example/authorize?for=Sysop.Example');
    });

    it('asks people to confirm their age before signing in', async () => {
        const home = await call('GET', '/signin');
        assert.match(home.body, /name="agree" value="yes" required> I'm 16 or older\./);
        const refused = await call('POST', '/signin', { form: { handle: 'a.example' } });
        assert.equal(refused.status, 400);
        assert.match(refused.body, /tick the box/);
        assert.deepEqual(signin.started, []);
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
                        form: { handle: 'a.example', agree: 'yes' },
                        forwardedFor: '203.0.113.9',
                    })
                ).status,
                303
            );
        }
        assert.equal(
            (
                await call('POST', '/signin', {
                    form: { handle: 'a.example', agree: 'yes' },
                    forwardedFor: '203.0.113.9',
                })
            ).status,
            429
        );
        assert.equal(
            (
                await call('POST', '/signin', {
                    form: { handle: 'a.example', agree: 'yes' },
                    forwardedFor: '203.0.113.10',
                })
            ).status,
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
            form: { name: 'CoolBBS', webPort: '9080', wsPort: '9810', rating: 'yes' },
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
        assert.match(
            (await call('POST', '/bbs', { cookie, form: { rating: 'yes', name: 'admin' } })).body,
            /reserved/
        );
        assert.match(
            (await call('POST', '/bbs', { cookie, form: { rating: 'yes', name: 'x', webPort: '8080' } }))
                .body,
            /2 to 32/
        );
        assert.match(
            (await call('POST', '/bbs', { cookie, form: { rating: 'yes', name: 'ok', webPort: '99999' } }))
                .body,
            /Ports are/
        );
        await call('POST', '/bbs', { cookie, form: { rating: 'yes', name: 'mine' } });
        const other = await signedIn({ did: OtherSysopDid, handle: 'other.example' });
        assert.match(
            (await call('POST', '/bbs', { cookie: other, form: { rating: 'yes', name: 'mine' } })).body,
            /already registered/
        );
    });

    it('lets a sysop rotate or remove only their own BBSes', async () => {
        const mine = await signedIn();
        await call('POST', '/bbs', { cookie: mine, form: { rating: 'yes', name: 'coolbbs' } });
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

    it('asks a sysop to confirm the rating, and holds a removed name', async () => {
        const cookie = await signedIn();
        const page = await call('GET', '/bbs', { cookie });
        assert.match(page.body, /name="rating" value="yes" required> My BBS is suitable for everyone/);
        const unrated = await call('POST', '/bbs', { cookie, form: { name: 'coolbbs' } });
        assert.equal(unrated.status, 400);
        assert.match(unrated.body, /Confirm your BBS/);
        assert.equal(registry.get('coolbbs'), null);

        await call('POST', '/bbs', { cookie, form: { rating: 'yes', name: 'coolbbs' } });
        await call('POST', '/bbs/remove', { cookie, form: { name: 'coolbbs' } });
        const other = await signedIn({ did: OtherSysopDid, handle: 'other.example' });
        assert.match(
            (await call('POST', '/bbs', { cookie: other, form: { rating: 'yes', name: 'coolbbs' } })).body,
            /removed lately/
        );
        registry.release('coolbbs');
        assert.equal(
            (await call('POST', '/bbs', { cookie: other, form: { rating: 'yes', name: 'coolbbs' } })).status,
            200
        );
    });

    it('shows a sysop why their BBS was suspended', async () => {
        const cookie = await signedIn();
        await call('POST', '/bbs', { cookie, form: { rating: 'yes', name: 'coolbbs' } });
        registry.setState('coolbbs', 'suspended', 'Reports of <spam>');
        const page = await call('GET', '/bbs', { cookie });
        assert.match(page.body, /suspended by the hub: Reports of &lt;spam&gt;/);
    });

    it('stops at the per-sysop limit', async () => {
        const cookie = await signedIn();
        for (const name of ['one', 'two', 'three']) {
            await call('POST', '/bbs', { cookie, form: { rating: 'yes', name } });
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

    it('use a public AT client on an https:// address, served by the site', () => {
        const meta = clientMetadata(
            makeConfig({ domain: 'hub.example', site: { publicUrl: 'https://hub.example/' } })
        );
        assert.equal(meta.client_id, 'https://hub.example/oauth/client-metadata.json');
        assert.deepEqual(meta.redirect_uris, ['https://hub.example/oauth/callback']);
        assert.equal(meta.scope, 'atproto');
        assert.equal(meta.application_type, 'web');
        assert.equal(meta.token_endpoint_auth_method, 'private_key_jwt');
        assert.equal((meta as { jwks_uri?: string }).jwks_uri, 'https://hub.example/oauth/jwks.json');
        assert.equal((meta as { client_name?: string }).client_name, 'hub.example');
    });

    it('make the public signing key once, keep it private, and serve only its public half', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hub-key-'));
        const keyPath = join(dir, 'data', 'oauth_signing_key.json');
        const config = makeConfig({
            domain: 'hub.example',
            database: ':memory:',
            site: { publicUrl: 'https://hub.example', signingKey: keyPath },
        });
        const reg = new Registry(':memory:', config.registration);
        try {
            const first = await new SignIn(reg.db, config).publicDocuments();
            assert.ok(first);
            if ('win32' !== process.platform) {
                assert.equal(statSync(keyPath).mode & 0o777, 0o600);
            }
            const saved = JSON.parse(readFileSync(keyPath, 'utf8')) as { d?: string; kid?: string };
            assert.ok(saved.d, 'the file holds the private key');
            const keys = (first.jwks as { keys: { kid?: string; d?: string }[] }).keys;
            assert.equal(keys.length, 1);
            assert.equal(keys[0]?.d, undefined, 'never the private part');
            assert.equal(keys[0]?.kid, saved.kid);
            const clientId = 'https://hub.example' + ClientMetadataPath;
            assert.equal((first.metadata as { client_id: string }).client_id, clientId);

            //  the next start uses the same key
            const again = await new SignIn(reg.db, config).publicDocuments();
            assert.equal((again?.jwks as { keys: { kid?: string }[] }).keys[0]?.kid, saved.kid);

            //  and the site serves both documents
            const site = createSite({ config, registry: reg, signin: new SignIn(reg.db, config) });
            await new Promise<void>(r => site.listen(0, '127.0.0.1', r));
            const at = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
            try {
                const metaReply = await fetch(at + ClientMetadataPath);
                assert.equal(metaReply.status, 200);
                assert.equal(((await metaReply.json()) as { client_id: string }).client_id, clientId);
                const jwksReply = await fetch(at + JwksPath);
                assert.equal(jwksReply.status, 200);
                const served = (await jwksReply.json()) as { keys: { kid?: string; d?: string }[] };
                assert.equal(served.keys[0]?.kid, saved.kid);
                assert.equal(served.keys[0]?.d, undefined);
            } finally {
                site.closeAllConnections();
                await new Promise(r => site.close(r));
            }
        } finally {
            reg.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('serve no client documents for a loopback client', async () => {
        assert.equal((await call('GET', ClientMetadataPath)).status, 404);
        assert.equal((await call('GET', JwksPath)).status, 404);
        assert.equal((await call('GET', HubAccountMetadataPath)).status, 404);
        assert.equal((await call('GET', HubAccountWebCallbackPath + '?code=good')).status, 404);
    });

    it("serve the hub account's own public client, with sign-in's key, and finish connecting it there", async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hub-key-'));
        const keyPath = join(dir, 'data', 'oauth_signing_key.json');
        const config = makeConfig({
            domain: 'hub.example',
            database: ':memory:',
            site: { publicUrl: 'https://hub.example', signingKey: keyPath },
        });
        const reg = new Registry(':memory:', config.registration);
        const HubDid = 'did:plc:hubhubhubhubhubhubhubhubh';
        //  the real client for its documents; the AT step stood in for
        const account = new HubAccount(reg.db, config);
        const hubAccount = {
            publicMetadata: () => account.publicMetadata(),
            async finish(params: URLSearchParams) {
                if ('good' !== params.get('code')) {
                    throw new Error('bad code');
                }
                return { did: HubDid, handle: 'hubaccount.example', connectedAt: '2026-11-24T00:00:00.000Z' };
            },
        };
        const site = createSite({ config, registry: reg, signin: new SignIn(reg.db, config), hubAccount });
        await new Promise<void>(r => site.listen(0, '127.0.0.1', r));
        const at = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
        try {
            const reply = await fetch(at + HubAccountMetadataPath);
            assert.equal(reply.status, 200);
            const meta = (await reply.json()) as Record<string, unknown>;
            assert.equal(meta.client_id, 'https://hub.example' + HubAccountMetadataPath);
            assert.deepEqual(meta.redirect_uris, ['https://hub.example' + HubAccountWebCallbackPath]);
            assert.equal(meta.scope, 'atproto repo:nexus.cyberspace.dev.hub.observedStatus');
            assert.equal(meta.token_endpoint_auth_method, 'private_key_jwt');
            assert.equal(meta.jwks_uri, 'https://hub.example' + JwksPath);

            //  one key for both clients: the one sign-in serves
            const saved = JSON.parse(readFileSync(keyPath, 'utf8')) as { kid?: string };
            const jwks = (await (await fetch(at + JwksPath)).json()) as { keys: { kid?: string }[] };
            assert.equal(jwks.keys.length, 1);
            assert.equal(jwks.keys[0]?.kid, saved.kid);

            const bad = await fetch(at + HubAccountWebCallbackPath + '?code=bad');
            assert.equal(bad.status, 400);
            const good = await fetch(at + HubAccountWebCallbackPath + '?code=good');
            assert.equal(good.status, 200);
            assert.match(await good.text(), new RegExp(HubDid));
        } finally {
            site.closeAllConnections();
            await new Promise(r => site.close(r));
            reg.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('profiles, with the common space on', () => {
    beforeEach(() => start(true));

    it("aren't made, and have no page, while the space is off", async () => {
        await start(false);
        await signedIn();
        assert.equal((await call('GET', '/me', { cookie: await signedIn() })).status, 404);
        assert.equal(new Profiles(registry.db).get(SysopDid), null);
        assert.throws(() => makeConfig({ space: { enabled: 'yes' } }), /space\.enabled/);
    });

    it('are made at the first sign-in, with presence off', async () => {
        const cookie = await signedIn({ did: OtherSysopDid, handle: 'someone.example' }, '/me');
        const profile = new Profiles(registry.db).get(OtherSysopDid);
        assert.equal(profile?.handle, 'someone.example');
        assert.equal(profile?.presence, false);

        const me = await call('GET', '/me', { cookie });
        assert.equal(me.status, 200);
        assert.match(me.body, /@someone\.example/);
        assert.match(me.body, /<strong>Off:<\/strong>/);
        assert.match(me.body, /Register it here/);
        assert.equal((await call('GET', '/signin', { cookie })).location, '/me');
    });

    it('turn presence on and off', async () => {
        const cookie = await signedIn(undefined, '/me');
        const on = await call('POST', '/me/presence', { cookie, form: { presence: 'on' } });
        assert.equal(on.location, '/me');
        assert.equal(new Profiles(registry.db).get(SysopDid)?.presence, true);
        assert.match((await call('GET', '/me', { cookie })).body, /<strong>On:<\/strong>/);

        await call('POST', '/me/presence', { cookie, form: { presence: 'off' } });
        assert.equal(new Profiles(registry.db).get(SysopDid)?.presence, false);

        assert.equal(
            (await call('POST', '/me/presence', { cookie, form: { presence: 'maybe' } })).status,
            400
        );
        assert.equal(
            (
                await call('POST', '/me/presence', {
                    cookie,
                    form: { presence: 'on' },
                    origin: 'https://evil.example',
                })
            ).status,
            403
        );
        assert.equal(new Profiles(registry.db).get(SysopDid)?.presence, false);
    });

    it('need a session', async () => {
        assert.equal((await call('GET', '/me')).location, '/signin');
        assert.equal((await call('POST', '/me/presence', { form: { presence: 'on' } })).location, '/signin');
    });

    it('keep their setting when signing in again, with the latest handle', async () => {
        const cookie = await signedIn(undefined, '/me');
        await call('POST', '/me/presence', { cookie, form: { presence: 'on' } });
        await signedIn({ did: SysopDid, handle: 'renamed.example' }, '/me');
        const profile = new Profiles(registry.db).get(SysopDid);
        assert.equal(profile?.handle, 'renamed.example');
        assert.equal(profile?.presence, true);
    });

    it('can be removed, which signs the person out everywhere', async () => {
        const first = await signedIn(undefined, '/me');
        const second = await signedIn(undefined, '/me');
        const other = await signedIn({ did: OtherSysopDid, handle: 'other.example' }, '/me');
        const gone = await call('POST', '/me/forget', { cookie: first });
        assert.equal(gone.location, '/');
        assert.match(String((gone.headers['set-cookie'] as string[])[0]), /Max-Age=0/);
        assert.equal(new Profiles(registry.db).get(SysopDid), null);
        assert.equal((await call('GET', '/me', { cookie: second })).location, '/signin');
        assert.equal((await call('GET', '/me', { cookie: other })).status, 200);
    });

    it('are invited from the directory, and escaped', async () => {
        assert.match((await call('GET', '/')).body, /Sign in<\/a> to take part in the common space/);
        const cookie = await signedIn({ did: SysopDid, handle: '<b>x</b>.example' }, '/me');
        const me = await call('GET', '/me', { cookie });
        assert.doesNotMatch(me.body, /<b>x/);
        assert.match((await call('GET', '/', { cookie })).body, /href="\/me"/);
    });
});

describe('presence on the site', () => {
    beforeEach(() => start(true));

    const Alice = 'did:plc:alicealicealicealicealic';
    const since = '2026-01-01T00:00:00.000Z';

    function postReport(body: unknown, token: string | null): Promise<Reply> {
        const text = JSON.stringify(body);
        return new Promise((resolve, reject) => {
            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                'Content-Length': String(Buffer.byteLength(text)),
            };
            if (token) {
                headers.Authorization = `Bearer ${token}`;
            }
            const req = request(
                { host: '127.0.0.1', port, method: 'POST', path: '/api/bbs/presence', headers, agent: false },
                res => {
                    let out = '';
                    res.on('data', d => (out += d));
                    res.on('end', () =>
                        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: out })
                    );
                }
            );
            req.on('error', reject);
            req.end(text);
        });
    }

    function aliceOn(bbs = 'coolbbs') {
        return { bbs, members: [{ did: Alice, name: 'alice', memberSince: since, online: true }] };
    }

    it('takes reports only with the BBS own token, from no web page', async () => {
        const { token } = registry.add('coolbbs', SysopDid, null, {});
        const other = registry.add('otherbbs', OtherSysopDid, null, {});
        registry.proxyOpened('coolbbs', 'coolbbs.web', null);

        assert.equal((await postReport(aliceOn(), null)).status, 401);
        assert.equal((await postReport(aliceOn(), other.token)).status, 401);
        assert.equal((await postReport(aliceOn('nosuch'), token)).status, 401);
        assert.equal(new Profiles(registry.db).get(Alice), null);

        const ok = await postReport(aliceOn(), token);
        assert.equal(ok.status, 200);
        assert.deepEqual(JSON.parse(ok.body), { ok: true, members: 1, active: [] });

        assert.equal((await postReport({ bbs: 'coolbbs', members: [{ did: 'nope' }] }, token)).status, 400);
        registry.setState('coolbbs', 'suspended');
        assert.equal((await postReport(aliceOn(), token)).status, 401);
    });

    it('limits how often a BBS reports', async () => {
        const { token } = registry.add('coolbbs', SysopDid, null, {});
        for (let i = 0; i < 30; i++) {
            assert.equal((await postReport(aliceOn(), token)).status, 200);
        }
        assert.equal((await postReport(aliceOn(), token)).status, 429);
    });

    it('lets members of a BBS see who is around, and confirm or deny it', async () => {
        const { token } = registry.add('coolbbs', SysopDid, null, {});
        registry.proxyOpened('coolbbs', 'coolbbs.web', null);
        const cookie = await signedIn({ did: Alice, handle: 'alice.example' }, '/me');

        assert.match((await call('GET', '/space', { cookie })).body, /for members of its BBSes/);
        assert.match((await call('GET', '/me', { cookie })).body, /No BBS on this hub has said/);

        await postReport(aliceOn(), token);
        const me = await call('GET', '/me', { cookie });
        assert.match(me.body, /shown as "alice via coolbbs"/);
        //  her own profile's presence is off, so she isn't shown yet
        assert.match((await call('GET', '/space', { cookie })).body, /Nobody is around/);

        await call('POST', '/me/presence', { cookie, form: { presence: 'on' } });
        assert.match((await call('GET', '/space', { cookie })).body, /alice via coolbbs/);

        const yes = await call('POST', '/me/bbs', { cookie, form: { bbs: 'coolbbs', answer: 'confirmed' } });
        assert.equal(yes.location, '/me');
        assert.match((await call('GET', '/space', { cookie })).body, /@alice\.example/);

        await call('POST', '/me/bbs', { cookie, form: { bbs: 'coolbbs', answer: 'denied' } });
        assert.match((await call('GET', '/space', { cookie })).body, /for members of its BBSes/);

        //  only about a BBS that has said something about her
        registry.add('otherbbs', OtherSysopDid, null, {});
        assert.equal(
            (await call('POST', '/me/bbs', { cookie, form: { bbs: 'otherbbs', answer: 'confirmed' } }))
                .status,
            400
        );
    });

    it('has no report endpoint while the space is off', async () => {
        await start(false);
        const { token } = registry.add('coolbbs', SysopDid, null, {});
        assert.equal((await postReport(aliceOn(), token)).status, 404);
        assert.equal((await call('GET', '/space')).status, 404);
    });
});

describe('registering with approval and an account age (H9)', () => {
    //  accounts made on these dates, as the PLC directory would say
    const made: Record<string, string | null> = {
        [SysopDid]: '2025-01-01T00:00:00.000Z',
        [OtherSysopDid]: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const at = {
        async accountCreated(did: string) {
            if (!(did in made)) {
                throw new Error('PLC directory unreachable');
            }
            return made[did] ?? null;
        },
    } as unknown as AtClient;

    it('sends an application to the admin, which the sysop sees, and approving it lets them in', async () => {
        await start(false, { approval: true, minAccountAgeDays: 30 }, at);
        const cookie = await signedIn();
        const form = await call('GET', '/bbs', { cookie });
        assert.match(form.body, /Apply to register a BBS/);
        assert.match(form.body, /at least 30 days old/);
        const sent = await call('POST', '/bbs', {
            cookie,
            form: { rating: 'yes', name: 'coolbbs', note: 'Retro games' },
        });
        assert.equal(sent.status, 303);
        assert.equal(registry.get('coolbbs'), null);
        assert.equal(registry.application('coolbbs')?.note, 'Retro games');
        const waiting = await call('GET', '/bbs', { cookie });
        assert.match(waiting.body, /coolbbs<\/strong>[^<]*<\/td><td>waiting for the hub's admin/);

        registry.approve('coolbbs');
        const approved = await call('GET', '/bbs', { cookie });
        assert.match(approved.body, /press <strong>New token<\/strong> to get its agent config/);
        const token = await call('POST', '/bbs/rotate', { cookie, form: { name: 'coolbbs' } });
        assert.match(token.body, /metadatas\.token = /);
    });

    it('shows why an application was turned down, and lets a sysop withdraw one', async () => {
        await start(false, { approval: true, minAccountAgeDays: 0 }, at);
        const cookie = await signedIn();
        await call('POST', '/bbs', { cookie, form: { rating: 'yes', name: 'coolbbs' } });
        registry.reject('coolbbs', 'Not a BBS');
        assert.match((await call('GET', '/bbs', { cookie })).body, /not approved: Not a BBS/);
        await call('POST', '/bbs', { cookie, form: { rating: 'yes', name: 'other' } });
        assert.equal(
            (await call('POST', '/bbs/withdraw', { cookie, form: { name: 'other' } })).location,
            '/bbs'
        );
        assert.equal(registry.application('other'), null);
    });

    it('turns away accounts that are too new, or whose age it cannot check', async () => {
        await start(false, { approval: false, minAccountAgeDays: 30 }, at);
        const young = await signedIn({ did: OtherSysopDid, handle: 'other.example' });
        const refused = await call('POST', '/bbs', { cookie: young, form: { rating: 'yes', name: 'young' } });
        assert.equal(refused.status, 403);
        assert.match(refused.body, /at least 30 days old\. Yours will be on \d{4}-\d\d-\d\d/);

        const old = await signedIn();
        assert.equal(
            (await call('POST', '/bbs', { cookie: old, form: { rating: 'yes', name: 'old' } })).status,
            200
        );

        delete made[SysopDid];
        const unknown = await call('POST', '/bbs', { cookie: old, form: { rating: 'yes', name: 'again' } });
        assert.equal(unknown.status, 403);
        assert.match(unknown.body, /couldn&#39;t check how old|couldn't check how old/);
        made[SysopDid] = '2025-01-01T00:00:00.000Z';
    });
});

describe('the art the hub offers (assets, a first slice)', () => {
    function library(): AssetLibrary {
        const dir = mkdtempSync(join(tmpdir(), 'hub-art-'));
        try {
            writeFileSync(join(dir, 'skull.ans'), Buffer.from('\x1b[1;32m\xdb\xdb SKULL', 'latin1'));
            bake(
                [join(dir, 'skull.ans')],
                join(dir, 'lib'),
                {
                    font: testFont(dir),
                    mci: false,
                    licence: { id: 'custom', text: 'Ask the artist' },
                    rating: 'general',
                    themes: [],
                    author: 'Ana',
                    group: 'ACiD',
                    note: '',
                },
                { name: 'Test art', description: 'Art for tests.' }
            );
            return AssetLibrary.load(join(dir, 'lib'));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }

    it('shows a gallery and its list to anyone, with credit and licence', async () => {
        const art = library();
        await start(false, {}, null, art);
        const page = await call('GET', '/art');
        assert.equal(page.status, 200);
        assert.match(page.body, /<h3>skull<\/h3>/);
        assert.match(page.body, /By Ana of ACiD/);
        assert.match(page.body, /Licence: Ask the artist/);
        assert.match(page.body, /<img src="\/assets\/[0-9a-f]{64}"/);
        const list = JSON.parse((await call('GET', '/art.json')).body);
        assert.equal(list.items.length, 1);
        assert.equal(list.items[0].credit, 'Ana of ACiD');
        assert.equal(list.items[0].id, art.items[0]!.id);
    });

    it('serves its files by hash, kept for good and never run as a page', async () => {
        const art = library();
        await start(false, {}, null, art);
        const item = art.items[0]!;
        const png = await call('GET', item.thumb.url);
        assert.equal(png.status, 200);
        assert.equal(png.headers['content-type'], 'image/png');
        assert.equal(png.headers['cache-control'], 'public, max-age=31536000, immutable');
        assert.equal(png.headers['content-security-policy'], "default-src 'none'; sandbox");
        assert.equal(png.headers['x-content-type-options'], 'nosniff');
        assert.equal((await call('GET', item.ansi)).headers['content-type'], 'text/x-ansi');
        assert.equal((await call('GET', `/assets/${'0'.repeat(64)}`)).status, 404);
        assert.equal((await call('GET', '/assets/../library.json')).status, 404);
    });

    it('serves the VGA font for art drawn as characters', async () => {
        await start(false, {}, null, library());
        const font = await call('GET', '/fonts/vga-8x16.woff');
        assert.equal(font.status, 200);
        assert.equal(font.headers['content-type'], 'font/woff');
        assert.ok(font.body.startsWith('wOFF'));
    });

    it('has none of it when the hub offers no art', async () => {
        await start(false);
        assert.equal((await call('GET', '/art')).status, 404);
        assert.equal((await call('GET', '/art.json')).status, 404);
    });
});

describe('views (how a person sees the hub)', () => {
    it("the hub's own views can all be read", () => {
        for (const view of Views) {
            assert.deepEqual(viewProblems(view), [], view.id);
        }
        assert.match(
            viewProblems({ ...Views[1]!, colours: { ...Views[1]!.colours!, dim: '#222222' } }).join(),
            /dim on the background has a contrast of 1\.\d, under 4\.5/
        );
    });

    it('sets a view for every page, from a menu that works without scripts', async () => {
        await start(false);
        const home = await call('GET', '/');
        assert.match(home.body, /<form class="inline view-pick" method="post" action="\/view">/);
        assert.match(home.body, /<html lang="en" data-view="hub" data-art="pictures">/);
        const chose = await call('POST', '/view', { form: { view: 'pink', back: '/terms' } });
        assert.equal(chose.status, 303);
        assert.equal(chose.location, '/terms');
        assert.match(chose.headers['set-cookie']?.[0] ?? '', /^hub_view=pink; Path=\/; SameSite=Lax/);
        const pink = await call('GET', '/', { cookie: 'hub_view=pink' });
        assert.match(pink.body, /data-view="pink" data-art="ansi"/);
        assert.match(pink.body, /--bg: #fff5f9;/);
        assert.match(pink.body, /<option value="pink" selected>/);
        assert.match(pink.headers['content-security-policy'] as string, /font-src 'self'/);
        const font = await call('GET', '/fonts/vga-8x16.woff');
        assert.equal(font.status, 200, 'the font views use is there without art');
    });

    it('keeps the plain hub look where people sign in or see tokens, and goes back only to this hub', async () => {
        await start(false);
        const signin = await call('GET', '/signin', { cookie: 'hub_view=bbs' });
        assert.doesNotMatch(signin.body, /data-view=|<form class="inline view-pick"|--bg: #000000/);
        const cookie = await signedIn();
        const bbs = await call('GET', '/bbs', { cookie: `${cookie}; hub_view=bbs` });
        assert.doesNotMatch(bbs.body, /data-view=|<form class="inline view-pick"/);
        for (const back of ['//evil.example/', 'https://evil.example/', '/\\evil.example']) {
            const away = await call('POST', '/view', { form: { view: 'bbs', back } });
            assert.equal(away.location, '/', back);
        }
        const unknown = await call('POST', '/view', { form: { view: 'nope', back: '/' } });
        assert.equal(unknown.headers['set-cookie'], undefined);
    });
});

describe('abuse reports', () => {
    const report = (form: Record<string, string>, options: { cookie?: string; forwardedFor?: string } = {}) =>
        call('POST', '/report', { form, ...options });

    it('takes a report from anyone, about a BBS or the hub, and keeps what it says out of the logs', async () => {
        registry.add('coolbbs', SysopDid);
        const page = await call('GET', '/report?bbs=coolbbs');
        assert.equal(page.status, 200);
        assert.match(page.body, /<option value="coolbbs" selected>/);
        assert.match(page.body, /<option value="copyright">/);

        const sent = await report({
            bbs: 'coolbbs',
            kind: 'harassment',
            details: 'Threats in the\nmessage base',
            contact: 'me@example.com',
        });
        assert.equal(sent.status, 200);
        assert.match(sent.body, /Report 1 has gone/);
        assert.equal((await report({ bbs: '', kind: 'security', details: 'A hole' })).status, 200);

        const reports = new AbuseReports(registry.db).list();
        assert.deepEqual(
            reports.map(r => [r.bbs, r.kind, r.details, r.contact, r.reporter]),
            [
                ['coolbbs', 'harassment', 'Threats in the\nmessage base', 'me@example.com', null],
                [null, 'security', 'A hole', null, null],
            ]
        );
        assert.ok(logs.some(l => /abuse: report 1 about coolbbs/.test(l)));
        for (const line of logs) {
            assert.ok(!/Threats|me@example|A hole/.test(line), line);
        }
    });

    it('says who sent it when they are signed in', async () => {
        registry.add('coolbbs', SysopDid);
        const cookie = await signedIn({ did: OtherSysopDid, handle: 'other.example' });
        assert.equal(
            (await report({ bbs: 'coolbbs', kind: 'spam', details: 'Ads' }, { cookie })).status,
            200
        );
        assert.equal(new AbuseReports(registry.db).list()[0]?.reporter, OtherSysopDid);
    });

    it('refuses forms from elsewhere, unknown or suspended BBSes, and empty or bad reports', async () => {
        registry.add('coolbbs', SysopDid);
        registry.add('gone', SysopDid);
        registry.setState('gone', 'suspended');
        const elsewhere = await call('POST', '/report', {
            form: { kind: 'spam', details: 'x' },
            origin: 'https://evil.example',
        });
        assert.equal(elsewhere.status, 403);
        assert.equal((await report({ bbs: 'nope', kind: 'spam', details: 'x' })).status, 400);
        assert.equal((await report({ bbs: 'gone', kind: 'spam', details: 'x' })).status, 400);
        assert.equal((await report({ bbs: 'coolbbs', kind: 'nonsense', details: 'x' })).status, 400);
        const empty = await report({ bbs: 'coolbbs', kind: 'spam', details: '   ' });
        assert.equal(empty.status, 400);
        assert.match(empty.body, /Say what/);
        assert.equal((await report({ kind: 'spam', details: 'x'.repeat(4001) })).status, 400);
        assert.equal(new AbuseReports(registry.db).list().length, 0);
    });

    it('takes a few an hour from one address', async () => {
        const from = (address: string, details: string) =>
            report({ kind: 'spam', details }, { forwardedFor: address }).then(r => r.status);
        for (let i = 0; i < 5; i++) {
            assert.equal(await from('203.0.113.9', `${i}`), 200);
        }
        assert.equal(await from('203.0.113.9', 'more'), 429);
        assert.equal(await from('203.0.113.10', 'other'), 200);
    });

    it('links to the form from the directory and from each BBS page', async () => {
        assert.match((await call('GET', '/')).body, /href="\/report"/);
    });
});

describe("the hub's terms", () => {
    it('serves its terms and privacy notice from files, and asks people to agree to them', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hub-policy-'));
        const config = makeConfig({
            policy: { termsFile: join(dir, 'terms.html'), privacyFile: join(dir, 'privacy.html') },
        });
        const reg = testRegistry();
        const site = createSite({ config, registry: reg, signin: new SignIn(reg.db, config) });
        await new Promise<void>(r => site.listen(0, '127.0.0.1', r));
        const at = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
        try {
            assert.equal((await fetch(`${at}/terms`)).status, 503, 'the file is missing');
            writeFileSync(join(dir, 'terms.html'), '<p>Be kind.</p>');
            writeFileSync(join(dir, 'privacy.html'), '<p>We keep little.</p>');
            const terms = await fetch(`${at}/terms`);
            assert.equal(terms.status, 200);
            assert.match(await terms.text(), /<h1>Terms of service<\/h1>[\s\S]*<p>Be kind\.<\/p>/);
            assert.match(await (await fetch(`${at}/privacy`)).text(), /We keep little/);
            assert.match(
                await (await fetch(`${at}/signin`)).text(),
                /I'm 16 or older, and I agree to this hub's <a href="\/terms">terms of service<\/a> and <a href="\/privacy">privacy notice<\/a>\./
            );
        } finally {
            site.closeAllConnections();
            await new Promise(r => site.close(r));
            reg.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('has no terms pages, and asks nothing, when a hub sets none', async () => {
        assert.equal((await call('GET', '/terms')).status, 404);
        const config = makeConfig({ policy: { minimumAge: 0 } });
        const reg = testRegistry();
        const site = createSite({ config, registry: reg, signin: new SignIn(reg.db, config) });
        await new Promise<void>(r => site.listen(0, '127.0.0.1', r));
        try {
            const page = await fetch(`http://127.0.0.1:${(site.address() as AddressInfo).port}/signin`);
            assert.doesNotMatch(await page.text(), /name="agree"/);
        } finally {
            site.closeAllConnections();
            await new Promise(r => site.close(r));
            reg.close();
        }
    });
});

describe('the status for monitors', () => {
    it('says whether the hub can carry tunnels and chat, and whether a BBS is up', async () => {
        const config = testConfig();
        const reg = testRegistry();
        reg.add('coolbbs', SysopDid);
        reg.add('quiet', OtherSysopDid);
        reg.add('gone', OtherSysopDid);
        reg.setState('gone', 'suspended');
        reg.proxyOpened('coolbbs', 'coolbbs.web', null);
        let tunnels = 'ok';
        const site = createSite({
            config,
            registry: reg,
            signin: new SignIn(reg.db, config),
            tunnels: () => tunnels,
        });
        await new Promise<void>(r => site.listen(0, '127.0.0.1', r));
        const at = `http://127.0.0.1:${(site.address() as AddressInfo).port}/status.json`;
        const get = async (query = '') => {
            const r = await fetch(at + query);
            return { status: r.status, body: (await r.json()) as Record<string, unknown> };
        };
        try {
            const all = await get();
            assert.equal(all.status, 200);
            assert.equal(all.body.ok, true);
            assert.equal(all.body.chat, 'off');
            assert.deepEqual(
                all.body.bbses,
                { coolbbs: 'connected', quiet: 'disconnected' },
                'not suspended ones'
            );
            assert.equal((await get('?bbs=coolbbs')).status, 200);
            assert.equal((await get('?bbs=quiet')).status, 503);
            assert.equal((await get('?bbs=gone')).status, 404);
            assert.equal((await get('?bbs=nope')).status, 404);

            tunnels = 'down';
            const down = await get();
            assert.equal(down.status, 503);
            assert.equal(down.body.tunnels, 'down');
            assert.equal((await get('?bbs=coolbbs')).status, 503);
            assert.equal(site.liveViewers(), 0);
        } finally {
            site.closeAllConnections();
            await new Promise(r => site.close(r));
            reg.close();
        }
    });
});
