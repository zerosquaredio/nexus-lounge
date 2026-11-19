//  The common space's chat (hub plan H15), on a private freeq server: an IRC
//  server that knows people by their DID and keeps nothing on disk when run
//  without a database.
//
//  freeq listens on 127.0.0.1 only, and the hub is the one way in:
//
//    - Who may connect is decided here. A browser reaches freeq through the
//      hub's own /chat/irc, which needs a signed-in session and the join rule
//      (hub plan H14), and the hub holds that connection. A BBS's door (F19)
//      comes in the same way at /api/bbs/chat, for a member who confirmed
//      that BBS at the hub. When someone's access ends the hub closes their
//      connection: freeq has no command to do that.
//    - Who someone is comes from here too. The hub asks freeq for a single-use
//      login token for the DID it signed in, with a handle under chat.<domain>,
//      and freeq is started to accept only those (generate.ts), so nobody can
//      use freeq's own AT sign-in to appear as some other account.
//    - The room belongs to the hub. freeq keeps rooms in memory and gives a
//      new room to whoever enters first, so after any restart the hub's bot
//      takes the room back before anyone else is let in.

import { createHash, createHmac } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { connect, isIP, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { HubConfig } from './config.ts';
import { HubError } from './errors.ts';

//  What the hub and freeq share (freeq's BROKER_SHARED_SECRET): kept out of
//  config files
export const ChatSecretEnv = 'HUB_CHAT_SECRET';
export const MinChatSecret = 32;
//  where the browser connects, on the hub's own address
export const ChatPath = '/chat/irc';
//  where a BBS's door connects for one of its members
export const BbsChatPath = '/api/bbs/chat';

const Host = '127.0.0.1';
const BotNick = 'hub';
const ConnectMs = 5_000;
const BotHandshakeMs = 15_000;
const MaxRetryMs = 30_000;

export interface ChatHooks {
    mayJoin(did: string): boolean;
    //  whether a browser session is still signed in
    sessionValid(session: string): boolean;
}

export interface ChatTicket {
    token: string;
    did: string;
    nick: string;
    //  how to show them
    label: string;
    room: string;
    path: string;
}

export interface ChatPerson {
    did: string;
    session: string;
    address: string;
    //  for a BBS's member, in place of a browser session: whether it holds
    valid?: () => boolean;
}

interface Link {
    person: ChatPerson;
    client: Duplex;
    upstream: Socket;
    since: string;
}

function hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

export function chatDomain(domain: string): string {
    return `chat.${domain}`;
}

//  The handle freeq knows someone by: never their own, so that only the hub
//  can name one it accepts
export function chatHandle(did: string, domain: string): string {
    return `${hash(did).slice(0, 16)}.${chatDomain(domain)}`;
}

//  An IRC nick from their handle. The ending keeps two people whose handles
//  look alike here apart
export function chatNick(handle: string | null, did: string): string {
    const base = (handle ?? 'user')
        .toLowerCase()
        .replace(/\.bsky\.social$/, '')
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^[-_]+/, '')
        .slice(0, 24)
        .replace(/[-_]+$/, '');
    return `${base || 'user'}-${hash(did).slice(0, 4)}`;
}

export function signBroker(secret: string, timestamp: string, body: string): string {
    return createHmac('sha256', secret).update(`ts=${timestamp}\n`).update(body).digest('base64url');
}

export function parseIrc(line: string): { prefix: string; command: string; params: string[] } {
    let rest = line;
    let prefix = '';
    if (rest.startsWith(':')) {
        const space = rest.indexOf(' ');
        prefix = space < 0 ? rest.slice(1) : rest.slice(1, space);
        rest = space < 0 ? '' : rest.slice(space + 1);
    }
    const colon = rest.startsWith(':') ? 0 : rest.indexOf(' :');
    const head = colon < 0 ? rest : rest.slice(0, colon);
    const words = head.split(' ').filter(Boolean);
    if (colon >= 0) {
        words.push(rest.slice(0 === colon && rest.startsWith(':') ? 1 : colon + 2));
    }
    return { prefix, command: (words.shift() ?? '').toUpperCase(), params: words };
}

export class Chat {
    config: HubConfig;
    secret: string;
    log: (line: string) => void;
    hooks: ChatHooks = { mayJoin: () => false, sessionValid: () => false };
    //  told when someone joins or leaves
    onChange: () => void = () => {};
    links = new Set<Link>();
    ready = false;
    stopped = true;
    bot: Socket | null = null;
    retries = 0;
    retryTimer: NodeJS.Timeout | null = null;
    sweepTimer: NodeJS.Timeout | null = null;

    constructor(config: HubConfig, secret: string, log: (line: string) => void = () => {}) {
        if (secret.length < MinChatSecret) {
            throw new HubError('config', `${ChatSecretEnv} must be at least ${MinChatSecret} characters`);
        }
        this.config = config;
        this.secret = secret;
        this.log = log;
    }

    get chat() {
        return this.config.space.chat;
    }

    get botDid(): string {
        return `did:web:${this.config.domain}`;
    }

    bind(hooks: ChatHooks): void {
        this.hooks = hooks;
    }

    start(): void {
        this.stopped = false;
        this.sweepTimer = setInterval(() => this.sweep(), this.chat.checkSeconds * 1000);
        this.sweepTimer.unref();
        this.connectBot();
    }

    stop(): void {
        this.stopped = true;
        this.ready = false;
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
        }
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
        }
        this.bot?.destroy();
        this.closeLinks(() => true);
    }

    //  A single-use login for someone allowed in. Refused until the hub holds
    //  the room, so nobody can get there first
    async issue(who: { did: string; handle: string | null }, path: string = ChatPath): Promise<ChatTicket> {
        if (!this.hooks.mayJoin(who.did)) {
            throw new HubError('chat-not-allowed', "You can't join this hub's common space yet.");
        }
        if (!this.ready) {
            throw new HubError('chat-unavailable', 'Chat is not available right now.');
        }
        const token = await this.loginToken(who.did, chatHandle(who.did, this.config.domain));
        return {
            token,
            did: who.did,
            nick: chatNick(who.handle, who.did),
            label: who.handle ? `@${who.handle}` : who.did,
            room: this.chat.room,
            path,
        };
    }

    //  A browser's connection, already checked for its origin and session:
    //  joined to freeq, and held so it can be closed. Returns why not, if not
    attach(req: IncomingMessage, client: Duplex, head: Buffer, person: ChatPerson): number | null {
        if (!this.ready) {
            return 503;
        }
        if (!this.hooks.mayJoin(person.did)) {
            return 403;
        }
        const mine = [...this.links].filter(l => l.person.did === person.did).length;
        if (mine >= this.chat.maxConnections) {
            return 429;
        }
        const key = String(req.headers['sec-websocket-key'] ?? '');
        const version = String(req.headers['sec-websocket-version'] ?? '');
        if (
            'websocket' !== String(req.headers.upgrade ?? '').toLowerCase() ||
            !/^[A-Za-z0-9+/]{22}==$/.test(key) ||
            '13' !== version
        ) {
            return 400;
        }
        const upstream = connect({ host: Host, port: this.chat.webPort });
        upstream.setTimeout(ConnectMs, () => upstream.destroy());
        const link: Link = { person, client, upstream, since: new Date().toISOString() };
        this.links.add(link);
        this.onChange();
        const close = () => {
            if (this.links.delete(link)) {
                this.onChange();
            }
            client.destroy();
            upstream.destroy();
        };
        for (const side of [client, upstream]) {
            side.once('close', close);
            side.once('error', close);
        }
        upstream.once('connect', () => {
            upstream.setTimeout(0);
            //  only what freeq needs: no cookies, nothing else from the browser
            const forwarded = isIP(person.address) ? `X-Forwarded-For: ${person.address}\r\n` : '';
            upstream.write(
                `GET /irc HTTP/1.1\r\nHost: ${Host}:${this.chat.webPort}\r\nConnection: Upgrade\r\n` +
                    `Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n` +
                    `${forwarded}\r\n`
            );
            if (head.length) {
                upstream.write(head);
            }
            upstream.pipe(client);
            client.pipe(upstream);
        });
        return null;
    }

    //  Close the connection of anyone who should no longer have one
    sweep(): void {
        this.closeLinks(
            ({ person }) =>
                !(person.valid ? person.valid() : this.hooks.sessionValid(person.session)) ||
                !this.hooks.mayJoin(person.did),
            'access ended'
        );
    }

    //  Who is connected now
    connected(): string[] {
        return [...new Set([...this.links].map(l => l.person.did))];
    }

    //  Who is connected, and since when (their first connection still open)
    present(): { did: string; since: string }[] {
        const out = new Map<string, string>();
        for (const l of this.links) {
            const was = out.get(l.person.did);
            if (!was || l.since < was) {
                out.set(l.person.did, l.since);
            }
        }
        return [...out.entries()].map(([did, since]) => ({ did, since }));
    }

    connections(did: string): number {
        return [...this.links].filter(l => l.person.did === did).length;
    }

    closeLinks(which: (link: Link) => boolean, why?: string): void {
        for (const link of [...this.links]) {
            if (which(link)) {
                if (why) {
                    this.log(`chat: closed ${link.person.did}: ${why}`);
                }
                link.client.destroy();
                link.upstream.destroy();
            }
        }
    }

    async loginToken(did: string, handle: string): Promise<string> {
        const body = JSON.stringify({ did, handle });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const res = await fetch(`http://${Host}:${this.chat.webPort}/auth/broker/web-token`, {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(ConnectMs),
            headers: {
                'Content-Type': 'application/json',
                'X-Broker-Timestamp': timestamp,
                'X-Broker-Signature': signBroker(this.secret, timestamp, body),
            },
            body,
        });
        if (!res.ok) {
            throw new Error(`freeq refused a login token (${res.status})`);
        }
        const token = ((await res.json()) as { token?: unknown }).token;
        if ('string' !== typeof token || !token) {
            throw new Error('freeq gave no login token');
        }
        return token;
    }

    connectBot(): void {
        this.runBot().catch(e => {
            this.log(`chat: ${(e as Error).message}`);
            this.retryBot();
        });
    }

    retryBot(): void {
        if (this.stopped || this.retryTimer) {
            return;
        }
        const delay = Math.min(MaxRetryMs, 1000 * 2 ** this.retries++);
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.connectBot();
        }, delay);
        this.retryTimer.unref();
    }

    //  The hub's own connection: signs in, enters the room, and must hold it
    //  as its operator before anyone else is let in
    async runBot(): Promise<void> {
        const handle = `${BotNick}.${chatDomain(this.config.domain)}`;
        const token = await this.loginToken(this.botDid, handle);
        if (this.stopped) {
            return;
        }
        const room = this.chat.room.toLowerCase();
        const socket = connect({ host: Host, port: this.chat.ircPort });
        this.bot = socket;
        let buffer = '';
        let nick = BotNick;
        let opped = false;
        const send = (line: string) => socket.write(`${line}\r\n`);
        const fail = (why: string) => {
            this.log(`chat: ${why}`);
            socket.destroy();
        };
        const handshake = setTimeout(() => fail('the hub could not take the room in time'), BotHandshakeMs);
        const onLine = (line: string) => {
            const { command, params } = parseIrc(line);
            switch (command) {
                case 'PING':
                    return send(`PONG :${params.at(-1) ?? ''}`);
                case 'CAP':
                    return 'ACK' === params[1]?.toUpperCase() ? send('AUTHENTICATE ATPROTO-CHALLENGE') : undefined;
                case 'AUTHENTICATE': {
                    const answer = { did: this.botDid, method: 'web-token', signature: token };
                    return send(`AUTHENTICATE ${Buffer.from(JSON.stringify(answer)).toString('base64url')}`);
                }
                case '903':
                    return send('CAP END');
                case '904':
                case '905':
                case '906':
                case '433':
                case '432':
                case 'ERROR':
                    return fail(`the hub could not sign in to chat (${command})`);
                case '001':
                    nick = params[0] ?? nick;
                    return send(`JOIN ${this.chat.room}`);
                case '353':
                    if (params[2]?.toLowerCase() === room) {
                        opped ||= (params[3] ?? '')
                            .split(' ')
                            .some(n => /^[~&@%+]*@[~&@%+]*/.test(n) && n.replace(/^[~&@%+]+/, '') === nick);
                    }
                    return;
                case '366':
                    if (params[1]?.toLowerCase() !== room) {
                        return;
                    }
                    if (!opped) {
                        return fail(`the hub is not the operator of ${this.chat.room}`);
                    }
                    clearTimeout(handshake);
                    this.ready = true;
                    this.retries = 0;
                    return this.log(`chat: holding ${this.chat.room}`);
            }
        };
        socket.setEncoding('utf8');
        socket.setKeepAlive(true, 30_000);
        socket.once('connect', () => {
            send('CAP LS 302');
            send(`NICK ${BotNick}`);
            send(`USER ${BotNick} 0 * :${this.config.domain}`);
            send('CAP REQ :sasl');
        });
        socket.on('data', (chunk: string) => {
            buffer += chunk;
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? '';
            lines.filter(Boolean).forEach(onLine);
        });
        socket.once('error', e => this.log(`chat: ${e.message}`));
        socket.once('close', () => {
            clearTimeout(handshake);
            if (this.bot === socket) {
                this.bot = null;
            }
            //  nobody stays in a room the hub no longer holds
            this.ready = false;
            this.closeLinks(() => true);
            this.retryBot();
        });
    }
}
