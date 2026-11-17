import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeConfig } from '../src/config.ts';
import { hubAccountMetadata, hubAccountScope, XrpcError, type RecordWriter } from '../src/hub_account.ts';
import { checkTunnels, ObservedStatus } from '../src/observed.ts';
import type { Registry } from '../src/registry.ts';
import { BbsDid, SysopDid, testRegistry } from './helpers.ts';

const OtherBbsDid = 'did:plc:dddddddddddddddddddddddd';
const HubDid = 'did:plc:hubhubhubhubhubhubhubhubh';
const Collection = 'nexus.cyberspace.dev.hub.observedStatus';

class FakeWriter implements RecordWriter {
    account: string | null = HubDid;
    puts: { collection: string; rkey: string; record: Record<string, unknown> }[] = [];
    deletes: { collection: string; rkey: string }[] = [];
    fail: Error | null = null;

    did() {
        return this.account;
    }
    async putRecord(collection: string, rkey: string, record: Record<string, unknown>) {
        if (this.fail) {
            throw this.fail;
        }
        this.puts.push({ collection, rkey, record });
    }
    async deleteRecord(collection: string, rkey: string) {
        if (this.fail) {
            throw this.fail;
        }
        this.deletes.push({ collection, rkey });
    }
}

describe('the hub account', () => {
    it('asks for identity and writing its observed status records, nothing more', () => {
        const config = makeConfig({ hubAccount: { callbackPort: 7299 } });
        assert.equal(hubAccountScope(config), `atproto repo:${Collection}`);
        const meta = hubAccountMetadata(config);
        assert.deepEqual(meta.redirect_uris, ['http://127.0.0.1:7299/callback']);
        const id = new URL(meta.client_id);
        assert.equal(id.searchParams.get('redirect_uri'), 'http://127.0.0.1:7299/callback');
        assert.equal(id.searchParams.get('scope'), meta.scope);
    });

    it('refuses a config with a port out of range', () => {
        assert.throws(() => makeConfig({ tunnel: { adminPort: 0 } }), /tunnel\.adminPort/);
        assert.throws(() => makeConfig({ hubAccount: { callbackPort: 70000 } }), /callbackPort/);
        assert.throws(() => makeConfig({ observedStatus: { intervalSeconds: 0 } }), /intervalSeconds/);
    });
});

describe('checking the tunnel server', () => {
    let clock: Date;
    let registry: Registry;
    const logs: string[] = [];
    const log = (line: string) => logs.push(line);

    beforeEach(() => {
        clock = new Date('2026-11-17T12:00:00Z');
        registry = testRegistry(() => clock);
        registry.add('coolbbs', SysopDid, BbsDid);
        registry.add('otherbbs', SysopDid, OtherBbsDid);
        logs.length = 0;
    });

    const listing = (...online: string[]) =>
        (async () =>
            new Response(
                JSON.stringify({
                    proxies: [
                        ...online.map(name => ({ name, status: 'online' })),
                        { name: 'gone.web', status: 'offline' },
                    ],
                }),
                { status: 200 }
            )) as unknown as typeof fetch;

    it('forgets proxies the tunnel server no longer has, and keeps those it does', async () => {
        registry.proxyOpened('coolbbs', 'coolbbs.web', null);
        registry.proxyOpened('otherbbs', 'otherbbs.web', null);
        clock = new Date(clock.getTime() + 60 * 1000);
        const r = await checkTunnels(
            registry,
            { port: 7400, password: 'x', fetch: listing('coolbbs.web'), now: () => clock },
            log
        );
        assert.equal(r, 'ok');
        assert.equal(registry.mustGet('coolbbs').connected, true);
        const other = registry.mustGet('otherbbs');
        assert.equal(other.connected, false);
        assert.equal(other.lastDisconnectedAt, clock.toISOString());
        assert.match(logs.join('\n'), /no longer has otherbbs\/otherbbs\.web/);
    });

    it('keeps a proxy opened moments ago, which the list may not show yet', async () => {
        clock = new Date(clock.getTime() + 60 * 1000);
        registry.proxyOpened('coolbbs', 'coolbbs.web', null);
        await checkTunnels(registry, { port: 7400, password: 'x', fetch: listing(), now: () => clock }, log);
        assert.equal(registry.mustGet('coolbbs').connected, true);
    });

    it('when the tunnel server is not running, no BBS is connected', async () => {
        registry.proxyOpened('coolbbs', 'coolbbs.web', null);
        const refused = (async () => {
            throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
        }) as unknown as typeof fetch;
        const r = await checkTunnels(registry, { port: 7400, password: 'x', fetch: refused }, log);
        assert.equal(r, 'down');
        assert.equal(registry.mustGet('coolbbs').connected, false);
    });

    it('changes nothing when it can not tell (wrong password, a timeout, nonsense)', async () => {
        registry.proxyOpened('coolbbs', 'coolbbs.web', null);
        clock = new Date(clock.getTime() + 60 * 1000);
        const answers = [
            (async () => new Response('', { status: 401 })) as unknown as typeof fetch,
            (async () => {
                throw new DOMException('timed out', 'TimeoutError');
            }) as unknown as typeof fetch,
            (async () => new Response('{"nope":1}', { status: 200 })) as unknown as typeof fetch,
        ];
        for (const fetch of answers) {
            const r = await checkTunnels(
                registry,
                { port: 7400, password: 'x', fetch, now: () => clock },
                log
            );
            assert.equal(r, 'error');
            assert.equal(registry.mustGet('coolbbs').connected, true);
        }
        assert.match(logs[0] ?? '', /said 401; is HUB_FRPS_ADMIN_PASSWORD the same/);
    });
});

describe('publishing observed status', () => {
    let clock: Date;
    let registry: Registry;
    let writer: FakeWriter;
    let observed: ObservedStatus;
    const logs: string[] = [];
    const later = (seconds: number) => {
        clock = new Date(clock.getTime() + seconds * 1000);
    };

    beforeEach(() => {
        clock = new Date('2026-11-17T12:00:00Z');
        registry = testRegistry(() => clock);
        writer = new FakeWriter();
        logs.length = 0;
        observed = new ObservedStatus(
            registry,
            writer,
            { nsidPrefix: 'nexus.cyberspace.dev', settleMs: 20 * 1000, now: () => clock },
            line => logs.push(line)
        );
    });

    it('publishes a state once it has held, keyed by the BBS DID', async () => {
        registry.add('coolbbs', SysopDid, BbsDid);
        registry.proxyOpened('coolbbs', 'coolbbs.web', null);
        const connectedAt = clock.toISOString();

        later(5);
        assert.deepEqual((await observed.publish()).settling, ['coolbbs']);
        assert.equal(writer.puts.length, 0);

        later(20);
        assert.deepEqual((await observed.publish()).written, ['coolbbs']);
        assert.deepEqual(writer.puts, [
            {
                collection: Collection,
                rkey: BbsDid,
                record: { $type: Collection, subject: BbsDid, connected: true, since: connectedAt },
            },
        ]);

        //  unchanged: nothing more
        later(60);
        await observed.publish();
        assert.equal(writer.puts.length, 1);
    });

    it('publishes a disconnection, but not a drop that came straight back', async () => {
        registry.add('coolbbs', SysopDid, BbsDid);
        registry.proxyOpened('coolbbs', 'coolbbs.web', null);
        later(30);
        await observed.publish();

        //  drops and returns within the settling time
        registry.proxyClosed('coolbbs', 'coolbbs.web');
        later(3);
        registry.proxyOpened('coolbbs', 'coolbbs.web', null);
        later(30);
        await observed.publish();
        assert.equal(writer.puts.length, 1);

        //  drops for good
        registry.proxyClosed('coolbbs', 'coolbbs.web');
        const droppedAt = clock.toISOString();
        later(25);
        await observed.publish();
        assert.equal(writer.puts.length, 2);
        assert.deepEqual(writer.puts[1]?.record, {
            $type: Collection,
            subject: BbsDid,
            connected: false,
            since: droppedAt,
        });
    });

    it('publishes a BBS that never connected, as disconnected since it registered', async () => {
        const { bbs } = registry.add('coolbbs', SysopDid, BbsDid);
        later(30);
        await observed.publish();
        assert.equal(writer.puts[0]?.record.connected, false);
        assert.equal(writer.puts[0]?.record.since, bbs.createdAt);
    });

    it('skips a BBS without a DID, and takes down the record of one removed', async () => {
        registry.add('nodid', SysopDid);
        registry.add('coolbbs', SysopDid, BbsDid);
        later(30);
        await observed.publish();
        assert.deepEqual(
            writer.puts.map(p => p.rkey),
            [BbsDid]
        );

        registry.remove('coolbbs');
        const r = await observed.publish();
        assert.deepEqual(r.removed, [BbsDid]);
        assert.deepEqual(writer.deletes, [{ collection: Collection, rkey: BbsDid }]);
        assert.equal(observed.published().size, 0);
    });

    it('publishes nothing without a hub account, and everything again for a new one', async () => {
        registry.add('coolbbs', SysopDid, BbsDid);
        later(30);
        writer.account = null;
        await observed.publish();
        await observed.publish();
        assert.equal(writer.puts.length, 0);
        assert.equal(logs.filter(l => /no hub account/.test(l)).length, 1, 'said once');

        writer.account = HubDid;
        await observed.publish();
        writer.account = 'did:plc:newhubnewhubnewhubnewhub';
        await observed.publish();
        assert.equal(writer.puts.length, 2);
    });

    it('tries again after a failure, and stops for the run when rate limited', async () => {
        registry.add('coolbbs', SysopDid, BbsDid);
        registry.add('otherbbs', SysopDid, OtherBbsDid);
        later(30);
        writer.fail = new XrpcError('com.atproto.repo.putRecord', 429, { error: 'RateLimitExceeded' });
        const r = await observed.publish();
        assert.deepEqual(r.failed, ['coolbbs'], 'stopped after the first');

        writer.fail = null;
        assert.deepEqual((await observed.publish()).written, ['coolbbs', 'otherbbs']);
    });

    it('writes a few at a time, without mistaking the rest for removed', async () => {
        for (const [i, did] of [BbsDid, OtherBbsDid, 'did:plc:eeeeeeeeeeeeeeeeeeeeeeee'].entries()) {
            registry.add(`bbs${i}`, SysopDid, did);
        }
        later(30);
        await observed.publish();
        const capped = new ObservedStatus(
            registry,
            writer,
            { nsidPrefix: 'nexus.cyberspace.dev', settleMs: 0, maxWrites: 1, now: () => clock },
            () => undefined
        );
        for (const name of ['bbs0', 'bbs1', 'bbs2']) {
            registry.proxyOpened(name, `${name}.web`, null);
        }
        later(1);
        assert.equal((await capped.publish()).written.length, 1);
        assert.equal((await capped.publish()).written.length, 1);
        assert.equal(writer.deletes.length, 0);
    });
});
