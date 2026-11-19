//  The hub's own site (hub plan H3, H13): people sign in with AT; sysops
//  register their BBSes, and with the common space on, anyone signed in
//  has a profile. Served behind the edge, at the hub's own domain.
//
//  GET  /                 the directory
//  GET  /signin           sign in
//  POST /signin           start AT sign-in
//  GET  /oauth/callback   the account host sends the browser back here
//  GET  /me               your profile (common space on)
//  POST /me/presence      show you in the common space, or not
//  POST /me/forget        remove your profile and sign out everywhere
//  POST /me/bbs           confirm or deny a BBS that says you are a member
//  GET  /space            who is around (common space on); the map, with the live model on
//  GET  /space/map.js     the map's script
//  GET  /space/chat       the chat page
//  GET  /space/chat.js    its script
//  GET  /space/chat/people  who is in the room, and names for DIDs
//  POST /space/chat/token a single-use chat login, for someone allowed in
//  GET  /chat/irc         the chat connection (WebSocket), see chat.ts
//  GET  /space/live       the live model (WebSocket), see live.ts
//  POST /api/bbs/presence a BBS reports its members (bearer: its tunnel token)
//  GET  /api/bbs/live     the live model for one of a BBS's members (WebSocket; F19)
//  POST /api/bbs/chat/token  a chat login for one of a BBS's members
//  GET  /api/bbs/chat     their chat connection (WebSocket)
//  GET  /api/bbs/chat/people  who is in the room, and names for DIDs
//    (the door's calls: bearer, ?bbs=name and ?did= or ?user= for the member)
//  GET  /bbs              your BBSes, and registering a new one
//  POST /bbs              register a BBS: shows its token and agent config, once
//  POST /bbs/rotate       a new token and agent config
//  POST /bbs/remove
//  POST /signout

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { BbsChatPath, ChatPath, type Chat } from './chat.ts';
import { chatPageBody, ChatScript, ChatScriptPath, MaxLabelLookups } from './chat_page.ts';
import { Live, LivePath } from './live.ts';
import { mapPageBody, MapScript, MapScriptPath } from './map_page.ts';
import type { HubConfig } from './config.ts';
import { HubError } from './errors.ts';
import { agentConfig } from './generate.ts';
import { esc, page } from './html.ts';
import type { Bbs, Registry } from './registry.ts';
import type { AtClient } from './atproto.ts';
import type { Directory, DirectoryEntry } from './directory.ts';
import type { Listing } from './listing.ts';
import { Profiles, type Profile } from './profiles.ts';
import { parseReport, Presence, type DoorAccess } from './presence.ts';
import { isDid, labelForHost } from './rules.ts';
import { CallbackPath, SessionDays, type Identity, type WebSession } from './signin.ts';
import { clientConfig, fileFor, policy, WebTermPath, type WebTerm } from './webterm.ts';

export interface SignInLike {
    start(handle: string): Promise<string>;
    finish(params: URLSearchParams): Promise<Identity>;
    createSession(identity: Identity): string;
    session(token: string | undefined): WebSession | null;
    endSession(token: string | undefined): void;
}

export interface SiteDeps {
    config: HubConfig;
    registry: Registry;
    signin: SignInLike;
    //  the hub's copy of enig-term, if it serves one
    webterm?: WebTerm | null;
    //  BBS listings from the AT network, and looking up accounts
    directory?: Directory | null;
    at?: AtClient | null;
    //  the common space's chat, if it's on
    chat?: Chat | null;
    log?: (line: string) => void;
    now?: () => number;
}

const Cookie = 'hub_session';
const MaxForm = 8 * 1024;
//  a presence report of the most members allowed fits easily
const MaxReport = 512 * 1024;
const HandleRe = /^@?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/i;

//  A few attempts per address or account in a window, in memory
class Limiter {
    hits = new Map<string, number[]>();
    max: number;
    windowMs: number;
    now: () => number;
    constructor(max: number, windowMs: number, now: () => number) {
        this.max = max;
        this.windowMs = windowMs;
        this.now = now;
    }
    allow(key: string): boolean {
        const since = this.now() - this.windowMs;
        const recent = (this.hits.get(key) ?? []).filter(t => t > since);
        if (recent.length >= this.max) {
            this.hits.set(key, recent);
            return false;
        }
        recent.push(this.now());
        this.hits.set(key, recent);
        return true;
    }
}

function cookies(req: IncomingMessage): Record<string, string> {
    const out: Record<string, string> = {};
    for (const part of (req.headers.cookie ?? '').split(';')) {
        const at = part.indexOf('=');
        if (at > 0) {
            out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
        }
    }
    return out;
}

//  The visitor's address: behind the edge (on this machine), the one it
//  sets; the edge replaces anything the visitor sent
function clientAddress(req: IncomingMessage): string {
    const peer = req.socket.remoteAddress ?? '';
    const forwarded = String(req.headers['x-forwarded-for'] ?? '')
        .split(',')
        .pop()
        ?.trim();
    return ('127.0.0.1' === peer || '::1' === peer || '::ffff:127.0.0.1' === peer) && forwarded
        ? forwarded
        : peer;
}

function readBody(req: IncomingMessage, max: number): Promise<string> {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > max) {
                reject(new HubError('too-large', 'That form was too large.'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
    return new URLSearchParams(await readBody(req, MaxForm));
}

export function createSite(deps: SiteDeps): Server {
    const { config, registry, signin } = deps;
    const log = deps.log ?? (() => {});
    const now = deps.now ?? Date.now;
    const secure = config.site.publicUrl.startsWith('https://');
    const signinLimit = new Limiter(10, 10 * 60 * 1000, now);
    const changeLimit = new Limiter(10, 60 * 60 * 1000, now);
    const profiles = config.space.enabled ? new Profiles(registry.db, () => new Date(now())) : null;
    const presence = profiles ? new Presence(registry, config, profiles, deps.directory ?? null, now) : null;
    const reportLimit = new Limiter(30, 60 * 1000, now);
    const chatLimit = new Limiter(30, 60 * 1000, now);
    const chat = presence ? (deps.chat ?? null) : null;
    chat?.bind({
        mayJoin: did => !!presence?.mayJoin(did),
        sessionValid: session => !!signin.session(session),
    });
    const live =
        presence && profiles && config.space.live.enabled
            ? new Live(
                  { config, registry, presence, profiles, directory: deps.directory ?? null, chat, webterm: !!deps.webterm },
                  { sessionValid: session => !!signin.session(session) },
                  log,
                  now
              )
            : null;
    if (chat && live) {
        chat.onChange = () => live.poke();
    }
    //  where signing in leads
    const home = profiles ? '/me' : '/bbs';

    function send(
        res: ServerResponse,
        status: number,
        html: string,
        headers: Record<string, string> = {}
    ): void {
        res.writeHead(status, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'same-origin',
            //  forms post here, and sign-in then redirects to the account host
            'Content-Security-Policy':
                "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self' https:; frame-ancestors 'none'; base-uri 'none'",
            ...headers,
        });
        res.end(html);
    }

    function redirect(res: ServerResponse, location: string, headers: Record<string, string> = {}): void {
        res.writeHead(303, { Location: location, 'Cache-Control': 'no-store', ...headers });
        res.end();
    }

    function sessionCookie(token: string, maxAge: number): string {
        return `${Cookie}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
    }

    function landing(error?: string): string {
        const intro = profiles
            ? `<p>Sign in to take part in this hub's common space, or to register your BBS: a registered BBS
gets an address under <code>${esc(config.domain)}</code>, reachable from anywhere without opening any ports.</p>`
            : `<p>Run a BBS? Register it here, and it gets an address under
<code>${esc(config.domain)}</code>, reachable from anywhere without opening any ports.</p>`;
        return page(
            profiles ? 'Sign in' : 'Register your BBS',
            `${intro}
${error ? `<p class="error">${esc(error)}</p>` : ''}
<form method="post" action="/signin">
<label for="handle">Sign in with your Bluesky (AT Protocol) handle</label>
<input type="text" id="handle" name="handle" placeholder="you.bsky.social" autocomplete="username" required>
<button>Sign in</button>
</form>
<p class="hint">Signing in only tells the hub who you are. It can't post or read anything in your account,
and it keeps no access to it afterwards.</p>
<p><a href="/">Back to the directory</a></p>`
        );
    }

    function bbsRow(bbs: Bbs): string {
        const status =
            'suspended' === bbs.state
                ? 'suspended by the hub'
                : bbs.connected
                  ? 'connected'
                  : 'not connected';
        const actions =
            'active' === bbs.state
                ? `<form class="inline" method="post" action="/bbs/rotate"><input type="hidden" name="name" value="${esc(
                      bbs.name
                  )}"><button>New token</button></form>`
                : '';
        const directory = deps.directory;
        const listed = !directory
            ? ''
            : directory.forBbs(bbs)
              ? '<br><span class="dim">listed in the directory</span>'
              : bbs.bbsDid
                ? `<br><span class="dim">not listed yet: its listing must name https://${esc(bbs.name)}.${esc(
                      config.domain
                  )}</span>`
                : '<br><span class="dim">not listed: no Bluesky account given for it</span>';
        return `<tr><td><strong>${esc(bbs.name)}</strong>.${esc(config.domain)}${listed}</td><td>${esc(status)}</td><td>${actions}</td></tr>`;
    }

    function dashboard(who: WebSession, error?: string, values: Record<string, string> = {}): string {
        const mine = registry.listForSysop(who.did);
        const max = config.registration.maxBbsPerSysop;
        const canAdd = config.registration.open && mine.length < max;
        const list = mine.length
            ? `<table><tr><th>BBS</th><th>Status</th><th></th></tr>${mine.map(bbsRow).join('')}</table>`
            : '<p class="dim">You have no BBSes registered here yet.</p>';
        const remove = mine.length
            ? `<h2>Remove a BBS</h2>
<form method="post" action="/bbs/remove">
<label for="rname">Type the name of the BBS to remove</label>
<input type="text" id="rname" name="name" autocomplete="off">
<button>Remove it</button>
</form>
<p class="hint">Its tunnel stops working and its name becomes free for anyone.</p>`
            : '';
        const add = canAdd
            ? `<h2>Register a BBS</h2>
${error ? `<p class="error">${esc(error)}</p>` : ''}
<form method="post" action="/bbs">
<label for="name">Name</label>
<input type="text" id="name" name="name" value="${esc(values.name)}" placeholder="coolbbs" autocomplete="off" required>
<p class="hint">2 to 32 lower-case letters, digits and hyphens. Your BBS will be at <code>name.${esc(config.domain)}</code>.</p>
<label for="webPort">Your BBS's web server port</label>
<input type="text" id="webPort" name="webPort" value="${esc(values.webPort ?? '8080')}" inputmode="numeric">
<label for="wsPort">Its WebSocket (web terminal) port</label>
<input type="text" id="wsPort" name="wsPort" value="${esc(values.wsPort ?? '8810')}" inputmode="numeric">
<label for="bbsAccount">Your BBS's own Bluesky account (optional)</label>
<input type="text" id="bbsAccount" name="bbsAccount" value="${esc(values.bbsAccount)}" placeholder="coolbbs.bsky.social" autocomplete="off">
<p class="hint">The account your BBS publishes its listing from. The directory shows that listing here once it
names your BBS's address on this hub (<code>https://name.${esc(config.domain)}</code>).</p>
<button>Register</button>
</form>`
            : config.registration.open
              ? `<p class="dim">You have ${mine.length} BBSes, the most this hub allows per sysop.</p>`
              : '<p class="dim">This hub registers new BBSes by arrangement with its admin.</p>';
        const account = mine.some(b => 'active' === b.state)
            ? `<h2>Your BBS's Bluesky account</h2>
<form method="post" action="/bbs/account">
<label for="aname">BBS</label>
<input type="text" id="aname" name="name" autocomplete="off" placeholder="coolbbs">
<label for="aaccount">Its Bluesky account (handle or DID; empty to clear)</label>
<input type="text" id="aaccount" name="bbsAccount" autocomplete="off" placeholder="coolbbs.bsky.social">
<button>Save</button>
</form>`
            : '';
        return page(
            'Your BBSes',
            `${list}${add}${account}${remove}<p>${profiles ? '<a href="/me">Your profile</a> · ' : ''}<a href="/">The directory</a></p>`,
            who
        );
    }

    function profilePage(who: WebSession, profile: Profile): string {
        const shown = profile.presence
            ? `<p><strong>On:</strong> others in the common space can see that you are around, and which
BBS you are on.</p>
<form method="post" action="/me/presence"><input type="hidden" name="presence" value="off"><button>Stop showing me</button></form>`
            : `<p><strong>Off:</strong> nobody in the common space sees you, whatever BBS you are on.</p>
<form method="post" action="/me/presence"><input type="hidden" name="presence" value="on"><button>Show me</button></form>`;
        const bbses = registry.listForSysop(who.did).length
            ? '<a href="/bbs">Your BBSes</a>'
            : 'Run a BBS? <a href="/bbs">Register it here</a>';
        return page(
            'Your profile',
            `<table>
<tr><th>Signed in as</th><td>${esc(profile.handle ? `@${profile.handle}` : '(no handle)')}</td></tr>
<tr><th>Account</th><td><code>${esc(profile.did)}</code></td></tr>
<tr><th>On this hub since</th><td>${esc(profile.createdAt.slice(0, 10))}</td></tr>
</table>
<h2>Being shown in the common space</h2>
${shown}
<p class="hint">Off unless you turn it on. A BBS that reports who is on it has its own setting for you
too, and the stricter one wins.</p>
${membershipsSection(who)}
<p>${bbses} · <a href="/space">Who's around</a> · <a href="/">The directory</a></p>
<h2>Remove your profile</h2>
<form method="post" action="/me/forget"><button>Remove it and sign out</button></form>
<p class="hint">The hub keeps only what is shown above. Removing it signs you out everywhere; signing in
again starts a new profile, with presence off.</p>`,
            who
        );
    }

    function membershipsSection(who: WebSession): string {
        const list = presence?.memberships(who.did) ?? [];
        if (!list.length) {
            return `<h2>Your BBSes</h2>
<p class="dim">No BBS on this hub has said you are a member yet. A BBS tells the hub once you turn on
being shown in its own settings.</p>`;
        }
        const row = (m: (typeof list)[number]) => {
            const form = (answer: string, label: string) =>
                `<form class="inline" method="post" action="/me/bbs"><input type="hidden" name="bbs" value="${esc(
                    m.bbs
                )}"><input type="hidden" name="answer" value="${answer}"><button>${label}</button></form>`;
            const state =
                'confirmed' === m.answer
                    ? 'Confirmed: you are shown as yourself there'
                    : 'denied' === m.answer
                      ? 'Denied: what it says about you is ignored'
                      : `Not confirmed: you are shown as "${esc(m.name)} via ${esc(m.bbs)}"`;
            const actions = [
                'confirmed' !== m.answer ? form('confirmed', 'That is me') : '',
                'denied' !== m.answer ? form('denied', 'Not me') : '',
            ].join('');
            return `<tr><td><strong>${esc(m.bbs)}</strong><br><span class="dim">as ${esc(m.name)}, a member since ${esc(
                m.memberSince.slice(0, 10)
            )}</span></td><td>${state}</td><td>${actions}</td></tr>`;
        };
        return `<h2>Your BBSes</h2>
<p class="hint">These BBSes say you are a member. Until you confirm one, the hub shows you there only by
the name the BBS gives, never as your own account.</p>
<table>${list.map(row).join('')}</table>`;
    }

    function spacePage(who: WebSession): string {
        if (!presence?.mayJoin(who.did)) {
            return page(
                "Who's around",
                `<p>This hub's common space is for members of its BBSes. Once a BBS here says you are a member
(turn on being shown in its own settings), you can join.</p>
<p><a href="/me">Your profile</a> · <a href="/">The directory</a></p>`,
                who
            );
        }
        const people = presence.around();
        const byBbs = new Map<string, typeof people>();
        for (const p of people) {
            byBbs.set(p.bbs, [...(byBbs.get(p.bbs) ?? []), p]);
        }
        const groups =
            [...byBbs.entries()]
                .map(
                    ([bbs, list]) => `<article>
<h3>${esc(bbs)} <span class="dim">${list.length} on</span></h3>
<p>${list.map(p => esc(p.label)).join(', ')}</p>
</article>`
                )
                .join('\n') || '<p class="dim">Nobody is around right now.</p>';
        if (live) {
            return page("Who's around", mapPageBody(groups, !!chat), who);
        }
        return page(
            "Who's around",
            `${groups}
<p class="hint">Only people who chose to be shown appear here.</p>
<p>${chat ? '<a href="/space/chat">Chat</a> · ' : ''}<a href="/me">Your profile</a> · <a href="/">The directory</a></p>`,
            who
        );
    }

    //  The map's page may open the live stream, and nothing else
    function spaceHeaders(who: WebSession): Record<string, string> {
        if (!live || !presence?.mayJoin(who.did)) {
            return {};
        }
        const socket = config.site.publicUrl.replace(/^http/, 'ws');
        return {
            'Content-Security-Policy': `default-src 'none'; script-src 'self'; connect-src 'self' ${socket}; style-src 'unsafe-inline'; img-src 'self'; form-action 'self' https:; frame-ancestors 'none'; base-uri 'none'`,
        };
    }

    function json(res: ServerResponse, status: number, body: unknown): void {
        res.writeHead(status, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
        });
        res.end(JSON.stringify(body));
    }

    //  A BBS reports its members (F18): authenticated by its tunnel token,
    //  and speaking only for itself
    async function presenceReport(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (!presence) {
            return json(res, 404, { error: 'This hub has no common space.' });
        }
        const auth = String(req.headers.authorization ?? '');
        const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
        let body: unknown;
        try {
            body = JSON.parse(await readBody(req, MaxReport));
        } catch (e) {
            return json(res, e instanceof HubError ? 413 : 400, { error: 'A report is a JSON object.' });
        }
        const name = (body as { bbs?: unknown } | null)?.bbs;
        const bbs = registry.authenticate(name, token);
        if (!bbs) {
            //  the same answer for no such BBS, a wrong token and a suspended one
            return json(res, 401, { error: 'Not a BBS on this hub, or the wrong token.' });
        }
        if (!reportLimit.allow(bbs.name)) {
            return json(res, 429, { error: 'Too many reports; one a minute is plenty.' });
        }
        try {
            const members = parseReport(body);
            presence.report(bbs, members);
            live?.poke();
            return json(res, 200, { ok: true, members: members.length });
        } catch (e) {
            if (e instanceof HubError) {
                return json(res, 400, { error: e.message });
            }
            throw e;
        }
    }

    //  A BBS asking for one of its members, inside the BBS (F19): the BBS by
    //  its tunnel token, the member by what it reported. Never from a web
    //  page. A status if not; `allowed` checks again later
    function doorFor(
        req: IncomingMessage,
        url: URL
    ): { bbs: Bbs; door: DoorAccess; allowed: () => boolean } | number {
        if (!presence) {
            return 404;
        }
        if (req.headers.origin) {
            return 403;
        }
        const auth = String(req.headers.authorization ?? '');
        const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
        const name = url.searchParams.get('bbs');
        const bbs = registry.authenticate(name, token);
        if (!bbs) {
            return 401;
        }
        const did = url.searchParams.get('did');
        const user = url.searchParams.get('user');
        if (!!did === !!user || (did && !isDid(did)) || (user && user.length > 64)) {
            return 400;
        }
        const door = presence.doorAccess(bbs, did, user);
        if (!door) {
            return 403;
        }
        const allowed = () => {
            const now = registry.authenticate(name, token);
            const still = now ? presence.doorAccess(now, did, user) : null;
            return !!still && still.kind === door.kind && still.did === door.did;
        };
        return { bbs, door, allowed };
    }

    //  Why a door was refused, for the BBS to show its member
    function doorError(status: number): string {
        return (
            {
                400: 'Name the BBS, and its member by did or user.',
                401: 'Not a BBS on this hub, or the wrong token.',
                403: "This member can't join the hub's space from this BBS right now.",
                404: 'This hub has no common space.',
            }[status] ?? 'Refused.'
        );
    }

    async function doorChatToken(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
        const found = doorFor(req, url);
        if ('number' === typeof found) {
            return json(res, found, { error: doorError(found) });
        }
        if (!chat) {
            return json(res, 404, { error: 'This hub has no chat.' });
        }
        const { door } = found;
        if (!door.chat || !door.did) {
            return json(res, 403, {
                error: 'Only members who confirmed this BBS at the hub can chat from it.',
            });
        }
        if (!chatLimit.allow(door.did)) {
            return json(res, 429, { error: 'Too many attempts; try again in a minute.' });
        }
        try {
            return json(res, 200, await chat.issue({ did: door.did, handle: profiles?.get(door.did)?.handle ?? null }, BbsChatPath));
        } catch (e) {
            if (e instanceof HubError && 'chat-not-allowed' === e.code) {
                return json(res, 403, { error: e.message });
            }
            log(`chat: no login for ${door.did} from ${door.bbs}: ${(e as Error).message}`);
            return json(res, 503, { error: 'Chat is not available right now.' });
        }
    }

    function doorChatPeople(req: IncomingMessage, res: ServerResponse, url: URL): void {
        const found = doorFor(req, url);
        if ('number' === typeof found) {
            return json(res, found, { error: doorError(found) });
        }
        if (!chat) {
            return json(res, 404, { error: 'This hub has no chat.' });
        }
        return json(res, 200, peopleInRoom(url.searchParams.getAll('label')));
    }

    //  How someone appears in chat: from who they signed in as, never from
    //  anything their client says
    function chatLabel(did: string): string | null {
        if (did === chat?.botDid) {
            return config.domain;
        }
        const handle = profiles?.get(did)?.handle;
        return handle ? `@${handle}` : null;
    }

    function chatPeople(res: ServerResponse, who: WebSession | null, url: URL): void {
        if (!who) {
            return json(res, 401, { error: 'Sign in first.' });
        }
        if (!chat || !presence?.mayJoin(who.did)) {
            return json(res, 403, { error: "You can't join this room." });
        }
        return json(res, 200, peopleInRoom(url.searchParams.getAll('did')));
    }

    function peopleInRoom(dids: string[]): { here: { did: string; label: string }[]; labels: Record<string, string> } {
        const labels: Record<string, string> = {};
        for (const did of dids.slice(0, MaxLabelLookups)) {
            if (isDid(did)) {
                labels[did] = chatLabel(did) ?? did;
            }
        }
        const here = (chat?.connected() ?? []).map(did => ({ did, label: chatLabel(did) ?? did }));
        return { here, labels };
    }

    function chatPage(res: ServerResponse, who: WebSession): void {
        if (!presence?.mayJoin(who.did)) {
            return send(res, 200, spacePage(who));
        }
        const socket = config.site.publicUrl.replace(/^http/, 'ws');
        return send(res, 200, page('Chat', chatPageBody(config.space.chat.room), who), {
            'Content-Security-Policy': `default-src 'none'; script-src 'self'; connect-src 'self' ${socket}; style-src 'unsafe-inline'; img-src 'self'; form-action 'self' https:; frame-ancestors 'none'; base-uri 'none'`,
        });
    }

    //  A single-use chat login for the person signed in
    async function chatToken(res: ServerResponse, who: WebSession | null): Promise<void> {
        if (!chat) {
            return json(res, 404, { error: 'This hub has no chat.' });
        }
        if (!who) {
            return json(res, 401, { error: 'Sign in first.' });
        }
        if (!chatLimit.allow(who.did)) {
            return json(res, 429, { error: 'Too many attempts; try again in a minute.' });
        }
        try {
            return json(res, 200, await chat.issue(who));
        } catch (e) {
            if (e instanceof HubError && 'chat-not-allowed' === e.code) {
                return json(res, 403, { error: e.message });
            }
            log(`chat: no login for ${who.did}: ${(e as Error).message}`);
            return json(res, 503, { error: 'Chat is not available right now.' });
        }
    }

    function credentials(who: WebSession, bbs: Bbs, token: string, fresh: boolean): string {
        const text = agentConfig(config, { name: bbs.name, token, webPort: bbs.webPort, wsPort: bbs.wsPort });
        return page(
            fresh ? 'Registered' : 'New token',
            `<p><strong>${esc(bbs.name)}.${esc(config.domain)}</strong> is ${fresh ? 'registered' : 'given a new token; the old one has stopped working'}.</p>
<p class="warn">This is the only time the hub shows this token. Save the agent config below now:
it is your BBS's password on this hub. If you lose it, come back for a new token.</p>
<h2>Agent config</h2>
<p>Save this as <code>${esc(bbs.name)}-agent.toml</code> on your BBS's machine, and run the tunnel agent
(<a href="https://github.com/fatedier/frp/releases">frpc</a>) with it:
<code>frpc -c ${esc(bbs.name)}-agent.toml</code></p>
<textarea rows="${text.split('\n').length}" readonly>${esc(text)}</textarea>
<p><a href="/bbs">Back to your BBSes</a></p>`,
            who
        );
    }

    function port(value: string | null, fallback: number): number {
        const n = Number(value || fallback);
        if (!Number.isInteger(n) || n < 1 || n > 65535) {
            throw new HubError('bad-port', 'Ports are whole numbers from 1 to 65535.');
        }
        return n;
    }

    //  The public address of a name under the hub, through the edge
    function hubUrl(host: string): string {
        return `https://${host}${443 === config.edge.httpsPort ? '' : `:${config.edge.httpsPort}`}`;
    }

    //  A BBS's own address (name.domain): its page, and the web terminal
    function bbsSite(req: IncomingMessage, res: ServerResponse, label: string, path: string): void {
        if ('GET' !== req.method && 'HEAD' !== req.method) {
            return send(res, 405, page('Not allowed', '<p>Not allowed.</p>'));
        }
        const bbs = registry.get(label);
        if (!bbs) {
            return send(res, 404, page('Not found', `<p>No BBS is registered as ${esc(label)}.</p>`));
        }
        if ('suspended' === bbs.state) {
            return send(
                res,
                410,
                page(`${bbs.name}.${config.domain}`, "<p>This BBS isn't available on this hub.</p>")
            );
        }
        if ('/' === path) {
            return send(res, 200, boardPage(bbs));
        }
        const webterm = deps.webterm;
        if (webterm && `${WebTermPath}config.json` === path) {
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache',
                'X-Content-Type-Options': 'nosniff',
            });
            return void res.end(clientConfig(config, bbs.name));
        }
        if (webterm && WebTermPath.slice(0, -1) === path) {
            return redirect(res, WebTermPath);
        }
        const found = webterm ? fileFor(webterm, path) : null;
        if (!webterm || !found) {
            return send(res, 404, page('Not found', '<p>Nothing here.</p>'));
        }
        const headers: Record<string, string> = {
            'Content-Type': found.file.type,
            //  revalidate each time: enig-term's files must match each other
            'Cache-Control': 'no-cache',
            ETag: found.file.etag,
            'X-Content-Type-Options': 'nosniff',
        };
        if (found.file.type.startsWith('text/html')) {
            headers['Content-Security-Policy'] = policy(webterm, config, bbs.name);
            headers['Referrer-Policy'] = 'same-origin';
        }
        if (req.headers['if-none-match'] === found.file.etag) {
            res.writeHead(304, headers);
            return void res.end();
        }
        res.writeHead(200, headers);
        res.end('HEAD' === req.method ? undefined : found.file.body);
    }

    function lastSeen(bbs: Bbs): string {
        if (bbs.connected) {
            return '<p><strong>Online</strong> now.</p>';
        }
        const when = bbs.lastDisconnectedAt ?? bbs.lastConnectedAt;
        return when
            ? `<p><strong>Offline.</strong> Last seen <time datetime="${esc(when)}">${esc(
                  when.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')
              )}</time>. Many BBSes are only up part of the time.</p>`
            : "<p><strong>Offline.</strong> It hasn't connected to the hub yet.</p>";
    }

    function boardPage(bbs: Bbs): string {
        const connect = deps.webterm
            ? `<p><a href="${WebTermPath}?connect=1">Connect in your browser</a></p>`
            : '';
        const entry = deps.directory?.forBbs(bbs) ?? null;
        const title = entry ? entry.listing.name : `${bbs.name}.${config.domain}`;
        return page(
            title,
            `${entry ? `<p class="dim">${esc(bbs.name)}.${esc(config.domain)}</p>` : ''}
${lastSeen(bbs)}
${connect}
${entry ? listingDetails(entry, false) : ''}
<p class="dim">A BBS on the <a href="${esc(hubUrl(config.domain))}/">${esc(config.domain)}</a> hub.</p>`
        );
    }

    //  What a listing says, for the directory and the BBS's page
    function listingDetails(entry: DirectoryEntry, brief: boolean): string {
        const l = entry.listing;
        const parts: string[] = [];
        if (l.description) {
            parts.push(`<p>${esc(l.description)}</p>`);
        }
        if (entry.status && 'up' !== entry.status.state) {
            parts.push(
                `<p><strong>${esc(entry.status.state)}</strong>${entry.status.message ? `: ${esc(entry.status.message)}` : ''}${
                    entry.status.until
                        ? ` (until ${esc(entry.status.until.replace('T', ' ').replace(/:\d\d\.\d+Z$/, ' UTC'))})`
                        : ''
                }</p>`
            );
        }
        if (l.tags.length) {
            parts.push(`<p class="tags">${l.tags.map(t => `<span>${esc(t)}</span>`).join(' ')}</p>`);
        }
        const hours = hoursText(l);
        if (hours) {
            parts.push(`<p class="dim">${esc(hours)}</p>`);
        }
        if (!brief) {
            if (l.admission.howToJoin) {
                parts.push(`<h2>How to join</h2><p>${esc(l.admission.howToJoin)}</p>`);
            }
            if (l.rules) {
                parts.push(`<h2>Rules</h2><p class="pre">${esc(l.rules)}</p>`);
            }
            const others = l.endpoints.filter(e => 'web' !== e.protocol);
            if (others.length) {
                parts.push(
                    `<h2>Other ways to connect</h2><ul>${others
                        .map(e => `<li>${esc(e.protocol)}: <code>${esc(e.uri)}</code></li>`)
                        .join('')}</ul>`
                );
            }
        }
        return parts.join('\n');
    }

    function hoursText(l: Listing): string {
        if (!l.hours) {
            return '';
        }
        const weekly = l.hours.weekly.map(w => `${w.days.join(', ')} ${w.from} to ${w.to}`).join('; ');
        const zone = l.hours.timezone ? ` (${l.hours.timezone})` : '';
        return [weekly ? `Usually up ${weekly}${zone}` : '', l.hours.note].filter(Boolean).join('. ');
    }

    //  The directory: this hub's BBSes first, then others on the network
    function directoryPage(who: WebSession | null): string {
        const directory = deps.directory;
        const ratings = config.directory.ratings;
        const ours = registry
            .list()
            .filter(b => 'active' === b.state)
            .map(bbs => ({ bbs, entry: directory?.forBbs(bbs) ?? null }))
            .filter(({ bbs, entry }) => {
                //  a BBS whose listing has a rating this hub doesn't show stays out
                const raw = bbs.bbsDid ? directory?.entry(bbs.bbsDid) : null;
                return !(raw?.bbs && !ratings.includes(raw.listing.rating)) && (entry || !raw?.bbs);
            })
            .sort(
                (a, b) =>
                    Number(b.bbs.connected) - Number(a.bbs.connected) || a.bbs.name.localeCompare(b.bbs.name)
            );
        const card = ({ bbs, entry }: { bbs: Bbs; entry: DirectoryEntry | null }) => `<article>
<h3><a href="${esc(hubUrl(`${bbs.name}.${config.domain}`))}/">${esc(
            entry?.listing.name ?? bbs.name
        )}</a> <span class="dim">${bbs.connected ? 'online' : 'offline'}</span></h3>
${entry ? listingDetails(entry, true) : ''}
</article>`;
        const others =
            directory && 'network' === config.directory.scope
                ? directory
                      .entries()
                      .filter(e => !e.bbs)
                      .sort((a, b) => a.listing.name.localeCompare(b.listing.name))
                : [];
        const otherCard = (e: DirectoryEntry) => {
            const web = e.listing.endpoints.find(x => 'web' === x.protocol);
            return `<article>
<h3>${web ? `<a href="${esc(web.uri)}" rel="nofollow noopener">${esc(e.listing.name)}</a>` : esc(e.listing.name)}</h3>
${listingDetails(e, true)}
${e.listing.endpoints
    .filter(x => 'web' !== x.protocol)
    .map(x => `<p class="dim">${esc(x.protocol)}: <code>${esc(x.uri)}</code></p>`)
    .join('')}
</article>`;
        };
        const join = who
            ? `<p>${profiles ? '<a href="/space">Who&#39;s around</a> · <a href="/me">Your profile</a> · ' : ''}<a href="/bbs">Your BBSes</a></p>`
            : profiles
              ? '<p><a href="/signin">Sign in</a> to take part in the common space, or to register your BBS.</p>'
              : '<p>Run a BBS? <a href="/signin">Register it on this hub</a>.</p>';
        return page(
            `${config.domain}`,
            `${join}
<h2>BBSes on this hub</h2>
${ours.length ? ours.map(card).join('\n') : '<p class="dim">None yet.</p>'}
${
    others.length
        ? `<h2>Elsewhere on the network</h2>
<p class="hint">Listed by their own accounts, and not checked by this hub.</p>
${others.map(otherCard).join('\n')}`
        : ''
}`,
            who ?? undefined
        );
    }

    //  A BBS account given as a handle or DID, as a DID; empty for none
    async function accountDid(value: string): Promise<string | null> {
        const v = value.replace(/^@/, '').trim();
        if (!v) {
            return null;
        }
        if (isDid(v)) {
            return v;
        }
        if (!HandleRe.test(v) || v.length > 253) {
            throw new HubError('bad-account', `"${value}" isn't a handle or DID.`);
        }
        if (!deps.at) {
            throw new HubError('bad-account', 'Give the account as a DID (did:plc:...).');
        }
        try {
            return await deps.at.resolveHandle(v);
        } catch (e) {
            throw new HubError('bad-account', `Couldn't confirm the account ${v}: ${(e as Error).message}`);
        }
    }

    async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const label = labelForHost(req.headers.host, config.domain);
        if (label) {
            return bbsSite(req, res, label, (req.url ?? '/').split('?')[0] ?? '/');
        }
        const url = new URL(req.url ?? '/', config.site.publicUrl);
        const token = cookies(req)[Cookie];
        const who = signin.session(token);
        const path = url.pathname;

        if ('POST' === req.method && '/api/bbs/presence' === path) {
            return presenceReport(req, res);
        }
        if ('POST' === req.method && '/api/bbs/chat/token' === path) {
            return doorChatToken(req, res, url);
        }
        if ('GET' === req.method && '/api/bbs/chat/people' === path) {
            return doorChatPeople(req, res, url);
        }

        if ('POST' === req.method) {
            //  forms are only accepted from the hub's own pages
            if (req.headers.origin !== config.site.publicUrl) {
                return send(res, 403, page('Not allowed', '<p>That form came from somewhere else.</p>'));
            }
            const form = await readForm(req);

            if ('/space/chat/token' === path) {
                return chatToken(res, who);
            }

            if ('/signin' === path) {
                const handle = (form.get('handle') ?? '').trim().replace(/^@/, '');
                if (!HandleRe.test(handle) || handle.length > 253) {
                    return send(
                        res,
                        400,
                        landing('That doesn\'t look like a handle, such as "you.bsky.social".')
                    );
                }
                if (!signinLimit.allow(clientAddress(req))) {
                    return send(res, 429, landing('Too many sign-in attempts. Try again in a few minutes.'));
                }
                try {
                    return redirect(res, await signin.start(handle));
                } catch (e) {
                    log(`signin start failed for ${handle}: ${(e as Error).message}`);
                    return send(
                        res,
                        400,
                        landing(`Couldn't start signing in as ${handle}. Check the handle and try again.`)
                    );
                }
            }

            if ('/signout' === path) {
                signin.endSession(token);
                chat?.sweep();
                live?.tick();
                return redirect(res, '/', { 'Set-Cookie': sessionCookie('', 0) });
            }

            if (!who) {
                return redirect(res, '/signin');
            }

            if (presence && '/me/bbs' === path) {
                const name = (form.get('bbs') ?? '').trim().toLowerCase();
                const answer = form.get('answer');
                if (
                    ('confirmed' !== answer && 'denied' !== answer) ||
                    !presence.memberships(who.did).some(m => m.bbs === name)
                ) {
                    return send(
                        res,
                        400,
                        page('Not understood', '<p>That form was not understood.</p>', who)
                    );
                }
                if (!changeLimit.allow(who.did)) {
                    return send(res, 429, page('Too many changes', '<p>Try again later.</p>', who));
                }
                profiles?.get(who.did) ?? profiles?.signedIn(who);
                presence.answer(who.did, name, answer);
                live?.poke();
                log(`site: ${who.did} ${answer} ${name}`);
                return redirect(res, '/me');
            }

            if (profiles && ('/me/presence' === path || '/me/forget' === path)) {
                if ('/me/forget' === path) {
                    profiles.remove(who.did);
                    chat?.sweep();
                    live?.tick();
                    log(`site: ${who.did} removed their profile`);
                    return redirect(res, '/', { 'Set-Cookie': sessionCookie('', 0) });
                }
                const value = form.get('presence');
                if ('on' !== value && 'off' !== value) {
                    return send(
                        res,
                        400,
                        page('Not understood', '<p>That form was not understood.</p>', who)
                    );
                }
                if (!changeLimit.allow(who.did)) {
                    return send(res, 429, page('Too many changes', '<p>Try again later.</p>', who));
                }
                profiles.get(who.did) ?? profiles.signedIn(who);
                profiles.setPresence(who.did, 'on' === value);
                live?.poke();
                return redirect(res, '/me');
            }

            if ('/bbs' === path) {
                const values = {
                    name: (form.get('name') ?? '').trim().toLowerCase(),
                    webPort: form.get('webPort') ?? '',
                    wsPort: form.get('wsPort') ?? '',
                    bbsAccount: (form.get('bbsAccount') ?? '').trim(),
                };
                if (!config.registration.open) {
                    return send(res, 403, dashboard(who));
                }
                if (!changeLimit.allow(who.did)) {
                    return send(res, 429, dashboard(who, 'Too many changes. Try again later.', values));
                }
                try {
                    const ports = { web: port(values.webPort, 8080), ws: port(values.wsPort, 8810) };
                    const bbsDid = await accountDid(values.bbsAccount);
                    const { bbs, token: bbsToken } = registry.add(values.name, who.did, bbsDid, ports);
                    log(`site: ${who.did} registered ${bbs.name}`);
                    return send(res, 200, credentials(who, bbs, bbsToken, true));
                } catch (e) {
                    if (e instanceof HubError) {
                        return send(res, 400, dashboard(who, e.message, values));
                    }
                    throw e;
                }
            }

            if ('/bbs/rotate' === path || '/bbs/remove' === path || '/bbs/account' === path) {
                const name = (form.get('name') ?? '').trim().toLowerCase();
                const bbs = registry.get(name);
                //  the same answer for "not yours" and "no such BBS"
                if (!bbs || bbs.sysopDid !== who.did) {
                    return send(res, 404, dashboard(who, `You have no BBS called "${name}".`));
                }
                if ('active' !== bbs.state) {
                    return send(res, 403, dashboard(who, `${name} is suspended; ask the hub's admin.`));
                }
                if (!changeLimit.allow(who.did)) {
                    return send(res, 429, dashboard(who, 'Too many changes. Try again later.'));
                }
                if ('/bbs/account' === path) {
                    try {
                        const did = await accountDid((form.get('bbsAccount') ?? '').trim());
                        registry.setBbsDid(name, did);
                        log(`site: ${who.did} set the account of ${name} to ${did ?? '(none)'}`);
                        return redirect(res, '/bbs');
                    } catch (e) {
                        if (e instanceof HubError) {
                            return send(res, 400, dashboard(who, e.message));
                        }
                        throw e;
                    }
                }
                if ('/bbs/rotate' === path) {
                    const fresh = registry.rotateToken(name);
                    log(`site: ${who.did} rotated the token of ${name}`);
                    return send(res, 200, credentials(who, bbs, fresh, false));
                }
                registry.remove(name);
                log(`site: ${who.did} removed ${name}`);
                return redirect(res, '/bbs');
            }

            return send(res, 404, page('Not found', '<p>Nothing here.</p>'));
        }

        if ('GET' !== req.method && 'HEAD' !== req.method) {
            return send(res, 405, page('Not allowed', '<p>Not allowed.</p>'));
        }

        if ('/' === path) {
            return send(res, 200, directoryPage(who));
        }

        if ('/signin' === path) {
            return who ? redirect(res, home) : send(res, 200, landing());
        }

        if (CallbackPath === path) {
            try {
                const identity = await signin.finish(url.searchParams);
                const session = signin.createSession(identity);
                profiles?.signedIn(identity);
                log(`site: signed in ${identity.did}`);
                return redirect(res, home, {
                    'Set-Cookie': sessionCookie(session, SessionDays * 24 * 60 * 60),
                });
            } catch (e) {
                log(`signin callback failed: ${(e as Error).message}`);
                return send(res, 400, landing("Signing in didn't complete. Please try again."));
            }
        }

        if ('/bbs' === path) {
            return who ? send(res, 200, dashboard(who)) : redirect(res, '/signin');
        }

        if (chat && ChatScriptPath === path) {
            res.writeHead(200, {
                'Content-Type': 'text/javascript; charset=utf-8',
                'Cache-Control': 'no-cache',
                'X-Content-Type-Options': 'nosniff',
            });
            return void res.end('HEAD' === req.method ? undefined : ChatScript);
        }

        if (chat && '/space/chat/people' === path) {
            return chatPeople(res, who, url);
        }

        if (chat && '/space/chat' === path) {
            return who ? chatPage(res, who) : redirect(res, '/signin');
        }

        if (live && MapScriptPath === path) {
            res.writeHead(200, {
                'Content-Type': 'text/javascript; charset=utf-8',
                'Cache-Control': 'no-cache',
                'X-Content-Type-Options': 'nosniff',
            });
            return void res.end('HEAD' === req.method ? undefined : MapScript);
        }

        if ('/space' === path && presence) {
            return who ? send(res, 200, spacePage(who), spaceHeaders(who)) : redirect(res, '/signin');
        }

        if ('/me' === path && profiles) {
            if (!who) {
                return redirect(res, '/signin');
            }
            return send(res, 200, profilePage(who, profiles.get(who.did) ?? profiles.signedIn(who)));
        }

        return send(res, 404, page('Not found', '<p>Nothing here.</p>'));
    }

    const server = createServer((req, res) => {
        handle(req, res).catch(e => {
            log(`site error: ${(e as Error).message}`);
            if (!res.headersSent) {
                send(
                    res,
                    e instanceof HubError ? 400 : 500,
                    page('Something went wrong', '<p>Please try again.</p>')
                );
            }
        });
    });
    //  The chat connection and the live model: only from the hub's own pages,
    //  for someone signed in. chat.ts and live.ts check the join rule
    if (chat || live) {
        live?.start();
        server.on('close', () => live?.stop());
        server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
            const refuse = (status: number) => {
                socket.on('error', () => {});
                socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
            };
            try {
                const url = new URL(req.url ?? '/', config.site.publicUrl);
                //  a BBS's door, for one of its members (F19)
                if (!labelForHost(req.headers.host, config.domain) && url.pathname.startsWith('/api/bbs/')) {
                    const forLive = live && '/api/bbs/live' === url.pathname;
                    const forChat = chat && BbsChatPath === url.pathname;
                    if (!forLive && !forChat) {
                        return refuse(404);
                    }
                    const found = doorFor(req, url);
                    if ('number' === typeof found) {
                        return refuse(found);
                    }
                    const { bbs, door, allowed } = found;
                    let refused: number | null;
                    if (forLive) {
                        refused = live.attachBbs(req, socket, head, door, allowed);
                    } else if (!chat || !door.chat || !door.did) {
                        refused = 403;
                    } else {
                        refused = chat.attach(req, socket, head, {
                            did: door.did,
                            session: `bbs:${bbs.name}`,
                            address: clientAddress(req),
                            //  still the same member, known as themselves
                            valid: allowed,
                        });
                    }
                    if (refused) {
                        refuse(refused);
                    }
                    return;
                }
                const service =
                    chat && ChatPath === url.pathname ? chat : live && LivePath === url.pathname ? live : null;
                if (labelForHost(req.headers.host, config.domain) || !service) {
                    return refuse(404);
                }
                if (req.headers.origin !== config.site.publicUrl) {
                    return refuse(403);
                }
                const session = cookies(req)[Cookie];
                const who = signin.session(session);
                if (!who || !session) {
                    return refuse(401);
                }
                const refused = service.attach(req, socket, head, {
                    did: who.did,
                    session,
                    address: clientAddress(req),
                });
                if (refused) {
                    refuse(refused);
                }
            } catch (e) {
                log(`site: WebSocket failed: ${(e as Error).message}`);
                refuse(500);
            }
        });
    }
    server.keepAliveTimeout = 120_000;
    server.headersTimeout = 125_000;
    return server;
}
