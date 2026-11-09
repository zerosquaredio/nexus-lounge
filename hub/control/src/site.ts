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
import { CallbackPath, SessionDays, type Identity, type WebSession } from './signin.ts';

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
            'Nexus Lounge hub',
            `<p>Run a BBS? Register it here, and it gets an address under
<code>${esc(config.domain)}</code>, reachable from anywhere without opening any ports.</p>
${error ? `<p class="error">${esc(error)}</p>` : ''}
<form method="post" action="/signin">
<label for="handle">Sign in with your Bluesky (AT Protocol) handle</label>
<input type="text" id="handle" name="handle" placeholder="you.bsky.social" autocomplete="username" required>
<button>Sign in</button>
</form>
<p class="hint">Signing in only tells the hub who you are. It can't post or read anything in your account,
and it keeps no access to it afterwards.</p>`
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
        return `<tr><td><strong>${esc(bbs.name)}</strong>.${esc(config.domain)}</td><td>${esc(status)}</td><td>${actions}</td></tr>`;
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
<button>Register</button>
</form>`
            : config.registration.open
              ? `<p class="dim">You have ${mine.length} BBSes, the most this hub allows per sysop.</p>`
              : '<p class="dim">This hub registers new BBSes by arrangement with its admin.</p>';
        return page('Your BBSes', `${list}${add}${remove}`, who);
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

    async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
                return redirect(res, '/');
            }

            if ('/bbs' === path) {
                const values = {
                    name: (form.get('name') ?? '').trim().toLowerCase(),
                    webPort: form.get('webPort') ?? '',
                    wsPort: form.get('wsPort') ?? '',
                };
                if (!config.registration.open) {
                    return send(res, 403, dashboard(who));
                }
                if (!changeLimit.allow(who.did)) {
                    return send(res, 429, dashboard(who, 'Too many changes. Try again later.', values));
                }
                try {
                    const ports = { web: port(values.webPort, 8080), ws: port(values.wsPort, 8810) };
                    const { bbs, token: bbsToken } = registry.add(values.name, who.did, null, ports);
                    log(`site: ${who.did} registered ${bbs.name}`);
                    return send(res, 200, credentials(who, bbs, bbsToken, true));
                } catch (e) {
                    if (e instanceof HubError) {
                        return send(res, 400, dashboard(who, e.message, values));
                    }
                    throw e;
                }
            }

            if ('/bbs/rotate' === path || '/bbs/remove' === path) {
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
            return who ? send(res, 200, dashboard(who)) : redirect(res, '/');
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
