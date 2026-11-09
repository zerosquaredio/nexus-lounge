//  Signing in to the hub's site with AT (hub plan H3): who a sysop is.
//
//  The hub asks for the base "atproto" scope only (identity), and signs the
//  AT session out as soon as it knows the DID, so it holds no AT tokens.
//  What it keeps is its own browser session.

import type { DatabaseSync } from 'node:sqlite';
import type { HubConfig } from './config.ts';
import { HubError } from './errors.ts';
import { hashToken, newToken } from './tokens.ts';

export const CallbackPath = '/oauth/callback';
const StateMaxAgeMs = 60 * 60 * 1000;
export const SessionDays = 7;

//  The AT OAuth library is loaded only when someone signs in
type Lib = typeof import('@atproto/oauth-client-node');
type Client = InstanceType<Lib['NodeOAuthClient']>;

export interface Identity {
    did: string;
    handle: string | null;
}

export interface WebSession extends Identity {
    expiresAt: number;
}

function table(db: DatabaseSync, name: 'oauth_state' | 'oauth_session', keyColumn: 'key' | 'did') {
    return {
        get(key: string) {
            const row = db.prepare(`SELECT value FROM ${name} WHERE ${keyColumn} = ?`).get(key) as
                { value: string } | undefined;
            return row ? JSON.parse(row.value) : undefined;
        },
        set(key: string, value: unknown) {
            if ('oauth_state' === name) {
                db.prepare('DELETE FROM oauth_state WHERE created_at < ?').run(Date.now() - StateMaxAgeMs);
                db.prepare(
                    'INSERT OR REPLACE INTO oauth_state (key, value, created_at) VALUES (?, ?, ?)'
                ).run(key, JSON.stringify(value), Date.now());
            } else {
                db.prepare('INSERT OR REPLACE INTO oauth_session (did, value) VALUES (?, ?)').run(
                    key,
                    JSON.stringify(value)
                );
            }
        },
        del(key: string) {
            db.prepare(`DELETE FROM ${name} WHERE ${keyColumn} = ?`).run(key);
        },
    };
}

export function clientMetadata(config: HubConfig) {
    const base = config.site.publicUrl;
    if (!base.startsWith('http://127.0.0.1')) {
        //  needs the hub's public address, a signing key, and metadata served
        //  at /oauth/client-metadata.json: comes with the public server
        throw new HubError('config', 'Signing in on a public https:// address is not built yet');
    }
    //  a loopback client is identified by its redirect URI and scope alone
    const redirectUri = `${base}${CallbackPath}`;
    return {
        client_id: `http://localhost?redirect_uri=${encodeURIComponent(redirectUri)}&scope=atproto`,
        redirect_uris: [redirectUri] as [string],
        scope: 'atproto',
        grant_types: ['authorization_code', 'refresh_token'] as ['authorization_code', 'refresh_token'],
        response_types: ['code'] as ['code'],
        token_endpoint_auth_method: 'none' as const,
        application_type: 'native' as const,
        dpop_bound_access_tokens: true,
    };
}

export class SignIn {
    db: DatabaseSync;
    config: HubConfig;
    client: Promise<Client> | null = null;
    now: () => number;

    constructor(db: DatabaseSync, config: HubConfig, now: () => number = Date.now) {
        this.db = db;
        this.config = config;
        this.now = now;
    }

    getClient(): Promise<Client> {
        this.client ??= import('@atproto/oauth-client-node').then(
            lib =>
                new lib.NodeOAuthClient({
                    clientMetadata: clientMetadata(this.config),
                    stateStore: table(this.db, 'oauth_state', 'key'),
                    sessionStore: table(this.db, 'oauth_session', 'did'),
                    requestLock: lib.requestLocalLock,
                })
        );
        return this.client;
    }

    //  Where to send the browser to approve. The handle is kept only to
    //  greet them by it afterwards.
    async start(handle: string): Promise<string> {
        const client = await this.getClient();
        const url = await client.authorize(handle, { scope: 'atproto', state: JSON.stringify({ handle }) });
        return url.toString();
    }

    //  The browser came back: who it is
    async finish(params: URLSearchParams): Promise<Identity> {
        const client = await this.getClient();
        const { session, state } = await client.callback(params);
        let handle: string | null = null;
        try {
            const parsed = JSON.parse(state ?? '{}') as { handle?: unknown };
            handle = 'string' === typeof parsed.handle ? parsed.handle.replace(/^@/, '').toLowerCase() : null;
        } catch {
            handle = null;
        }
        const did = session.did;
        //  identity is all the hub needs: give the AT session back
        await session
            .signOut()
            .catch(() => this.db.prepare('DELETE FROM oauth_session WHERE did = ?').run(did));
        return { did, handle };
    }

    //  The hub's own browser session: a random token, of which only a hash
    //  is kept
    createSession(identity: Identity): string {
        const token = newToken();
        this.db.prepare('DELETE FROM web_session WHERE expires_at < ?').run(this.now());
        this.db
            .prepare(
                'INSERT INTO web_session (token_hash, did, handle, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
            )
            .run(
                hashToken(token),
                identity.did,
                identity.handle,
                new Date(this.now()).toISOString(),
                this.now() + SessionDays * 24 * 60 * 60 * 1000
            );
        return token;
    }

    session(token: string | undefined): WebSession | null {
        if (!token) {
            return null;
        }
        const row = this.db
            .prepare('SELECT did, handle, expires_at FROM web_session WHERE token_hash = ?')
            .get(hashToken(token)) as { did: string; handle: string | null; expires_at: number } | undefined;
        if (!row || row.expires_at < this.now()) {
            return null;
        }
        return { did: row.did, handle: row.handle, expiresAt: row.expires_at };
    }

    endSession(token: string | undefined): void {
        if (token) {
            this.db.prepare('DELETE FROM web_session WHERE token_hash = ?').run(hashToken(token));
        }
    }
}
