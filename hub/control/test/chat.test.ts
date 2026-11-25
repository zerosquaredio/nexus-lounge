import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttp, request, type Server } from 'node:http';
import { createServer as createTcp, connect, type AddressInfo, type Server as TcpServer, type Socket } from 'node:net';
import { Chat, chatHandle, chatNick, ClientFrames, MinChatSecret, parseIrc, signBroker } from '../src/chat.ts';
import { Moderation } from '../src/moderation.ts';
import { chatPane, ChatScript, ChatScriptPath } from '../src/chat_page.ts';
import { WhoScript, WhoScriptPath } from '../src/moderation_page.ts';
import { makeConfig, type HubConfig } from '../src/config.ts';
import { chatCommand } from '../src/generate.ts';
import { Presence } from '../src/presence.ts';
import { Profiles } from '../src/profiles.ts';
import { Registry } from '../src/registry.ts';
import type { WebSession } from '../src/signin.ts';
import { createSite, type SignInLike } from '../src/site.ts';
import { SysopDid, OtherSysopDid } from './helpers.ts';

const Secret = 's'.repeat(MinChatSecret);
const Key = 'dGhlIHNhbXBsZSBub25jZQ==';
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(check: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
        if (check()) {
            return;
        }
        await wait(10);
    }
    assert.fail(`timed out: ${what}`);
}
//  A WebSocket frame as a client sends it: masked, here with a key of zeros
//  so what freeq echoes back can be read
function frame(text: string, o: { fin?: boolean; opcode?: number; masked?: boolean; rsv?: number } = {}): Buffer {
    const payload = Buffer.from(text);
    const b0 = (false === o.fin ? 0 : 0x80) | (o.rsv ?? 0) | (o.opcode ?? 1);
    const m = false === o.masked ? 0 : 0x80;
    const head =
        payload.length < 126
            ? Buffer.from([b0, m | payload.length])
            : Buffer.from([b0, m | 126, payload.length >> 8, payload.length & 255]);
    return Buffer.concat([head, false === o.masked ? Buffer.alloc(0) : Buffer.alloc(4), payload]);
}

function answer(did: string): string {
    return Buffer.from(JSON.stringify({ did, method: 'web-token', signature: 'token-1' })).toString('base64url');
}

const listening = (s: Server | TcpServer) =>
    new Promise<number>(resolve => s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)));

//  freeq, as far as the hub can tell: the token route, its IRC port, and its
//  WebSocket route, which here just says what it was sent
class FakeFreeq {
    web = createHttp();
    irc: TcpServer;
    tokens: { did: string; handle: string }[] = [];
    upgrades: Record<string, string | string[] | undefined>[] = [];
    upstream = new Set<Socket>();
    received = '';
    botLines: string[] = [];
    botSockets = new Set<Socket>();
    //  whether the bot is given the room as its operator
    op = true;
    webPort = 0;
    ircPort = 0;

    constructor() {
        this.web.on('request', (req, res) => {
            let body = '';
            req.on('data', d => (body += d));
            req.on('end', () => {
                const ts = String(req.headers['x-broker-timestamp']);
                if (req.headers['x-broker-signature'] !== signBroker(Secret, ts, body)) {
                    res.writeHead(401).end();
                    return;
                }
                this.tokens.push(JSON.parse(body));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ token: `token-${this.tokens.length}` }));
            });
        });
        this.web.on('upgrade', (req, socket, head) => {
            this.upgrades.push(req.headers);
            this.upstream.add(socket as Socket);
            socket.on('error', () => {});
            socket.on('end', () => socket.destroy());
            socket.on('close', () => this.upstream.delete(socket as Socket));
            socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
            this.received += head.toString();
            socket.on('data', d => {
                this.received += d;
                socket.write(`echo:${d}`);
            });
        });
        this.irc = createTcp(s => this.bot(s));
    }

    bot(socket: Socket): void {
        this.botSockets.add(socket);
        socket.on('error', () => {});
        socket.on('close', () => this.botSockets.delete(socket));
        socket.setEncoding('utf8');
        let buffer = '';
        socket.on('data', (chunk: string) => {
            buffer += chunk;
            const lines = buffer.split('\r\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                this.botLines.push(line);
                const reply = (l: string) => socket.write(`${l}\r\n`);
                if (line.startsWith('CAP REQ')) {
                    reply(':x CAP * ACK :sasl');
                } else if ('AUTHENTICATE ATPROTO-CHALLENGE' === line) {
                    reply('AUTHENTICATE challenge');
                } else if (line.startsWith('AUTHENTICATE ')) {
                    reply(':x 903 hub :ok');
                } else if ('CAP END' === line) {
                    reply(':x 001 hub :welcome');
                } else if (line.startsWith('JOIN ')) {
                    reply(`:x 353 hub = #space :${this.op ? '@hub' : 'hub @someone'}`);
                    reply(':x 366 hub #space :end');
                }
            }
        });
    }

    async start(): Promise<void> {
        this.webPort = await listening(this.web);
        this.ircPort = await listening(this.irc);
    }

    dropBot(): void {
        this.botSockets.forEach(s => s.destroy());
    }

    async stop(): Promise<void> {
        this.upstream.forEach(s => s.destroy());
        this.dropBot();
        this.web.closeAllConnections();
        await Promise.all([this.web, this.irc].map(s => new Promise(r => s.close(r))));
    }
}

const Domain = 'hub.test';
const Origin = 'https://hub.test';
const Member = SysopDid;
const Stranger = OtherSysopDid;
const Expires = Date.UTC(2099, 0, 1);

class Sessions implements SignInLike {
    async start(): Promise<string> {
        return '';
    }
    async finish(): Promise<never> {
        throw new Error('not used');
    }
    createSession(): string {
        return '';
    }
    all = new Map<string, WebSession>([
        ['member-session', { did: Member, handle: 'alice.bsky.social', expiresAt: Expires }],
        ['stranger-session', { did: Stranger, handle: 'mallory.example', expiresAt: Expires }],
    ]);
    session(token: string | undefined) {
        return (token && this.all.get(token)) || null;
    }
    endSession(token: string | undefined): void {
        this.all.delete(token ?? '');
    }
}

describe('chat names', () => {
    it('gives freeq a handle only the hub can name, the same each time', () => {
        const handle = chatHandle(Member, Domain);
        assert.match(handle, /^[0-9a-f]{16}\.chat\.hub\.test$/);
        assert.equal(handle, chatHandle(Member, Domain));
        assert.notEqual(handle, chatHandle(Stranger, Domain));
    });

    it('makes usable nicks, different for look-alike handles', () => {
        assert.match(chatNick('alice.bsky.social', Member), /^alice-[0-9a-f]{4}$/);
        assert.match(chatNick('Al.Ice@x', Member), /^al-ice-x-[0-9a-f]{4}$/);
        assert.match(chatNick(null, Member), /^user-[0-9a-f]{4}$/);
        assert.match(chatNick('...', Member), /^user-[0-9a-f]{4}$/);
        assert.ok(chatNick(`${'a'.repeat(80)}.example`, Member).length <= 29);
        assert.notEqual(chatNick('a.b-c', Member), chatNick('a-b.c', Stranger));
    });

    it('reads IRC lines', () => {
        assert.deepEqual(parseIrc(':s 353 me = #space :@hub alice'), {
            tags: {},
            prefix: 's',
            command: '353',
            params: ['me', '=', '#space', '@hub alice'],
        });
        assert.deepEqual(parseIrc('PING :abc').params, ['abc']);
        assert.equal(parseIrc('AUTHENTICATE xyz').command, 'AUTHENTICATE');
        const tagged = parseIrc('@account=did:plc:x;time=2026-11-19T10:00:00.000Z;x=a\\sb :n!u@h PRIVMSG #space :hi there');
        assert.deepEqual(tagged.tags, { account: 'did:plc:x', time: '2026-11-19T10:00:00.000Z', x: 'a b' });
        assert.equal(tagged.command, 'PRIVMSG');
        assert.deepEqual(tagged.params, ['#space', 'hi there']);
    });
});

describe('what a chat client sends', () => {
    const lines = (...l: string[]) => frame(l.map(x => `${x}\r\n`).join(''));

    it('passes it on, signing in as the person it was let in for', () => {
        const f = new ClientFrames(Member);
        const sent = Buffer.concat([lines('CAP LS 302', 'NICK alice'), lines('AUTHENTICATE ATPROTO-CHALLENGE'), lines(`AUTHENTICATE ${answer(Member)}`)]);
        assert.deepEqual(f.push(sent), sent);
        assert.ok(f.push(lines('PRIVMSG #space :AUTHENTICATE me, please'))?.length);
    });

    it('waits for whole frames, however they arrive', () => {
        const f = new ClientFrames(Member);
        const sent = lines('NICK alice');
        assert.equal(f.push(sent.subarray(0, 1))?.length, 0);
        assert.equal(f.push(sent.subarray(1, 5))?.length, 0);
        assert.deepEqual(f.push(sent.subarray(5)), sent);
    });

    it('refuses a sign-in as anyone else, however it is put', () => {
        const signIn = (f: ClientFrames, ...l: string[]) => f.push(lines('AUTHENTICATE ATPROTO-CHALLENGE', ...l));
        assert.equal(signIn(new ClientFrames(Member), `AUTHENTICATE ${answer(Stranger)}`), null);
        assert.equal(signIn(new ClientFrames(Member), `@x=y AUTHENTICATE :${answer(Stranger)}`), null);
        assert.equal(signIn(new ClientFrames(Member), `authenticate ${answer(Stranger)}`), null);
        assert.equal(signIn(new ClientFrames(Member), 'AUTHENTICATE not-json'), null);
        //  an answer in 400-byte chunks is read whole, as freeq does
        const long = Buffer.from(JSON.stringify({ did: Stranger, method: 'web-token', signature: 'x'.repeat(400) })).toString('base64url');
        const chunks = long.match(/.{1,400}/g) ?? [];
        assert.ok(chunks.length > 1);
        assert.equal(signIn(new ClientFrames(Member), ...chunks.map(c => `AUTHENTICATE ${c}`)), null);
        const mine = Buffer.from(JSON.stringify({ did: Member, method: 'web-token', signature: 'x'.repeat(400) })).toString('base64url');
        assert.ok(signIn(new ClientFrames(Member), ...(mine.match(/.{1,400}/g) ?? []).map(c => `AUTHENTICATE ${c}`)));
        //  nothing before the challenge, and nothing freeq may split otherwise
        assert.equal(new ClientFrames(Member).push(lines(`AUTHENTICATE ${answer(Member)}`)), null);
        assert.equal(new ClientFrames(Member).push(frame(`NICK a\rAUTHENTICATE ${answer(Stranger)}\r\n`)), null);
    });

    it('refuses frames it could not read as freeq does', () => {
        for (const bad of [
            frame('NICK a\r\n', { masked: false }),
            frame('NICK a\r\n', { fin: false }),
            frame('NICK a\r\n', { opcode: 0 }),
            frame('NICK a\r\n', { rsv: 0x40 }),
            frame('NICK a\r\n', { opcode: 3 }),
            Buffer.from([0x81, 0xff, 0, 0, 0, 1, 0, 0, 0, 0]),
        ]) {
            assert.equal(new ClientFrames(Member).push(bad), null, bad.toString('hex').slice(0, 8));
        }
        assert.ok(new ClientFrames(Member).push(frame('', { opcode: 9 })));
    });
});

describe('chat config', () => {
    it('is off by default, and needs the common space', () => {
        assert.equal(makeConfig().space.chat.enabled, false);
        assert.throws(() => makeConfig({ space: { chat: { enabled: true } } }), /needs space\.enabled/);
    });

    it('keeps its defaults when only some settings are given', () => {
        const chat = makeConfig({ space: { enabled: true, chat: { enabled: true, room: '#lounge' } } }).space.chat;
        assert.equal(chat.room, '#lounge');
        assert.equal(chat.ircPort, 16667);
    });

    it('refuses bad settings', () => {
        for (const chat of [
            { room: 'space' },
            { room: '#Has Space' },
            { ircPort: 0 },
            { ircPort: 5, webPort: 5 },
            { dataDir: 'a b;rm' },
            { maxConnections: 0 },
            { checkSeconds: 0 },
        ]) {
            assert.throws(() => makeConfig({ space: { chat } }), /space\.chat/, JSON.stringify(chat));
        }
    });

    it('starts freeq private, with no database or guests, for the hub\'s identities only', () => {
        const text = chatCommand(makeConfig({ domain: Domain }), '/opt/freeq-server');
        assert.match(text, /^BROKER_SHARED_SECRET="\$HUB_CHAT_SECRET" \/opt\/freeq-server /);
        assert.match(text, /--listen-addr 127\.0\.0\.1:16667 --web-addr 127\.0\.0\.1:18080/);
        assert.match(text, /--no-guest --allowed-did-domains chat\.hub\.test$/);
        assert.doesNotMatch(text, /--db-path/);
    });

    it('needs a real secret', () => {
        assert.throws(() => new Chat(makeConfig(), 'short'), /HUB_CHAT_SECRET/);
    });

    it("knows when someone in the room last did something there (H19)", () => {
        const chat = new Chat(makeConfig(), Secret);
        const link = (did: string, since: string) =>
            ({ person: { did }, since }) as unknown as Parameters<typeof chat.links.add>[0];
        assert.equal(chat.activeAt(SysopDid), null);
        chat.links.add(link(SysopDid, '2026-01-01T10:00:00.000Z'));
        chat.links.add(link(SysopDid, '2026-01-01T10:05:00.000Z'));
        //  connecting counts: the latest connection still open
        assert.equal(chat.activeAt(SysopDid), Date.parse('2026-01-01T10:05:00.000Z'));
        //  and so does speaking
        chat.heard({ did: SysopDid, nick: 'a', text: 'hi', time: '2026-01-01T10:20:00.000Z' });
        chat.heard({ did: OtherSysopDid, nick: 'b', text: 'hi', time: '2026-01-01T10:30:00.000Z' });
        assert.equal(chat.activeAt(SysopDid), Date.parse('2026-01-01T10:20:00.000Z'));
        //  someone not connected isn't active, whatever they said before
        assert.equal(chat.activeAt(OtherSysopDid), null);
        chat.links.clear();
        assert.equal(chat.activeAt(SysopDid), null);
    });
});

describe('chat through the hub', () => {
    let freeq: FakeFreeq;
    let config: HubConfig;
    let registry: Registry;
    let chat: Chat;
    let site: Server;
    let port: number;
    let sessions: Sessions;
    let presence: Presence;
    let bbsToken: string;
    const sockets = new Set<Socket>();
    const logs: string[] = [];

    function report(members: { did: string }[]): void {
        presence.report(
            registry.mustGet('coolbbs'),
            members.map(m => ({ did: m.did, name: 'someone', memberSince: '2026-01-01T00:00:00.000Z', online: true }))
        );
    }

    beforeEach(async () => {
        freeq = new FakeFreeq();
        await freeq.start();
        config = makeConfig({
            domain: Domain,
            database: ':memory:',
            site: { publicUrl: Origin },
            space: { enabled: true, chat: { enabled: true, ircPort: freeq.ircPort, webPort: freeq.webPort, maxConnections: 2 } },
        });
        registry = new Registry(':memory:', config.registration);
        bbsToken = registry.add('coolbbs', SysopDid, null, { web: 8080, ws: 8810 }).token;
        presence = new Presence(registry, config, new Profiles(registry.db));
        report([{ did: Member }]);
        sessions = new Sessions();
        logs.length = 0;
        chat = new Chat(config, Secret, line => logs.push(line));
        site = createSite({ config, registry, signin: sessions, chat, log: line => logs.push(line) });
        port = await listening(site);
        chat.start();
        await until(() => chat.ready, 'the hub to hold the room');
    });

    afterEach(async () => {
        chat.stop();
        sockets.forEach(s => s.destroy());
        sockets.clear();
        site.closeAllConnections();
        await new Promise(r => site.close(r));
        await freeq.stop();
        registry.close();
    });

    function post(path: string, cookie?: string, origin: string = Origin) {
        return new Promise<{ status: number; body: Record<string, string> }>((resolve, reject) => {
            const req = request(
                {
                    host: '127.0.0.1',
                    port,
                    method: 'POST',
                    path,
                    agent: false,
                    headers: { Host: Domain, Origin: origin, ...(cookie ? { Cookie: `hub_session=${cookie}` } : {}) },
                },
                res => {
                    let text = '';
                    res.on('data', d => (text += d));
                    res.on('end', () => {
                        let body = {};
                        try {
                            body = JSON.parse(text);
                        } catch {}
                        resolve({ status: res.statusCode ?? 0, body });
                    });
                }
            );
            req.on('error', reject);
            req.end();
        });
    }

    function get(path: string, cookie?: string) {
        return new Promise<{ status: number; headers: Record<string, unknown>; text: string }>((resolve, reject) => {
            const req = request(
                {
                    host: '127.0.0.1',
                    port,
                    path,
                    agent: false,
                    headers: { Host: Domain, ...(cookie ? { Cookie: `hub_session=${cookie}` } : {}) },
                },
                res => {
                    let text = '';
                    res.on('data', d => (text += d));
                    res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
                }
            );
            req.on('error', reject);
            req.end();
        });
    }

    //  opens the chat connection; resolves with the status line and socket
    //  as a BBS's door would: its token, no web page behind it
    function asBbs(method: string, path: string, token: string = bbsToken, origin?: string) {
        return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
            const req = request(
                {
                    host: '127.0.0.1',
                    port,
                    method,
                    path,
                    agent: false,
                    headers: { Host: Domain, Authorization: `Bearer ${token}`, ...(origin ? { Origin: origin } : {}) },
                },
                res => {
                    let text = '';
                    res.on('data', d => (text += d));
                    res.on('end', () => {
                        let body = {};
                        try {
                            body = JSON.parse(text);
                        } catch {}
                        resolve({ status: res.statusCode ?? 0, body });
                    });
                }
            );
            req.on('error', reject);
            req.end();
        });
    }

    function open(
        session?: string,
        options: { origin?: string | null; path?: string; host?: string; key?: string; auth?: string } = {}
    ) {
        return new Promise<{ status: string; socket: Socket; text: () => string }>(resolve => {
            const socket = connect(port, '127.0.0.1');
            sockets.add(socket);
            let text = '';
            let done = false;
            socket.setEncoding('utf8');
            socket.on('error', () => {});
            const finish = () => {
                if (!done) {
                    done = true;
                    resolve({ status: text.split('\r\n')[0] ?? '', socket, text: () => text });
                }
            };
            socket.on('data', (d: string) => {
                text += d;
                if (text.includes('\r\n\r\n')) {
                    finish();
                }
            });
            socket.on('close', finish);
            socket.once('connect', () =>
                socket.write(
                    `GET ${options.path ?? '/chat/irc'} HTTP/1.1\r\nHost: ${options.host ?? Domain}\r\n` +
                        `Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n` +
                        `Sec-WebSocket-Key: ${options.key ?? Key}\r\n` +
                        `${null === options.origin ? '' : `Origin: ${options.origin ?? Origin}\r\n`}` +
                        `${options.auth ? `Authorization: Bearer ${options.auth}\r\n` : ''}` +
                        `${session ? `Cookie: hub_session=${session}; other=1\r\n` : ''}X-Forwarded-For: 203.0.113.9\r\n\r\n`
                )
            );
        });
    }

    it('shows the chat page to someone allowed in, with only its own script', async () => {
        const reply = await get('/space/chat', 'member-session');
        assert.equal(reply.status, 200);
        assert.match(reply.text, /id="chat-log"/);
        assert.match(reply.text, /<script src="\/space\/chat\.js" defer><\/script>/);
        assert.doesNotMatch(reply.text, /<script>/);
        const policy = String(reply.headers['content-security-policy']);
        assert.match(policy, /script-src 'self';/);
        assert.match(policy, /connect-src 'self' wss:\/\/hub\.test;/);
        assert.doesNotMatch(policy, /script-src[^;]*unsafe/);
    });

    it('keeps the chat page from others', async () => {
        assert.equal((await get('/space/chat')).status, 303);
        const stranger = await get('/space/chat', 'stranger-session');
        assert.doesNotMatch(stranger.text, /chat-log/);
        assert.match(stranger.text, /for members of its BBSes/);
    });

    it('links to the chat from who is around', async () => {
        assert.match((await get('/space', 'member-session')).text, /href="\/space\/chat"/);
    });

    it('serves a script that parses, as a script', async () => {
        const reply = await get(ChatScriptPath);
        assert.equal(reply.status, 200);
        assert.match(String(reply.headers['content-type']), /^text\/javascript/);
        assert.equal(reply.text, ChatScript);
        assert.doesNotThrow(() => new Function(reply.text));
    });

    it('never puts text from others into the page as HTML', () => {
        for (const script of [ChatScript, WhoScript]) {
            assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
        }
    });

    it('serves muting and reporting, as a script, with the chat page', async () => {
        const reply = await get(WhoScriptPath);
        assert.equal(reply.status, 200);
        assert.match(String(reply.headers['content-type']), /^text\/javascript/);
        assert.doesNotThrow(() => new Function(reply.text));
        const page = (await get('/space/chat', 'member-session')).text;
        assert.ok(page.indexOf(WhoScriptPath) < page.indexOf(ChatScriptPath), 'loaded first');
    });

    it('names people by who signed in, for those allowed in', async () => {
        new Profiles(registry.db).signedIn({ did: Member, handle: 'alice.bsky.social' });
        await open('member-session');
        const query = `/space/chat/people?did=${encodeURIComponent(Member)}&did=${encodeURIComponent(Stranger)}&did=nonsense`;
        const reply = await get(query, 'member-session');
        assert.equal(reply.status, 200);
        assert.deepEqual(JSON.parse(reply.text), {
            here: [{ did: Member, label: '@alice.bsky.social' }],
            labels: { [Member]: '@alice.bsky.social', [Stranger]: Stranger },
            muted: [],
        });
        assert.equal((await get(query)).status, 401);
        assert.equal((await get(query, 'stranger-session')).status, 403);
    });

    it('takes the room as its operator, signed in as itself', () => {
        assert.deepEqual(freeq.tokens[0], { did: 'did:web:hub.test', handle: 'hub.chat.hub.test' });
        assert.ok(freeq.botLines.includes('JOIN #space'));
        const answer = freeq.botLines.find(l => l.startsWith('AUTHENTICATE e')) ?? '';
        assert.deepEqual(JSON.parse(Buffer.from(answer.slice(13), 'base64url').toString()), {
            did: 'did:web:hub.test',
            method: 'web-token',
            signature: 'token-1',
        });
    });

    it('gives a login to someone allowed in', async () => {
        const reply = await post('/space/chat/token', 'member-session');
        assert.equal(reply.status, 200);
        assert.equal(reply.body.token, 'token-2');
        assert.equal(reply.body.room, '#space');
        assert.equal(reply.body.path, '/chat/irc');
        assert.equal(reply.body.label, '@alice.bsky.social');
        assert.match(reply.body.nick ?? '', /^alice-/);
        assert.deepEqual(freeq.tokens[1], { did: Member, handle: chatHandle(Member, Domain) });
    });

    it('gives none to anyone else', async () => {
        assert.equal((await post('/space/chat/token')).status, 401);
        assert.equal((await post('/space/chat/token', 'stranger-session')).status, 403);
        assert.equal((await post('/space/chat/token', 'member-session', 'https://evil.example')).status, 403);
        assert.equal(freeq.tokens.length, 1);
    });

    it('lets nobody in until it holds the room again', async () => {
        freeq.op = false;
        freeq.dropBot();
        await until(() => !chat.ready, 'the room to be lost');
        assert.equal((await post('/space/chat/token', 'member-session')).status, 503);
        assert.match((await open('member-session')).status, / 503 /);
        freeq.op = true;
        await until(() => chat.ready, 'the room to come back');
        assert.equal((await post('/space/chat/token', 'member-session')).status, 200);
    });

    it('joins an allowed browser to freeq, passing only what freeq needs', async () => {
        const c = await open('member-session');
        assert.match(c.status, / 101 /);
        const sent = freeq.upgrades[0] ?? {};
        assert.equal(sent['sec-websocket-key'], Key);
        assert.equal(sent['x-forwarded-for'], '203.0.113.9');
        assert.equal(sent.cookie, undefined);
        assert.equal(sent.origin, undefined);
        c.socket.write(frame('PING :x\r\n'));
        await until(() => c.text().includes('PING :x'), 'the echo');
        assert.equal(chat.connections(Member), 1);
    });

    it('refuses connections that should not get through', async () => {
        const cases: [string | undefined, Parameters<typeof open>[1], RegExp][] = [
            [undefined, {}, / 401 /],
            ['no-such-session', {}, / 401 /],
            ['stranger-session', {}, / 403 /],
            ['member-session', { origin: 'https://evil.example' }, / 403 /],
            ['member-session', { path: '/irc' }, / 404 /],
            ['member-session', { host: 'coolbbs.hub.test' }, / 404 /],
            ['member-session', { key: 'short' }, / 400 /],
        ];
        for (const [session, options, expected] of cases) {
            assert.match((await open(session, options)).status, expected, JSON.stringify([session, options]));
        }
        assert.equal(freeq.upgrades.length, 0);
    });

    it('limits how many connections one person has', async () => {
        assert.match((await open('member-session')).status, / 101 /);
        assert.match((await open('member-session')).status, / 101 /);
        assert.match((await open('member-session')).status, / 429 /);
    });

    it('closes the connection when someone stops being allowed', async () => {
        const c = await open('member-session');
        report([]);
        chat.sweep();
        await until(() => c.socket.destroyed || c.socket.readableEnded, 'the connection to close');
        await until(() => 0 === freeq.upstream.size, 'freeq to be told');
        assert.equal(chat.connections(Member), 0);
    });

    it("lets a BBS's door chat for a member who confirmed that BBS, and nobody else", async () => {
        registry.proxyOpened('coolbbs', 'web', null);
        const profiles = new Profiles(registry.db);
        profiles.signedIn({ did: Member, handle: 'alice.bsky.social' });
        const door = `bbs=coolbbs&did=${encodeURIComponent(Member)}`;
        //  the BBS's word alone isn't enough to speak as someone
        assert.equal((await asBbs('POST', `/api/bbs/chat/token?${door}`)).status, 403);
        assert.match((await open(undefined, { path: `/api/bbs/chat?${door}`, origin: null, auth: bbsToken })).status, / 403 /);
        presence.answer(Member, 'coolbbs', 'confirmed');
        const ticket = await asBbs('POST', `/api/bbs/chat/token?${door}`);
        assert.equal(ticket.status, 200);
        assert.equal(ticket.body.path, '/api/bbs/chat');
        assert.equal(ticket.body.label, '@alice.bsky.social');
        assert.equal((await asBbs('POST', `/api/bbs/chat/token?${door}`, 'wrong')).status, 401);
        assert.equal((await asBbs('POST', `/api/bbs/chat/token?${door}`, bbsToken, Origin)).status, 403);
        assert.equal((await asBbs('POST', `/api/bbs/chat/token?bbs=coolbbs&did=${encodeURIComponent(Stranger)}`)).status, 403);
        assert.equal((await asBbs('POST', '/api/bbs/chat/token?bbs=coolbbs')).status, 400);

        const c = await open(undefined, { path: `/api/bbs/chat?${door}`, origin: null, auth: bbsToken });
        assert.match(c.status, / 101 /);
        assert.equal(freeq.upgrades[0]?.authorization, undefined, "the BBS's token stays with the hub");
        c.socket.write(frame('PING :x\r\n'));
        await until(() => c.text().includes('PING :x'), 'the echo');
        assert.equal(chat.connections(Member), 1);
        assert.match((await open(undefined, { path: `/api/bbs/chat?${door}`, auth: bbsToken })).status, / 403 /);
        assert.match((await open(undefined, { path: `/api/bbs/chat?${door}`, origin: null, auth: 'wrong' })).status, / 401 /);

        const people = await asBbs('GET', `/api/bbs/chat/people?${door}&label=${encodeURIComponent(Member)}`);
        assert.equal(people.status, 200);
        assert.deepEqual(people.body.here, [{ did: Member, label: '@alice.bsky.social' }]);

        //  the member takes it back at the hub: the BBS can't speak for them
        presence.answer(Member, 'coolbbs', 'denied');
        chat.sweep();
        await until(() => c.socket.destroyed || c.socket.readableEnded, 'the connection to close');
        assert.equal(chat.connections(Member), 0);
    });

    it("closes a door that signs in as another of the BBS's members", async () => {
        registry.proxyOpened('coolbbs', 'web', null);
        const profiles = new Profiles(registry.db);
        profiles.signedIn({ did: Member, handle: 'alice.bsky.social' });
        profiles.signedIn({ did: Stranger, handle: 'bob.example' });
        report([{ did: Member }, { did: Stranger }]);
        presence.answer(Member, 'coolbbs', 'confirmed');
        presence.answer(Stranger, 'coolbbs', 'confirmed');
        const door = `bbs=coolbbs&did=${encodeURIComponent(Member)}`;
        const c = await open(undefined, { path: `/api/bbs/chat?${door}`, origin: null, auth: bbsToken });
        assert.match(c.status, / 101 /);
        c.socket.write(frame('AUTHENTICATE ATPROTO-CHALLENGE\r\n'));
        await until(() => freeq.received.includes('ATPROTO-CHALLENGE'), 'the challenge to reach freeq');
        //  Bob's login, on Alice's door
        c.socket.write(frame(`AUTHENTICATE ${answer(Stranger)}\r\n`));
        await until(() => c.socket.destroyed || c.socket.readableEnded, 'the connection to close');
        assert.equal(freeq.received.includes(answer(Stranger)), false, 'freeq never saw it');
        assert.equal(chat.connections(Member), 0);
    });

    it('remembers what was said in the room for a while, and who said it', async () => {
        const bot = [...freeq.botSockets][0] as Socket;
        const at = new Date().toISOString();
        bot.write(`@account=${Member};time=${at} :alice-1a2b!u@h PRIVMSG #space :hello\r\n`);
        bot.write(':nobody!u@h PRIVMSG #elsewhere :not here\r\n');
        bot.write(`@time=${new Date(Date.now() - 60 * 60_000).toISOString()} :old!u@h PRIVMSG #space :long ago\r\n`);
        await until(() => chat.recentLines.length >= 2, 'the lines');
        assert.deepEqual(chat.recent(), [{ did: Member, nick: 'alice-1a2b', text: 'hello', time: at }]);
        assert.ok(freeq.botLines.includes('CAP REQ :sasl message-tags server-time account-tag'));
    });

    it("keeps someone the admin blocked from the room out of it, and tells them who", async () => {
        const moderation = new Moderation(registry.db);
        const c = await open('member-session');
        const block = moderation.block(Member, 'room', { reason: 'flooding' });
        chat.sweep();
        await until(() => c.socket.destroyed || c.socket.readableEnded, 'the connection to close');
        const refused = await post('/space/chat/token', 'member-session');
        assert.equal(refused.status, 403);
        assert.equal(refused.body.error, 'The admin of hub.test has blocked you from its chat room: flooding.');
        assert.match((await get('/space/chat', 'member-session')).text, /blocked you from its chat room: flooding/);
        assert.match((await open('member-session')).status, / 403 /);
        //  the rest of the space is still theirs
        assert.equal((await get('/space', 'member-session')).text.includes('blocked'), false);
        moderation.unblock(block.id);
        assert.equal((await post('/space/chat/token', 'member-session')).status, 200);
    });

    it('takes reports, with what was just said, and mutes for the one who mutes', async () => {
        const profiles = new Profiles(registry.db);
        profiles.signedIn({ did: Member, handle: 'alice.bsky.social' });
        profiles.signedIn({ did: Stranger, handle: 'mallory.example' });
        sessions.all.set('second-session', { did: Stranger, handle: 'mallory.example', expiresAt: Expires });
        report([{ did: Member }, { did: Stranger }]);
        await open('second-session');
        const bot = [...freeq.botSockets][0] as Socket;
        bot.write(`@account=${Stranger} :mallory!u@h PRIVMSG #space :something nasty\r\n`);
        await until(() => chat.recentLines.length > 0, 'the line');

        const form = (path: string, fields: Record<string, string>, cookie = 'member-session') =>
            new Promise<{ status: number; body: Record<string, string> }>((resolve, reject) => {
                const req = request(
                    {
                        host: '127.0.0.1',
                        port,
                        method: 'POST',
                        path,
                        agent: false,
                        headers: {
                            Host: Domain,
                            Origin,
                            Cookie: `hub_session=${cookie}`,
                            'Content-Type': 'application/x-www-form-urlencoded',
                        },
                    },
                    res => {
                        let text = '';
                        res.on('data', d => (text += d));
                        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text || '{}') }));
                    }
                );
                req.on('error', reject);
                req.end(new URLSearchParams(fields).toString());
            });
        const mallory = `person:${Stranger}`;
        assert.equal((await form('/space/report', { person: mallory, note: '' })).status, 400);
        assert.equal((await form('/space/report', { person: 'person:nobody', note: 'x' })).status, 400);
        assert.equal((await form('/space/report', { person: mallory, note: 'Rude.' })).status, 200);
        const [filed] = new Moderation(registry.db).reports();
        assert.equal(filed?.reporter, Member);
        assert.equal(filed?.subject, Stranger);
        assert.equal(filed?.label, '@mallory.example');
        assert.deepEqual(
            filed?.messages.map(m => [m.did, m.text]),
            [[Stranger, 'something nasty']]
        );

        assert.equal((await form('/space/mute', { person: `person:${Member}` })).status, 400, 'not yourself');
        assert.equal((await form('/space/mute', { person: 'person:did:web:hub.test' })).status, 404, 'not the hub');
        assert.equal((await form('/space/mute', { person: mallory })).status, 200);
        const mine = JSON.parse((await get('/space/chat/people', 'member-session')).text);
        assert.deepEqual(mine.muted, [Stranger]);
        assert.deepEqual(mine.here, []);
        const theirs = JSON.parse((await get('/space/chat/people', 'second-session')).text);
        assert.deepEqual(theirs.muted, []);
        assert.match((await get('/me', 'member-session')).text, /People you muted[\s\S]*@mallory\.example/);

        //  what was said, and what the report said, stay out of the logs
        assert.ok(logs.some(l => /moderation: report/.test(l)));
        for (const line of logs) {
            for (const secret of ['something nasty', 'Rude.', Secret, bbsToken]) {
                assert.ok(!line.includes(secret), line);
            }
        }
    });

    it('closes the connection on signing out', async () => {
        const c = await open('member-session');
        assert.equal((await post('/signout', 'member-session')).status, 303);
        await until(() => c.socket.destroyed || c.socket.readableEnded, 'the connection to close');
    });

    it('leaves others alone when it closes one', async () => {
        sessions.all.set('second-session', { did: Stranger, handle: 'bob.example', expiresAt: Expires });
        report([{ did: Member }, { did: Stranger }]);
        const a = await open('member-session');
        const b = await open('second-session');
        report([{ did: Stranger }]);
        chat.sweep();
        await until(() => a.socket.destroyed || a.socket.readableEnded, 'the first to close');
        assert.equal(chat.connections(Stranger), 1);
        b.socket.write(frame('PING :still\r\n'));
        await until(() => b.text().includes('PING :still'), 'the other to keep working');
    });

    it('closes everyone when it loses the room, and takes it back', async () => {
        const c = await open('member-session');
        freeq.dropBot();
        await until(() => c.socket.destroyed || c.socket.readableEnded, 'the connection to close');
        await until(() => chat.ready, 'the room to come back');
    });
});

describe('art in the chat page', () => {
    it('offers pictures, ANSI or text, with the colours and the character set filled in', () => {
        //  the script parses as it is sent
        assert.doesNotThrow(() => new Function(ChatScript));
        assert.ok(!ChatScript.includes('__CP437__'), 'the CP437 table is filled in');
        assert.ok(ChatScript.includes('░▒▓'), 'with the PC block characters');
        const pane = chatPane('#space');
        assert.match(pane, /<select id="chat-view">/);
        assert.match(pane, /<option value="pictures">.*<option value="ansi">.*<option value="text">/s);
        assert.match(pane, /\.ansi \.f9 \{ color: #ff5555; \}/);
        assert.match(pane, /id="chat-view-wrap" class="chat-view" hidden/, 'hidden until the hub has art');
    });
});
