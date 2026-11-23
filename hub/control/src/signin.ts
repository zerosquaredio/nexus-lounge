//  Signing in to the hub's site with AT (hub plan H3): who a sysop is.
//
//  The hub asks for the base "atproto" scope only (identity), and signs the
//  AT session out as soon as it knows the DID, so it holds no AT tokens.
//  What it keeps is its own browser session.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { HubConfig } from './config.ts';
import { hashToken, newToken } from './tokens.ts';

export const CallbackPath = '/oauth/callback';
//  served by the site for a public client (an https:// address)
export const ClientMetadataPath = '/oauth/client-metadata.json';
export const JwksPath = '/oauth/jwks.json';
const SigningAlg = 'ES256';
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

//  The OAuth library's stores, in the registry's database. Sign-in and the
//  hub's own account (hub_account.ts) share the state store; their sessions
//  are kept apart, so signing someone in can never sign the hub's account
//  out.
export function oauthStore(
    db: DatabaseSync,
    name: 'oauth_state' | 'oauth_session' | 'hub_oauth_session',
    keyColumn: 'key' | 'did'
) {
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
                db.prepare(`INSERT OR REPLACE INTO ${name} (did, value) VALUES (?, ?)`).run(
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

//  On an https:// address the hub is a public client: account hosts fetch
//  its metadata from the site, and it proves who it is with a signing key.
//  On http://127.0.0.1 (development) it is a loopback client.
export function isPublicClient(config: HubConfig): boolean {
    return config.site.publicUrl.startsWith('https://');
}

export function clientMetadata(config: HubConfig) {
    const base = config.site.publicUrl;
    const redirectUri = `${base}${CallbackPath}`;
    if (isPublicClient(config)) {
        return {
            client_id: `${base}${ClientMetadataPath}`,
            client_name: config.domain,
            client_uri: base,
            redirect_uris: [redirectUri] as [string],
            scope: 'atproto',
            grant_types: ['authorization_code', 'refresh_token'] as ['authorization_code', 'refresh_token'],
            response_types: ['code'] as ['code'],
            application_type: 'web' as const,
            token_endpoint_auth_method: 'private_key_jwt' as const,
            token_endpoint_auth_signing_alg: SigningAlg,
            dpop_bound_access_tokens: true,
            jwks_uri: `${base}${JwksPath}` as `https://${string}`,
        };
    }
    //  a loopback client is identified by its redirect URI and scope alone
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

//  The public client's signing key: read from its file, or made and saved
//  there (readable by the hub's user only) on first start. Losing it only
//  means making a new one; nobody's sign-in depends on it afterwards, since
//  the hub keeps no AT sessions.
async function loadSigningKey(lib: Lib, path: string) {
    let text: string;
    try {
        text = await readFile(path, 'utf8');
    } catch (e) {
        if ('ENOENT' !== (e as NodeJS.ErrnoException).code) {
            throw e;
        }
        const key = await lib.JoseKey.generate([SigningAlg], `hub-${Date.now()}`);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, JSON.stringify(key.privateJwk, null, 4), { mode: 0o600, flag: 'wx' });
        return key;
    }
    return lib.JoseKey.fromJWK(JSON.parse(text));
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
        this.client ??= import('@atproto/oauth-client-node')
            .then(
                async lib =>
                    new lib.NodeOAuthClient({
                        clientMetadata: clientMetadata(this.config),
                        keyset: isPublicClient(this.config)
                            ? [await loadSigningKey(lib, this.config.site.signingKey)]
                            : undefined,
                        stateStore: oauthStore(this.db, 'oauth_state', 'key'),
                        sessionStore: oauthStore(this.db, 'oauth_session', 'did'),
                        requestLock: lib.requestLocalLock,
                    })
            )
            .catch(e => {
                this.client = null; //  try again next time
                throw e;
            });
        return this.client;
    }

    //  What the site serves for a public client: its metadata, and the
    //  public half of its signing key. Null for a loopback client.
    async publicDocuments(): Promise<{ metadata: unknown; jwks: unknown } | null> {
        if (!isPublicClient(this.config)) {
            return null;
        }
        const client = await this.getClient();
        return { metadata: client.clientMetadata, jwks: client.jwks };
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
