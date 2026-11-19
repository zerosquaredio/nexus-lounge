import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttp, request, type Server } from 'node:http';
import { createServer as createTcp, connect, type AddressInfo, type Server as TcpServer, type Socket } from 'node:net';
import { Chat, chatHandle, chatNick, MinChatSecret, parseIrc, signBroker } from '../src/chat.ts';
import { ChatScript, ChatScriptPath } from '../src/chat_page.ts';
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
            prefix: 's',
            command: '353',
            params: ['me', '=', '#space', '@hub alice'],
        });
        assert.deepEqual(parseIrc('PING :abc').params, ['abc']);
        assert.equal(parseIrc('AUTHENTICATE xyz').command, 'AUTHENTICATE');
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
    const sockets = new Set<Socket>();

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
        registry.add('coolbbs', SysopDid, null, { web: 8080, ws: 8810 });
        presence = new Presence(registry, config, new Profiles(registry.db));
        report([{ did: Member }]);
        sessions = new Sessions();
        chat = new Chat(config, Secret);
        site = createSite({ config, registry, signin: sessions, chat });
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
    function open(session?: string, options: { origin?: string; path?: string; host?: string; key?: string } = {}) {
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
                        `Sec-WebSocket-Key: ${options.key ?? Key}\r\nOrigin: ${options.origin ?? Origin}\r\n` +
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
        assert.doesNotMatch(ChatScript, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
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
        c.socket.write('frame');
        await until(() => c.text().includes('echo:frame'), 'the echo');
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
        b.socket.write('still');
        await until(() => b.text().includes('echo:still'), 'the other to keep working');
    });

    it('closes everyone when it loses the room, and takes it back', async () => {
        const c = await open('member-session');
        freeq.dropBot();
        await until(() => c.socket.destroyed || c.socket.readableEnded, 'the connection to close');
        await until(() => chat.ready, 'the room to come back');
    });
});
