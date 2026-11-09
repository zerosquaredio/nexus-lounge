//  The control plane's HTTP listener. Never public: frps and Caddy call it
//  on the hub's own machine, and the edge forwards only handle
//  verification to it.
//
//  POST /frp/handler             the tunnel server's approval hook
//  GET  /tls/allowed?domain=...  Caddy asks before making a certificate
//  GET  /.well-known/atproto-did handle verification for <name>.<domain>
//  GET  /healthz

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { HubConfig } from './config.ts';
import type { Registry } from './registry.ts';
import { decide, type HookEvent } from './frp_plugin.ts';
import { labelForHost } from './rules.ts';

const MaxBody = 64 * 1024;

export interface ServerDeps {
    config: HubConfig;
    registry: Registry;
    log?: (line: string) => void;
}

//  The registered, active BBS a host name belongs to, if any
export function bbsForHost(host: string | undefined, deps: ServerDeps): string | null {
    const label = labelForHost(host, deps.config.domain);
    if (!label) {
        return null;
    }
    const bbs = deps.registry.get(label);
    return bbs && 'active' === bbs.state ? bbs.name : null;
}

function send(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
    res.writeHead(status, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MaxBody) {
                reject(new Error('body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function describe(event: HookEvent): string {
    const what = event.decision.reject ? `REFUSED: ${event.decision.reject_reason}` : 'ok';
    return `frp ${event.op} bbs=${event.bbs ?? '-'}${event.proxy ? ` proxy=${event.proxy}` : ''} ${what}`;
}

export function createControlServer(deps: ServerDeps): Server {
    const log = deps.log ?? (() => {});

    async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = new URL(req.url ?? '/', 'http://control');

        if ('/frp/handler' === url.pathname) {
            if ('POST' !== req.method) {
                return send(res, 405, 'Method not allowed');
            }
            let decision;
            try {
                const body = JSON.parse(await readBody(req)) as { op?: unknown; content?: unknown };
                //  the content carries tokens: never logged
                decision = decide(body.op, body.content, {
                    registry: deps.registry,
                    onEvent: event => {
                        if ('Ping' !== event.op || event.decision.reject) {
                            log(describe(event));
                        }
                    },
                });
            } catch (e) {
                log(`frp request refused: ${(e as Error).message}`);
                decision = { reject: true, reject_reason: 'Bad request' };
            }
            return send(res, 200, JSON.stringify(decision), 'application/json');
        }

        if ('GET' !== req.method && 'HEAD' !== req.method) {
            return send(res, 405, 'Method not allowed');
        }

        if ('/tls/allowed' === url.pathname) {
            const domain = url.searchParams.get('domain') ?? '';
            const ok = domain === deps.config.domain || null !== bbsForHost(domain, deps);
            log(`tls ${domain} ${ok ? 'ok' : 'refused'}`);
            return send(res, ok ? 200 : 404, ok ? 'ok' : 'not registered');
        }

        if ('/.well-known/atproto-did' === url.pathname) {
            const name = bbsForHost(req.headers.host, deps);
            const did = name ? deps.registry.get(name)?.bbsDid : null;
            return did ? send(res, 200, did) : send(res, 404, 'Not found');
        }

        if ('/healthz' === url.pathname) {
            return send(res, 200, 'ok');
        }

        return send(res, 404, 'Not found');
    }

    const server = createServer((req, res) => {
        handle(req, res).catch(e => {
            log(`error: ${(e as Error).message}`);
            if (!res.headersSent) {
                send(res, 500, 'Internal error');
            }
        });
    });
    //  frps and Caddy (Go) keep idle connections for up to 90 seconds and
    //  reuse them. If this side closed them first (Node's default is 5
    //  seconds), a request sent as it closed would fail, and frps would
    //  refuse that agent. So the callers always close first.
    server.keepAliveTimeout = IdleTimeoutMs;
    server.headersTimeout = IdleTimeoutMs + 5_000;
    return server;
}

export const IdleTimeoutMs = 120_000;
