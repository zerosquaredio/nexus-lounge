//  The hub's own site (hub plan H3): sysops sign in with AT and register
//  their BBSes. Served behind the edge, at the hub's own domain.
//
//  GET  /                 sign in, or go to your BBSes
//  POST /signin           start AT sign-in
//  GET  /oauth/callback   the account host sends the browser back here
//  GET  /bbs              your BBSes, and registering a new one
//  POST /bbs              register a BBS: shows its token and agent config, once
//  POST /bbs/rotate       a new token and agent config
//  POST /bbs/remove
//  POST /signout

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { HubConfig } from './config.ts';
import { HubError } from './errors.ts';
import { agentConfig } from './generate.ts';
import { esc, page } from './html.ts';
import type { Bbs, Registry } from './registry.ts';
import type { AtClient } from './atproto.ts';
import type { Directory, DirectoryEntry } from './directory.ts';
import type { Listing } from './listing.ts';
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
    log?: (line: string) => void;
    now?: () => number;
}

const Cookie = 'hub_session';
const MaxForm = 8 * 1024;
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

function readForm(req: IncomingMessage): Promise<URLSearchParams> {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MaxForm) {
                reject(new HubError('too-large', 'That form was too large.'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
        req.on('error', reject);
    });
}

export function createSite(deps: SiteDeps): Server {
    const { config, registry, signin } = deps;
    const log = deps.log ?? (() => {});
    const now = deps.now ?? Date.now;
    const secure = config.site.publicUrl.startsWith('https://');
    const signinLimit = new Limiter(10, 10 * 60 * 1000, now);
    const changeLimit = new Limiter(10, 60 * 60 * 1000, now);

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
        return page(
            'Register your BBS',
            `<p>Run a BBS? Register it here, and it gets an address under
<code>${esc(config.domain)}</code>, reachable from anywhere without opening any ports.</p>
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
            `${list}${add}${account}${remove}<p><a href="/">The directory</a></p>`,
            who
        );
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
            ? '<p><a href="/bbs">Your BBSes</a></p>'
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

        if ('POST' === req.method) {
            //  forms are only accepted from the hub's own pages
            if (req.headers.origin !== config.site.publicUrl) {
                return send(res, 403, page('Not allowed', '<p>That form came from somewhere else.</p>'));
            }
            const form = await readForm(req);

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
                return redirect(res, '/', { 'Set-Cookie': sessionCookie('', 0) });
            }

            if (!who) {
                return redirect(res, '/signin');
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
            return who ? redirect(res, '/bbs') : send(res, 200, landing());
        }

        if (CallbackPath === path) {
            try {
                const identity = await signin.finish(url.searchParams);
                const session = signin.createSession(identity);
                log(`site: signed in ${identity.did}`);
                return redirect(res, '/bbs', {
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
    server.keepAliveTimeout = 120_000;
    server.headersTimeout = 125_000;
    return server;
}
