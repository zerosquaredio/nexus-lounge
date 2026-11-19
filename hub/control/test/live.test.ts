import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import type { Chat } from '../src/chat.ts';
import { makeConfig, type HubConfig } from '../src/config.ts';
import { AccessEnded, buildState, diffState, personId, type LiveState } from '../src/live.ts';
import { Presence, type ReportedMember } from '../src/presence.ts';
import { Profiles } from '../src/profiles.ts';
import { Registry } from '../src/registry.ts';
import type { WebSession } from '../src/signin.ts';
import { createSite, type SignInLike } from '../src/site.ts';
import { MaxClientFrame } from '../src/websocket.ts';
import { OtherSysopDid, SysopDid } from './helpers.ts';

const Alice = SysopDid;
const Bob = OtherSysopDid;
const Carol = 'did:plc:dddddddddddddddddddddddd';
const Domain = 'hub.test';
const Origin = 'https://hub.test';
const Expires = Date.UTC(2099, 0, 1);
const Since = '2026-01-01T00:00:00.000Z';

function member(did: string | null, name: string, user?: string): ReportedMember {
    return { ...(did ? { did } : { user: user ?? name }), name, memberSince: Since, online: true };
}

function setup(space: Record<string, unknown> = {}) {
    const config = makeConfig({
        domain: Domain,
        database: ':memory:',
        site: { publicUrl: Origin },
        space: { enabled: true, ...space },
    });
    const registry = new Registry(':memory:', config.registration);
    const { token } = registry.add('coolbbs', SysopDid, null, { web: 8080, ws: 8810 });
    registry.add('quietbbs', SysopDid, null, { web: 8080, ws: 8810 });
    registry.proxyOpened('coolbbs', 'web', null);
    const profiles = new Profiles(registry.db);
    const presence = new Presence(registry, config, profiles);
    return { config, registry, profiles, presence, token };
}

describe('the live model', () => {
    it('shows people from BBS reports, by what the hub knows of them', () => {
        const { config, registry, profiles, presence } = setup({ vouchedFrom: ['coolbbs'] });
        profiles.signedIn({ did: Alice, handle: 'alice.example' });
        profiles.setPresence(Alice, true);
        presence.answer(Alice, 'coolbbs', 'confirmed');
        presence.report(registry.mustGet('coolbbs'), [
            member(Alice, 'Alice'),
            member(Bob, 'Bob'),
            member(null, 'Dave', 'dave'),
        ]);
        const state = buildState({ config, registry, presence, profiles });
        const people = state.entities.filter(e => 'person' === e.type);
        assert.deepEqual(
            people.map(p => [p.label, p.kind, p.did]),
            [
                ['@alice.example', 'account', Alice],
                ['Bob via coolbbs', 'via', null],
                ['Dave@coolbbs', 'vouched', null],
            ].sort((a, b) => String(people.find(p => p.label === a[0])?.id).localeCompare(String(people.find(p => p.label === b[0])?.id)))
        );
        assert.equal(people.find(p => 'via' === p.kind)?.id.includes(Bob), false, 'an unconfirmed DID is never shown');
        assert.ok(state.presence.every(p => 'leaf:coolbbs' === p.place));
        assert.deepEqual(
            state.entities.filter(e => 'leaf' === e.type).map(e => [e.id, 'leaf' === e.type && e.online]),
            [
                ['leaf:coolbbs', true],
                ['leaf:quietbbs', false],
            ]
        );
    });

    it('leaves out people who turned presence off, and suspended BBSes', () => {
        const { config, registry, profiles, presence } = setup();
        profiles.signedIn({ did: Alice, handle: 'alice.example' });
        presence.answer(Alice, 'coolbbs', 'confirmed');
        presence.report(registry.mustGet('coolbbs'), [member(Alice, 'Alice')]);
        registry.setState('quietbbs', 'suspended');
        const state = buildState({ config, registry, presence, profiles });
        assert.equal(state.entities.filter(e => 'person' === e.type).length, 0);
        assert.equal(state.presence.length, 0);
        assert.deepEqual(state.entities.map(e => e.id), ['leaf:coolbbs']);
    });

    it('shows who is in the room, only with their own setting on', () => {
        const { config, registry, profiles, presence } = setup({ chat: { enabled: true } });
        presence.report(registry.mustGet('coolbbs'), [member(Alice, 'Alice'), member(Bob, 'Bob')]);
        for (const [did, handle, on] of [
            [Alice, 'alice.example', true],
            [Bob, 'bob.example', false],
            [Carol, 'carol.example', true],
        ] as const) {
            profiles.signedIn({ did, handle });
            profiles.setPresence(did, on);
        }
        const chat = {
            present: () => [
                { did: Alice, since: Since },
                { did: Bob, since: Since },
                { did: Carol, since: Since },
            ],
        } as unknown as Chat;
        const state = buildState({ config, registry, presence, profiles, chat });
        assert.ok(state.entities.some(e => 'room:#space' === e.id));
        //  Bob is off; Carol is no member, so not in the space at all
        assert.deepEqual(state.groups, [{ id: 'group:room:#space', place: 'room:#space', members: [`person:${Alice}`] }]);
        assert.ok(state.entities.some(e => e.id === `person:${Alice}` && 'person' === e.type && '@alice.example' === e.label));
        assert.equal(state.entities.some(e => JSON.stringify(e).includes(Bob)), false);
        assert.equal(JSON.stringify(state).includes(Carol), false);
    });

    it("shows a board opened from the hub page, by the person's own word and setting", () => {
        const { config, registry, profiles, presence } = setup();
        presence.report(registry.mustGet('coolbbs'), [member(Alice, 'Alice'), member(Bob, 'Bob')]);
        profiles.signedIn({ did: Alice, handle: 'alice.example' });
        profiles.setPresence(Alice, true);
        presence.answer(Alice, 'coolbbs', 'confirmed');
        profiles.signedIn({ did: Bob, handle: 'bob.example' });
        profiles.signedIn({ did: Carol, handle: 'carol.example' });
        profiles.setPresence(Carol, true);
        const visits = [
            //  Alice: the BBS says so already, so once, from the BBS
            { did: Alice, bbs: 'coolbbs', since: Since },
            //  quietbbs isn't up
            { did: Alice, bbs: 'quietbbs', since: Since },
            //  Bob's own setting is off; Carol is no member
            { did: Bob, bbs: 'coolbbs', since: Since },
            { did: Carol, bbs: 'coolbbs', since: Since },
        ];
        let state = buildState({ config, registry, presence, profiles }, visits);
        assert.deepEqual(
            state.presence.map(p => [p.person, p.place, p.source]).filter(p => !String(p[0]).includes(':via:')),
            [[`person:${Alice}`, 'leaf:coolbbs', 'bbs']]
        );
        assert.equal(JSON.stringify(state).includes(Bob), false);
        assert.equal(JSON.stringify(state).includes(Carol), false);

        profiles.setPresence(Bob, true);
        state = buildState({ config, registry, presence, profiles, webterm: true }, visits);
        const bob = state.presence.find(p => p.person === `person:${Bob}`);
        assert.deepEqual(bob, {
            id: `person:${Bob}@leaf:coolbbs`,
            person: `person:${Bob}`,
            place: 'leaf:coolbbs',
            since: Since,
            source: 'hub',
        });
        assert.ok(state.entities.some(e => e.id === `person:${Bob}` && 'person' === e.type && '@bob.example' === e.label));
        const leaf = state.entities.find(e => 'leaf:coolbbs' === e.id);
        assert.equal(leaf && 'leaf' === leaf.type && leaf.terminal, 'https://coolbbs.hub.test:7443/_enig/ws-term/?connect=1');
    });

    it("shows the space inside a BBS only to members it reported who may join", () => {
        const { registry, profiles, presence } = setup({ vouchedFrom: ['coolbbs'] });
        presence.report(registry.mustGet('coolbbs'), [
            member(Alice, 'Alice'),
            member(Bob, 'Bob'),
            member(Carol, 'Carol'),
            member(null, 'Dave', 'dave'),
        ]);
        profiles.signedIn({ did: Alice, handle: 'alice.example' });
        presence.answer(Alice, 'coolbbs', 'confirmed');
        presence.answer(Carol, 'coolbbs', 'denied');
        const cool = registry.mustGet('coolbbs');
        assert.deepEqual(presence.doorAccess(cool, Alice, null), {
            bbs: 'coolbbs',
            did: Alice,
            kind: 'account',
            label: '@alice.example',
            chat: true,
        });
        //  the BBS's word about Bob: never his DID, and no speaking as him
        assert.deepEqual(presence.doorAccess(cool, Bob, null), {
            bbs: 'coolbbs',
            did: null,
            kind: 'via',
            label: 'Bob via coolbbs',
            chat: false,
        });
        assert.equal(presence.doorAccess(cool, Carol, null), null, 'Carol said it is not her');
        assert.equal(presence.doorAccess(cool, 'did:plc:eeeeeeeeeeeeeeeeeeeeeeee', null), null, 'not reported');
        assert.equal(presence.doorAccess(cool, null, 'dave')?.label, 'Dave@coolbbs');
        assert.equal(presence.doorAccess(registry.mustGet('quietbbs'), Alice, null), null, 'quietbbs is not up');
        registry.proxyClosed('coolbbs', 'web');
        assert.equal(presence.doorAccess(registry.mustGet('coolbbs'), Alice, null), null, 'nor is coolbbs now');
    });

    it('leaves members without AT accounts out, unless the hub takes them from that BBS', () => {
        const { registry, presence } = setup();
        presence.report(registry.mustGet('coolbbs'), [member(null, 'Dave', 'dave')]);
        assert.equal(presence.doorAccess(registry.mustGet('coolbbs'), null, 'dave'), null);
    });

    it('sends only what changed', () => {
        const empty: LiveState = { entities: [], presence: [], groups: [], links: [] };
        const one: LiveState = {
            ...empty,
            entities: [{ id: 'room:#space', type: 'room', name: '#space' }],
        };
        assert.equal(diffState(empty, empty), null);
        assert.deepEqual(diffState(empty, one), { put: { entities: one.entities }, remove: {} });
        assert.deepEqual(diffState(one, empty), { put: {}, remove: { entities: ['room:#space'] } });
        assert.equal(diffState(one, structuredClone(one)), null);
    });
});

//  A WebSocket client, as plain as the protocol allows
class Client {
    socket: Socket;
    status = '';
    messages: unknown[] = [];
    closeCode: number | null = null;
    pongs = 0;
    closed = false;
    buffer = Buffer.alloc(0);
    upgraded = false;
    ready: Promise<string>;

    constructor(
        port: number,
        options: { session?: string; origin?: string | null; key?: string; path?: string; auth?: string } = {}
    ) {
        this.socket = connect(port, '127.0.0.1');
        this.socket.on('error', () => {});
        this.ready = new Promise(resolve => {
            this.socket.on('close', () => {
                this.closed = true;
                resolve(this.status || 'closed');
            });
            this.socket.on('data', (d: Buffer) => {
                this.buffer = Buffer.concat([this.buffer, d]);
                if (!this.upgraded) {
                    const end = this.buffer.indexOf('\r\n\r\n');
                    if (end < 0) {
                        return;
                    }
                    this.status = this.buffer.subarray(0, end).toString().split('\r\n')[0] ?? '';
                    this.buffer = this.buffer.subarray(end + 4);
                    this.upgraded = true;
                    resolve(this.status);
                }
                this.read();
            });
        });
        this.socket.once('connect', () =>
            this.socket.write(
                `GET ${options.path ?? '/space/live'} HTTP/1.1\r\nHost: ${Domain}\r\nConnection: Upgrade\r\n` +
                    `Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n` +
                    `Sec-WebSocket-Key: ${options.key ?? randomBytes(16).toString('base64')}\r\n` +
                    `${null === options.origin ? '' : `Origin: ${options.origin ?? Origin}\r\n`}` +
                    `${options.auth ? `Authorization: Bearer ${options.auth}\r\n` : ''}` +
                    `${options.session ? `Cookie: hub_session=${options.session}\r\n` : ''}\r\n`
            )
        );
    }

    read(): void {
        while (this.buffer.length >= 2) {
            let len = (this.buffer[1] as number) & 0x7f;
            let at = 2;
            if (126 === len) {
                len = this.buffer.readUInt16BE(2);
                at = 4;
            } else if (127 === len) {
                len = Number(this.buffer.readBigUInt64BE(2));
                at = 10;
            }
            if (this.buffer.length < at + len) {
                return;
            }
            const op = (this.buffer[0] as number) & 0x0f;
            const payload = this.buffer.subarray(at, at + len);
            this.buffer = this.buffer.subarray(at + len);
            if (1 === op) {
                this.messages.push(JSON.parse(payload.toString()));
            } else if (8 === op) {
                this.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : null;
            } else if (10 === op) {
                this.pongs++;
            }
        }
    }

    send(opcode: number, payload: Buffer, masked = true): void {
        const mask = randomBytes(4);
        const body = masked ? Buffer.from(payload.map((b, i) => b ^ (mask[i % 4] as number))) : payload;
        const len = payload.length;
        const head =
            len < 126
                ? Buffer.from([0x80 | opcode, (masked ? 0x80 : 0) | len])
                : Buffer.from([0x80 | opcode, (masked ? 0x80 : 0) | 126, len >> 8, len & 255]);
        this.socket.write(Buffer.concat([head, masked ? mask : Buffer.alloc(0), body]));
    }
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(check: () => boolean, what: string, ms = 4000): Promise<void> {
    for (let i = 0; i < ms / 20; i++) {
        if (check()) {
            return;
        }
        await wait(20);
    }
    assert.fail(`timed out: ${what}`);
}

class Sessions implements SignInLike {
    all = new Map<string, WebSession>([
        ['alice-session', { did: Alice, handle: 'alice.example', expiresAt: Expires }],
        ['bob-session', { did: Bob, handle: 'bob.example', expiresAt: Expires }],
        ['carol-session', { did: Carol, handle: 'carol.example', expiresAt: Expires }],
    ]);
    async start(): Promise<string> {
        return '';
    }
    async finish(): Promise<never> {
        throw new Error('not used');
    }
    createSession(): string {
        return '';
    }
    session(token: string | undefined) {
        return (token && this.all.get(token)) || null;
    }
    endSession(token: string | undefined): void {
        this.all.delete(token ?? '');
    }
}

describe('the live model on the site', () => {
    let site: Server;
    let port: number;
    let registry: Registry;
    let config: HubConfig;
    let bbsToken: string;
    let profiles: Profiles;
    const clients: Client[] = [];

    function report(members: ReportedMember[]): Promise<number> {
        const body = JSON.stringify({ bbs: 'coolbbs', members });
        return new Promise((resolve, reject) => {
            const req = request(
                {
                    host: '127.0.0.1',
                    port,
                    method: 'POST',
                    path: '/api/bbs/presence',
                    agent: false,
                    headers: { Host: Domain, Authorization: `Bearer ${bbsToken}`, 'Content-Type': 'application/json' },
                },
                res => {
                    res.resume();
                    res.on('end', () => resolve(res.statusCode ?? 0));
                }
            );
            req.on('error', reject);
            req.end(body);
        });
    }

    function get(path: string, session?: string): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
        return new Promise((resolve, reject) => {
            const req = request(
                {
                    host: '127.0.0.1',
                    port,
                    path,
                    agent: false,
                    headers: { Host: Domain, ...(session ? { Cookie: `hub_session=${session}` } : {}) },
                },
                res => {
                    let body = '';
                    res.on('data', d => (body += d));
                    res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
                }
            );
            req.on('error', reject);
            req.end();
        });
    }

    function at(c: Client, place: unknown, type = 'nexus.cyberspace.dev.space.at'): void {
        c.send(1, Buffer.from(JSON.stringify({ $type: type, place })));
    }

    function open(options: ConstructorParameters<typeof Client>[1] = {}): Client {
        const c = new Client(port, options);
        clients.push(c);
        return c;
    }

    beforeEach(async () => {
        const s = setup({ live: { enabled: true, maxConnections: 2 } });
        ({ registry, config, profiles } = s);
        bbsToken = s.token;
        profiles.signedIn({ did: Alice, handle: 'alice.example' });
        profiles.setPresence(Alice, true);
        s.presence.answer(Alice, 'coolbbs', 'confirmed');
        s.presence.report(registry.mustGet('coolbbs'), [member(Alice, 'Alice'), member(Bob, 'Bob')]);
        site = createSite({ config, registry, signin: new Sessions() });
        await new Promise<void>(r => site.listen(0, '127.0.0.1', () => r()));
        port = (site.address() as AddressInfo).port;
    });

    afterEach(async () => {
        clients.splice(0).forEach(c => c.socket.destroy());
        site.closeAllConnections();
        await new Promise(r => site.close(r));
        registry.close();
    });

    it('is off unless turned on', () => {
        assert.equal(makeConfig().space.live.enabled, false);
        assert.throws(() => makeConfig({ space: { live: { enabled: true } } }), /needs space\.enabled/);
        assert.throws(() => makeConfig({ space: { enabled: true, live: { maxConnections: 0 } } }), /space\.live/);
    });

    it('sends the whole state on connecting, and who you are', async () => {
        const c = open({ session: 'alice-session' });
        assert.match(await c.ready, / 101 /);
        await until(() => c.messages.length > 0, 'the snapshot');
        const snap = c.messages[0] as Record<string, unknown> & LiveState;
        assert.equal(snap.$type, 'nexus.cyberspace.dev.space.snapshot');
        assert.equal(snap.version, 1);
        assert.equal(snap.you, `person:${Alice}`);
        assert.deepEqual(
            snap.entities.map(e => e.id),
            ['leaf:coolbbs', 'leaf:quietbbs', `person:${Alice}`, snap.entities[3]?.id]
        );
        assert.ok(snap.entities.some(e => 'person' === e.type && 'Bob via coolbbs' === e.label));
    });

    it('sends changes as they happen', async () => {
        const c = open({ session: 'bob-session' });
        await until(() => c.messages.length > 0, 'the snapshot');
        assert.equal((c.messages[0] as { you: unknown }).you, `person:${Bob}`);
        assert.equal((c.messages[0] as LiveState).entities.some(e => e.id === `person:${Bob}`), false);
        assert.equal(await report([member(Alice, 'Alice'), member(Bob, 'Bob'), member(Carol, 'Carol')]), 200);
        await until(() => c.messages.length > 1, 'a change');
        const change = c.messages[1] as { $type: string; seq: number; put: LiveState; remove: Record<string, string[]> };
        assert.equal(change.$type, 'nexus.cyberspace.dev.space.change');
        assert.ok(change.seq > (c.messages[0] as { seq: number }).seq);
        assert.ok(change.put.entities.some(e => 'person' === e.type && 'Carol via coolbbs' === e.label));
        assert.equal(change.put.presence.length, 1);

        profiles.setPresence(Alice, false);
        assert.equal(await report([member(Alice, 'Alice'), member(Bob, 'Bob'), member(Carol, 'Carol')]), 200);
        await until(() => c.messages.length > 2, 'Alice leaving');
        const gone = c.messages[2] as { remove: Record<string, string[]> };
        assert.deepEqual(gone.remove.entities, [`person:${Alice}`]);
    });

    it('closes the stream when access ends', async () => {
        const c = open({ session: 'bob-session' });
        await until(() => c.messages.length > 0, 'the snapshot');
        assert.equal(await report([member(Alice, 'Alice')]), 200);
        await until(() => c.closed, 'the stream to close');
        assert.equal(c.closeCode, AccessEnded);
    });

    it('lets in only those allowed, from the hub\'s own pages', async () => {
        for (const [options, expected] of [
            [{}, / 401 /],
            [{ session: 'carol-session' }, / 403 /],
            [{ session: 'alice-session', origin: 'https://evil.example' }, / 403 /],
            [{ session: 'alice-session', key: 'nope' }, / 400 /],
            [{ session: 'alice-session', path: '/space/livex' }, / 404 /],
        ] as const) {
            assert.match(await open(options).ready, expected, JSON.stringify(options));
        }
    });

    it('limits how many streams one person has', async () => {
        assert.match(await open({ session: 'alice-session' }).ready, / 101 /);
        assert.match(await open({ session: 'alice-session' }).ready, / 101 /);
        assert.match(await open({ session: 'alice-session' }).ready, / 429 /);
    });

    it('lets go of a viewer who leaves without saying so', async () => {
        const c = open({ session: 'alice-session' });
        await until(() => c.messages.length > 0, 'the snapshot');
        c.socket.end();
        await until(() => c.closed, 'the hub to close its side too');
    });

    it('shows someone at a board they opened from the hub page, while they keep it open', async () => {
        profiles.signedIn({ did: Bob, handle: 'bob.example' });
        profiles.setPresence(Bob, true);
        const viewer = open({ session: 'alice-session' });
        await until(() => viewer.messages.length > 0, 'the snapshot');
        const bob = open({ session: 'bob-session' });
        await until(() => bob.messages.length > 0, "Bob's snapshot");
        const seen = () =>
            viewer.messages.flatMap(m => ((m as { put?: LiveState }).put?.presence ?? []).map(p => p.id));
        //  what isn't an open board is ignored
        at(bob, 'leaf:quietbbs');
        at(bob, 'leaf:Not A Name');
        at(bob, 'room:#space');
        at(bob, 'leaf:coolbbs', 'something.else');
        bob.send(1, Buffer.from('not json'));
        await wait(300);
        assert.deepEqual(seen(), []);
        assert.equal(bob.closed, false);

        at(bob, 'leaf:coolbbs');
        await until(() => seen().includes(`person:${Bob}@leaf:coolbbs`), 'Bob at coolbbs');
        const put = viewer.messages.at(-1) as { put: LiveState };
        assert.equal(put.put.presence[0]?.source, 'hub');

        at(bob, null);
        await until(
            () => viewer.messages.some(m => (m as { remove?: Record<string, string[]> }).remove?.presence?.includes(`person:${Bob}@leaf:coolbbs`)),
            'Bob gone when the board closes'
        );
        const count = viewer.messages.length;
        at(bob, 'leaf:coolbbs');
        await until(() => viewer.messages.length > count, 'Bob back');
        bob.socket.destroy();
        await until(
            () => viewer.messages.slice(count + 1).some(m => (m as { remove?: Record<string, string[]> }).remove?.presence?.includes(`person:${Bob}@leaf:coolbbs`)),
            'Bob gone when the map closes'
        );
    });

    it('ignores someone who says too much', async () => {
        profiles.signedIn({ did: Bob, handle: 'bob.example' });
        profiles.setPresence(Bob, true);
        const bob = open({ session: 'bob-session' });
        await until(() => bob.messages.length > 0, 'the snapshot');
        for (let i = 0; i < 20; i++) {
            at(bob, null);
        }
        at(bob, 'leaf:coolbbs');
        await wait(400);
        assert.equal(bob.messages.length, 1, 'nothing changed');
        assert.equal(bob.closed, false);
    });

    it('serves the map to those allowed in, able to reach only the stream', async () => {
        const map = await get('/space', 'alice-session');
        assert.equal(map.status, 200);
        assert.match(map.body, /<script src="\/space\/map\.js" defer>/);
        assert.match(String(map.headers['content-security-policy']), /script-src 'self'; connect-src 'self' wss:\/\/hub\.test;/);
        //  the plain list is there for when the script can't run
        assert.match(map.body, /Bob via coolbbs/);
        const script = await get('/space/map.js');
        assert.equal(script.status, 200);
        assert.match(String(script.headers['content-type']), /javascript/);
        assert.match(script.body, /\.at'/);
        const outsider = await get('/space', 'carol-session');
        assert.doesNotMatch(outsider.body, /map\.js/);
        assert.doesNotMatch(String(outsider.headers['content-security-policy']), /connect-src/);
    });

    //  a BBS's door, for one of its members
    function door(query: string, options: { token?: string; origin?: string | null } = {}): Client {
        return open({
            path: `/api/bbs/live?${query}`,
            origin: options.origin === undefined ? null : options.origin,
            auth: options.token ?? bbsToken,
        });
    }

    it("streams the space to a BBS's door, as the member it is for", async () => {
        const c = door(`bbs=coolbbs&did=${encodeURIComponent(Bob)}`);
        assert.match(await c.ready, / 101 /);
        await until(() => c.messages.length > 0, 'the snapshot');
        const snap = c.messages[0] as { you: string } & LiveState;
        //  Bob hasn't confirmed coolbbs: he is who coolbbs says, not his DID
        assert.equal(snap.you, personId({ kind: 'via', did: null, bbs: 'coolbbs', label: 'Bob via coolbbs' }));
        assert.ok(snap.entities.some(e => e.id === snap.you));
        assert.equal(JSON.stringify(snap).includes(Bob), false);
        //  a door can't say it has opened a board
        at(c, 'leaf:coolbbs');
        await wait(300);
        assert.equal(c.messages.length, 1);

        const alice = door(`bbs=coolbbs&did=${encodeURIComponent(Alice)}`);
        await until(() => alice.messages.length > 0, "Alice's snapshot");
        assert.equal((alice.messages[0] as { you: string }).you, `person:${Alice}`);
    });

    it('refuses doors that should not get through', async () => {
        const bob = `bbs=coolbbs&did=${encodeURIComponent(Bob)}`;
        for (const [query, options, expected] of [
            [bob, { token: 'wrong' }, / 401 /],
            [bob, { origin: Origin }, / 403 /],
            [`bbs=coolbbs&did=${encodeURIComponent(Carol)}`, {}, / 403 /],
            ['bbs=coolbbs', {}, / 400 /],
            [`${bob}&user=bob`, {}, / 400 /],
            [`bbs=quietbbs&did=${encodeURIComponent(Bob)}`, {}, / 401 /],
        ] as const) {
            assert.match(await door(query, options).ready, expected, query);
        }
    });

    it('closes a door when the BBS stops reporting the member', async () => {
        const c = door(`bbs=coolbbs&did=${encodeURIComponent(Bob)}`);
        await until(() => c.messages.length > 0, 'the snapshot');
        assert.equal(await report([member(Alice, 'Alice')]), 200);
        await until(() => c.closed, 'the door to close');
        assert.equal(c.closeCode, AccessEnded);
    });

    it('answers pings, and closes on what a client may not send', async () => {
        const c = open({ session: 'alice-session' });
        await c.ready;
        c.send(9, Buffer.from('hi'));
        await until(() => c.pongs > 0, 'a pong');
        c.send(1, Buffer.from('ignored'));
        await wait(50);
        assert.equal(c.closed, false);
        c.send(1, Buffer.from('x'), false);
        await until(() => c.closed, 'the close');
        assert.equal(c.closeCode, 1002);
        const big = open({ session: 'alice-session' });
        await big.ready;
        big.send(1, Buffer.alloc(MaxClientFrame + 1));
        await until(() => big.closed, 'the close');
        assert.equal(big.closeCode, 1009);
    });
});
