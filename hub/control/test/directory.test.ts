import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AtClient } from '../src/atproto.ts';
import { makeConfig, type HubConfig } from '../src/config.ts';
import { Directory } from '../src/directory.ts';
import { applyEvent, streamUrl } from '../src/jetstream.ts';
import { pointsAtHub, sanitizeListing, sanitizeStatus } from '../src/listing.ts';
import { fetchPublicJson, isPublicAddress } from '../src/net.ts';
import { Registry } from '../src/registry.ts';
import { BbsDid, OtherSysopDid, SysopDid } from './helpers.ts';

const Other = 'did:plc:eeeeeeeeeeeeeeeeeeeeeeee';
const Third = 'did:plc:ffffffffffffffffffffffff';
const ListingNsid = 'nexus.cyberspace.dev.leaf.listing';
const StatusNsid = 'nexus.cyberspace.dev.leaf.status';

const listing = (overrides: Record<string, unknown> = {}) => ({
    $type: ListingNsid,
    name: 'Cool BBS',
    description: 'Doors and ANSI',
    tags: ['retro', 'ansi'],
    endpoints: [{ protocol: 'web', uri: 'https://coolbbs.hub.test/' }],
    createdAt: '2026-11-09T00:00:00.000Z',
    ...overrides,
});

describe('fetching from addresses others choose', () => {
    it('knows public from private addresses', () => {
        for (const ip of ['1.1.1.1', '8.8.8.8', '2606:4700::1111']) {
            assert.ok(isPublicAddress(ip), ip);
        }
        for (const ip of [
            '127.0.0.1',
            '10.1.2.3',
            '172.16.0.1',
            '192.168.50.233',
            '169.254.169.254',
            '100.64.0.1',
            '0.0.0.0',
            '::1',
            '::',
            'fe80::1',
            'fd00::1',
            '::ffff:127.0.0.1',
            '::ffff:10.0.0.1',
            '64:ff9b::a00:1',
            'not an ip',
        ]) {
            assert.equal(isPublicAddress(ip), false, ip);
        }
    });

    it('refuses anything but public https', async () => {
        for (const url of [
            'http://example.com/x',
            'https://127.0.0.1/x',
            'https://[::1]/x',
            'https://192.168.1.1/x',
            'https://user:pw@example.com/x',
            'file:///etc/passwd',
            'not a url',
        ]) {
            await assert.rejects(fetchPublicJson(url), Error, url);
        }
    });

    it('refuses a name that resolves to this machine', async () => {
        await assert.rejects(
            fetchPublicJson('https://localhost/x', { timeoutMs: 3000 }),
            /not a public address/
        );
    });
});

describe('listings from the network', () => {
    it('keeps only known fields, within limits', () => {
        const l = sanitizeListing(
            listing({
                name: `  Cool\u0007 BBS‮  `,
                description: 'x'.repeat(2000),
                tags: ['Retro', 'retro', 'no<script>', 'ok-tag', ...Array(20).fill('t')],
                rating: 'ADULT',
                evil: { nested: true },
                endpoints: [
                    { protocol: 'web', uri: 'https://coolbbs.hub.test/' },
                    { protocol: 'web', uri: 'javascript:alert(1)' },
                    { protocol: 'web', uri: 'http://plain.example/' },
                    { protocol: 'ssh', uri: 'ssh://bbs.example:22' },
                    { protocol: 'ftp', uri: 'ftp://x.example/' },
                    { protocol: 'web', uri: 'https://u:p@x.example/' },
                ],
                hours: {
                    timezone: 'Not/AZone',
                    weekly: [
                        { days: ['fri', 'funday'], from: '19:00', to: '23:00' },
                        { days: ['sat'], from: '25:00', to: '23:00' },
                    ],
                },
            })
        );
        assert.ok(l);
        assert.equal(l.name, 'Cool  BBS');
        assert.equal(Array.from(l.description).length, 500);
        assert.deepEqual(l.tags, ['retro', 'ok-tag', 't']);
        assert.equal(l.rating, 'adult');
        assert.deepEqual(
            l.endpoints.map(e => e.uri),
            ['https://coolbbs.hub.test/', 'ssh://bbs.example:22']
        );
        assert.deepEqual(l.hours, {
            timezone: '',
            weekly: [{ days: ['fri'], from: '19:00', to: '23:00' }],
            note: '',
        });
        assert.equal('evil' in l, false);
    });

    it('needs a name; an unknown rating counts as general', () => {
        assert.equal(sanitizeListing({ description: 'no name' }), null);
        assert.equal(sanitizeListing(null), null);
        assert.equal(sanitizeListing(listing({ rating: 'spicy' }))?.rating, 'general');
    });

    it('checks status records too', () => {
        assert.deepEqual(
            sanitizeStatus({ state: 'maintenance', message: 'New disk', until: '2026-12-01T20:00:00Z' }),
            {
                state: 'maintenance',
                message: 'New disk',
                until: '2026-12-01T20:00:00.000Z',
                updatedAt: null,
            }
        );
        assert.equal(sanitizeStatus({ state: 'Up Now!' }), null);
    });

    it("knows whether a listing names a BBS's address on this hub", () => {
        const l = sanitizeListing(listing())!;
        assert.ok(pointsAtHub(l, 'coolbbs', 'hub.test'));
        assert.equal(pointsAtHub(l, 'other', 'hub.test'), false);
        assert.equal(pointsAtHub(l, 'coolbbs', 'elsewhere.test'), false);
    });
});

let config: HubConfig;
let registry: Registry;
let directory: Directory;

function setup(overrides: Partial<HubConfig['directory']> = {}) {
    config = makeConfig({ domain: 'hub.test', directory: overrides });
    registry = new Registry(':memory:', config.registration);
    directory = new Directory(registry, config);
}

describe('the directory', () => {
    beforeEach(() => setup());

    it('links a listing to a registered BBS only when both sides agree', () => {
        registry.add('coolbbs', SysopDid);
        directory.putListing(BbsDid, 'cid1', listing());
        assert.equal(directory.entry(BbsDid)?.bbs, null, 'the sysop named no account');

        registry.setBbsDid('coolbbs', BbsDid);
        assert.equal(directory.entry(BbsDid)?.bbs?.name, 'coolbbs');
        assert.equal(directory.forBbs(registry.mustGet('coolbbs'))?.listing.name, 'Cool BBS');

        //  an impostor's listing naming coolbbs's address links to nothing
        directory.putListing(Other, 'cid2', listing({ name: 'Fake Cool BBS' }));
        assert.equal(directory.entry(Other)?.bbs, null);

        //  and a sysop claiming an account whose listing doesn't name them
        registry.add('thief', OtherSysopDid, Third);
        directory.putListing(Third, 'cid3', listing({ endpoints: [] }));
        assert.equal(directory.entry(Third)?.bbs, null);
        assert.equal(directory.forBbs(registry.mustGet('thief')), null);
    });

    it('a suspended BBS is no longer linked', () => {
        registry.add('coolbbs', SysopDid, BbsDid);
        directory.putListing(BbsDid, 'cid1', listing());
        registry.setState('coolbbs', 'suspended');
        assert.equal(directory.entry(BbsDid)?.bbs, null);
    });

    it('shows only the ratings the hub allows', () => {
        directory.putListing(BbsDid, 'c1', listing({ name: 'Plain' }));
        directory.putListing(Other, 'c2', listing({ name: 'Grown-up', rating: 'adult' }));
        assert.deepEqual(
            directory.entries().map(e => e.listing.name),
            ['Plain']
        );
    });

    it('hides accounts the admin chose, now and later', () => {
        directory.putListing(Other, 'c1', listing());
        directory.hide(Other, 'spam');
        assert.equal(directory.entry(Other), null);
        assert.equal(directory.putListing(Other, 'c2', listing()), false);
        assert.deepEqual(
            directory.hidden().map(h => h.reason),
            ['spam']
        );
        directory.unhide(Other);
        assert.equal(directory.putListing(Other, 'c3', listing()), true);
    });

    it('in "hub" scope keeps only its own BBSes', () => {
        setup({ scope: 'hub' });
        registry.add('coolbbs', SysopDid, BbsDid);
        assert.equal(directory.putListing(BbsDid, 'c1', listing()), true);
        assert.equal(directory.putListing(Other, 'c2', listing()), false);
    });

    it('ignores a rewrite with no change', () => {
        let clock = Date.UTC(2026, 10, 9);
        directory = new Directory(registry, config, () => new Date(clock));
        directory.putListing(Other, 'same', listing());
        clock += 60_000;
        directory.putListing(Other, 'same', listing());
        assert.equal(directory.entry(Other)?.updatedAt, '2026-11-09T00:00:00.000Z');
    });
});

describe('following the network', () => {
    beforeEach(() => setup());

    const commit = (did: string, collection: string, operation: string, record?: unknown) => ({
        did,
        time_us: 1,
        kind: 'commit',
        commit: { operation, collection, rkey: 'self', cid: `cid-${operation}`, record },
    });

    it('applies listing and status changes', () => {
        assert.ok(applyEvent(directory, commit(Other, ListingNsid, 'create', listing())));
        assert.ok(
            applyEvent(directory, commit(Other, StatusNsid, 'update', { state: 'down', message: 'Moving' }))
        );
        assert.equal(directory.entry(Other)?.status?.state, 'down');
        assert.ok(applyEvent(directory, commit(Other, StatusNsid, 'delete')));
        assert.equal(directory.entry(Other)?.status, null);
        assert.ok(applyEvent(directory, commit(Other, ListingNsid, 'delete')));
        assert.equal(directory.entry(Other), null);
    });

    it('ignores everything else', () => {
        assert.equal(applyEvent(directory, { did: Other, kind: 'identity' }), false);
        assert.equal(applyEvent(directory, commit(Other, 'app.bsky.feed.post', 'create', {})), false);
        assert.equal(
            applyEvent(directory, {
                ...commit(Other, ListingNsid, 'create', listing()),
                commit: { ...commit(Other, ListingNsid, 'create', listing()).commit, rkey: 'other' },
            }),
            false
        );
        //  a status for an account with no listing
        assert.equal(applyEvent(directory, commit(Third, StatusNsid, 'create', { state: 'up' })), false);
        assert.equal(directory.entry(Third), null);
    });

    it('asks for our record types, from a little before where it stopped', () => {
        const url = new URL(streamUrl(directory, '1000000000')!);
        assert.deepEqual(url.searchParams.getAll('wantedCollections'), [ListingNsid, StatusNsid]);
        assert.equal(url.searchParams.get('cursor'), String(1_000_000_000 - 5_000_000));
        assert.equal(new URL(streamUrl(directory, null)!).searchParams.has('cursor'), false);
    });

    it('in "hub" scope follows only its own BBSes, or nothing', () => {
        setup({ scope: 'hub' });
        assert.equal(streamUrl(directory, null), null);
        registry.add('coolbbs', SysopDid, BbsDid);
        assert.deepEqual(new URL(streamUrl(directory, null)!).searchParams.getAll('wantedDids'), [BbsDid]);
    });
});

describe('the first sweep', () => {
    beforeEach(() => setup());

    //  a small stand-in network
    function network(
        records: Record<string, { listing?: unknown; status?: unknown; fail?: boolean }>,
        pages: string[][]
    ) {
        const asked: string[] = [];
        const at: AtClient = {
            async resolvePds() {
                return 'https://pds.example';
            },
            async getRecord(did, collection) {
                asked.push(`${did} ${collection.split('.').pop()}`);
                const r = records[did];
                if (r?.fail) {
                    throw new Error('server down');
                }
                const value = collection === ListingNsid ? r?.listing : r?.status;
                return value ? { cid: `cid-${did}`, value } : null;
            },
            async listRepos(_collection, cursor) {
                const i = cursor ? Number(cursor) : 0;
                return { dids: pages[i] ?? [], cursor: i + 1 < pages.length ? String(i + 1) : undefined };
            },
            async resolveHandle() {
                throw new Error('unused');
            },
        };
        return { at, asked };
    }

    it('fetches every listing the relay knows of, page by page', async () => {
        directory.putListing(Third, 'old', listing({ name: 'Gone' }));
        const { at } = network(
            {
                [BbsDid]: { listing: listing({ name: 'One' }), status: { state: 'up' } },
                [Other]: { listing: listing({ name: 'Two' }) },
                [Third]: {},
                'did:plc:gggggggggggggggggggggggg': { fail: true },
            },
            [
                [BbsDid, Other],
                [Third, 'did:plc:gggggggggggggggggggggggg', BbsDid],
            ]
        );
        const result = await directory.sweep(at, () => {}, 0);
        assert.deepEqual(result, { accounts: 4, listed: 2, removed: 1, failed: 1 });
        assert.deepEqual(
            directory
                .entries()
                .map(e => e.listing.name)
                .sort(),
            ['One', 'Two']
        );
        assert.equal(directory.entry(BbsDid)?.status?.state, 'up');
        assert.ok(directory.getState('lastSweep'));
    });

    it('skips hidden accounts, and in "hub" scope asks only about its own', async () => {
        directory.hide(Other, 'spam');
        const first = network({ [Other]: { listing: listing() } }, [[Other]]);
        await directory.sweep(first.at, () => {}, 0);
        assert.deepEqual(first.asked, []);

        setup({ scope: 'hub' });
        registry.add('coolbbs', SysopDid, BbsDid);
        const second = network({ [BbsDid]: { listing: listing() }, [Other]: { listing: listing() } }, [
            [BbsDid, Other],
        ]);
        await directory.sweep(second.at, () => {}, 0);
        assert.deepEqual(second.asked, [`${BbsDid} listing`, `${BbsDid} status`]);
    });
});

describe('the directory on the hub site', () => {
    it('lists this hub first, then the rest of the network, escaped', async () => {
        const { createSite } = await import('../src/site.ts');
        const { SignIn } = await import('../src/signin.ts');
        const { request } = await import('node:http');
        setup();
        registry.add('coolbbs', SysopDid, BbsDid);
        registry.add('quiet', OtherSysopDid);
        directory.putListing(BbsDid, 'c1', listing({ hours: { note: 'Evenings' } }));
        directory.putListing(
            Other,
            'c2',
            listing({
                name: 'Far <b>Away</b>',
                endpoints: [{ protocol: 'telnet', uri: 'telnet://far.example:23' }],
            })
        );
        directory.putListing(Third, 'c3', listing({ name: 'Grown-up', rating: 'adult' }));
        const server = createSite({ config, registry, signin: new SignIn(registry.db, config), directory });
        await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
        const port = (server.address() as { port: number }).port;
        const get = (host: string, path: string) =>
            new Promise<string>((resolve, reject) => {
                const req = request(
                    { host: '127.0.0.1', port, path, headers: { Host: host }, agent: false },
                    res => {
                        let body = '';
                        res.on('data', d => (body += d));
                        res.on('end', () => resolve(body));
                    }
                );
                req.on('error', reject);
                req.end();
            });
        try {
            const page = await get('hub.test', '/');
            const ours = page.indexOf('BBSes on this hub');
            const elsewhere = page.indexOf('Elsewhere on the network');
            assert.ok(ours > 0 && elsewhere > ours);
            assert.ok(page.indexOf('Cool BBS') > ours && page.indexOf('Cool BBS') < elsewhere);
            assert.ok(
                page.indexOf('quiet') > ours && page.indexOf('quiet') < elsewhere,
                'registered, unlisted'
            );
            assert.ok(page.indexOf('Far &lt;b&gt;Away') > elsewhere);
            assert.doesNotMatch(page, /<b>Away/);
            assert.match(page, /telnet:\/\/far\.example:23/);
            assert.doesNotMatch(page, /Grown-up/);
            assert.match(page, /Register it on this hub/);

            const board = await get('coolbbs.hub.test', '/');
            assert.match(board, /<title>Cool BBS<\/title>/);
            assert.match(board, /Doors and ANSI/);
            assert.match(board, /Evenings/);
        } finally {
            server.closeAllConnections();
            server.close();
        }
    });
});
