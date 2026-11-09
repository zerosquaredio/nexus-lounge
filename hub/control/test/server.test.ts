import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { request, type Server } from 'node:http';
import { createControlServer } from '../src/server.ts';
import type { Registry } from '../src/registry.ts';
import { BbsDid, OtherSysopDid, SysopDid, testConfig, testRegistry } from './helpers.ts';

let server: Server;
let base: string;
let registry: Registry;
let token: string;

before(async () => {
    registry = testRegistry();
    token = registry.add('coolbbs', SysopDid, BbsDid).token;
    registry.add('nodid', OtherSysopDid);
    registry.add('banned', OtherSysopDid);
    registry.setBbsDid('banned', 'did:plc:dddddddddddddddddddddddd');
    registry.setState('banned', 'suspended');
    server = createControlServer({ config: testConfig(), registry });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
    server.close();
    registry.close();
});

const hook = (body: unknown) =>
    fetch(`${base}/frp/handler`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'string' === typeof body ? body : JSON.stringify(body),
    }).then(r => r.json());

//  plain http.request: fetch won't send a Host header of our choosing
const status = (path: string, host?: string): Promise<{ code: number; text: string }> =>
    new Promise((resolve, reject) => {
        const req = request(`${base}${path}`, host ? { headers: { Host: host } } : {}, res => {
            let text = '';
            res.on('data', d => (text += d));
            res.on('end', () => resolve({ code: res.statusCode ?? 0, text }));
        });
        req.on('error', reject);
        req.end();
    });

describe('the control server', () => {
    it("answers frp's hook", async () => {
        assert.deepEqual(
            await hook({ version: '0.1.0', op: 'Login', content: { user: 'coolbbs', metas: { token } } }),
            {
                reject: false,
                unchange: true,
            }
        );
        assert.equal(
            (await hook({ op: 'Login', content: { user: 'coolbbs', metas: { token: 'no' } } })).reject,
            true
        );
    });

    it('refuses a malformed or oversized hook request', async () => {
        assert.deepEqual(await hook('{not json'), { reject: true, reject_reason: 'Bad request' });
        const big = JSON.stringify({ op: 'Login', content: { user: 'coolbbs', pad: 'x'.repeat(70 * 1024) } });
        const result = await hook(big).catch(() => ({ reject: true }));
        assert.equal(result.reject, true);
    });

    it('lets Caddy make certificates only for the hub and registered, active BBSes', async () => {
        const ask = (domain: string) =>
            status(`/tls/allowed?domain=${encodeURIComponent(domain)}`).then(r => r.code);
        assert.equal(await ask('hub.test'), 200);
        assert.equal(await ask('coolbbs.hub.test'), 200);
        assert.equal(await ask('COOLBBS.hub.test'), 200);
        assert.equal(await ask('nodid.hub.test'), 200);
        assert.equal(await ask('banned.hub.test'), 404);
        assert.equal(await ask('nobody.hub.test'), 404);
        assert.equal(await ask('a.coolbbs.hub.test'), 404);
        assert.equal(await ask('coolbbs.hub.test.evil.example'), 404);
        assert.equal(await ask('evil.example'), 404);
        assert.equal(await ask(''), 404);
    });

    it('answers handle verification from the registry, never from the BBS', async () => {
        assert.deepEqual(await status('/.well-known/atproto-did', 'coolbbs.hub.test'), {
            code: 200,
            text: BbsDid,
        });
        assert.deepEqual(await status('/.well-known/atproto-did', 'coolbbs.hub.test:7443'), {
            code: 200,
            text: BbsDid,
        });
        assert.equal((await status('/.well-known/atproto-did', 'nodid.hub.test')).code, 404);
        assert.equal((await status('/.well-known/atproto-did', 'banned.hub.test')).code, 404);
        assert.equal((await status('/.well-known/atproto-did', 'nobody.hub.test')).code, 404);
        assert.equal((await status('/.well-known/atproto-did', 'hub.test')).code, 404);
    });

    it('keeps idle connections longer than frps and Caddy do, so they close first', () => {
        //  Go's default idle timeout is 90 seconds; Node's own default (5)
        //  made frps's hook calls fail now and then (found end to end)
        assert.ok(server.keepAliveTimeout > 90_000);
        assert.ok(server.headersTimeout > server.keepAliveTimeout);
    });

    it('has nothing else', async () => {
        assert.equal((await status('/')).code, 404);
        assert.equal((await status('/frp/handler')).code, 405);
        assert.equal((await status('/healthz')).code, 200);
    });
});
