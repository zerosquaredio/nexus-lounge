//  The hub's own AT account (hub plan H6): the account its observed status
//  records are published from.
//
//  Unlike sign-in, the hub keeps this AT session: it asks for the base
//  scope plus writing its own record types, nothing else (no posts, no
//  other records). The admin connects it once, from the command line
//  ("hub-account connect HANDLE"); the control plane then uses it.
//
//  On an https:// address it is a public client of its own, apart from
//  sign-in's so that sign-in never offers to write anything: the site
//  serves its metadata, it signs with the same key as sign-in, and the
//  browser comes back to the site, which finishes connecting. Public
//  clients keep their sessions far longer than loopback ones.
//
//  Development (http://127.0.0.1): a loopback client, the browser coming
//  back to 127.0.0.1:<hubAccount.callbackPort>, where the command waits.

import type { DatabaseSync } from 'node:sqlite';
import type { HubConfig } from './config.ts';
import { HubError } from './errors.ts';
import { isPublicClient, JwksPath, loadSigningKey, oauthStore, SigningAlg } from './signin.ts';

//  the loopback client's, on the command's own port
export const HubAccountCallbackPath = '/callback';
//  the public client's, served by the site
export const HubAccountMetadataPath = '/oauth/hub-account/client-metadata.json';
export const HubAccountWebCallbackPath = '/oauth/hub-account/callback';

type Lib = typeof import('@atproto/oauth-client-node');
type Client = InstanceType<Lib['NodeOAuthClient']>;

export interface HubAccountInfo {
    did: string;
    handle: string | null;
    connectedAt: string;
}

export function observedStatusType(nsidPrefix: string): string {
    return `${nsidPrefix}.hub.observedStatus`;
}

export function hubAccountScope(config: HubConfig): string {
    return ['atproto', `repo:${observedStatusType(config.directory.nsidPrefix)}`].join(' ');
}

export function hubAccountRedirectUri(config: HubConfig): string {
    return isPublicClient(config)
        ? `${config.site.publicUrl}${HubAccountWebCallbackPath}`
        : `http://127.0.0.1:${config.hubAccount.callbackPort}${HubAccountCallbackPath}`;
}

export function hubAccountMetadata(config: HubConfig) {
    const redirectUri = hubAccountRedirectUri(config);
    const scope = hubAccountScope(config);
    if (isPublicClient(config)) {
        const base = config.site.publicUrl;
        return {
            client_id: `${base}${HubAccountMetadataPath}`,
            client_name: `${config.domain}: the hub's own account`,
            client_uri: base,
            redirect_uris: [redirectUri] as [string],
            scope,
            grant_types: ['authorization_code', 'refresh_token'] as ['authorization_code', 'refresh_token'],
            response_types: ['code'] as ['code'],
            application_type: 'web' as const,
            token_endpoint_auth_method: 'private_key_jwt' as const,
            token_endpoint_auth_signing_alg: SigningAlg,
            dpop_bound_access_tokens: true,
            jwks_uri: `${base}${JwksPath}` as `https://${string}`,
        };
    }
    //  a loopback client is identified by its redirect URI and scope alone,
    //  so the control plane, restoring the session, must build the same
    return {
        client_id: `http://localhost?redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}`,
        redirect_uris: [redirectUri] as [string],
        scope,
        grant_types: ['authorization_code', 'refresh_token'] as ['authorization_code', 'refresh_token'],
        response_types: ['code'] as ['code'],
        token_endpoint_auth_method: 'none' as const,
        application_type: 'native' as const,
        dpop_bound_access_tokens: true,
    };
}

//  An error from the account's server, with its HTTP status
export class XrpcError extends Error {
    status: number;
    error: string | undefined;

    constructor(nsid: string, status: number, body: Record<string, unknown>) {
        const detail = 'string' === typeof body.message ? body.message : String(body.error ?? 'no detail');
        super(`${nsid} failed (${status}): ${detail}`);
        this.name = 'XrpcError';
        this.status = status;
        this.error = 'string' === typeof body.error ? body.error : undefined;
    }
}

//  What publishing needs of an account: which it is, and writing records
export interface RecordWriter {
    did(): string | null;
    putRecord(collection: string, rkey: string, record: Record<string, unknown>): Promise<void>;
    deleteRecord(collection: string, rkey: string): Promise<void>;
}

export class HubAccount implements RecordWriter {
    db: DatabaseSync;
    config: HubConfig;
    client: Promise<Client> | null = null;

    constructor(db: DatabaseSync, config: HubConfig) {
        this.db = db;
        this.config = config;
    }

    getClient(): Promise<Client> {
        this.client ??= import('@atproto/oauth-client-node')
            .then(
                async lib =>
                    new lib.NodeOAuthClient({
                        clientMetadata: hubAccountMetadata(this.config),
                        keyset: isPublicClient(this.config)
                            ? [await loadSigningKey(lib, this.config.site.signingKey)]
                            : undefined,
                        stateStore: oauthStore(this.db, 'oauth_state', 'key'),
                        sessionStore: oauthStore(this.db, 'hub_oauth_session', 'did'),
                        requestLock: lib.requestLocalLock,
                    })
            )
            .catch(e => {
                this.client = null; //  try again next time
                throw e;
            });
        return this.client;
    }

    //  A public client's metadata, served by the site; null for a loopback
    //  client (its keys are sign-in's, served there)
    async publicMetadata(): Promise<unknown | null> {
        if (!isPublicClient(this.config)) {
            return null;
        }
        return (await this.getClient()).clientMetadata;
    }

    info(): HubAccountInfo | null {
        const row = this.db
            .prepare('SELECT did, handle, connected_at FROM hub_account WHERE id = 1')
            .get() as { did: string; handle: string | null; connected_at: string } | undefined;
        return row ? { did: row.did, handle: row.handle, connectedAt: row.connected_at } : null;
    }

    did(): string | null {
        return this.info()?.did ?? null;
    }

    //  Where to send the admin's browser to approve
    async start(handle: string): Promise<string> {
        const client = await this.getClient();
        const url = await client.authorize(handle, {
            scope: hubAccountScope(this.config),
            state: JSON.stringify({ handle }),
        });
        return url.toString();
    }

    //  The browser came back: keep the session, and remember the account.
    //  Connecting a different account gives the previous one's session back.
    async finish(params: URLSearchParams): Promise<HubAccountInfo> {
        const client = await this.getClient();
        const { session, state } = await client.callback(params);
        let handle: string | null = null;
        try {
            const parsed = JSON.parse(state ?? '{}') as { handle?: unknown };
            handle = 'string' === typeof parsed.handle ? parsed.handle.replace(/^@/, '').toLowerCase() : null;
        } catch {
            handle = null;
        }
        const previous = this.did();
        if (previous && previous !== session.did) {
            await this.revoke(previous);
        }
        this.db
            .prepare('INSERT OR REPLACE INTO hub_account (id, did, handle, connected_at) VALUES (1, ?, ?, ?)')
            .run(session.did, handle, new Date().toISOString());
        return this.info() as HubAccountInfo;
    }

    async disconnect(): Promise<HubAccountInfo | null> {
        const info = this.info();
        if (info) {
            await this.revoke(info.did);
            this.db.prepare('DELETE FROM hub_account WHERE id = 1').run();
        }
        return info;
    }

    async revoke(did: string): Promise<void> {
        try {
            const client = await this.getClient();
            await (await client.restore(did)).signOut();
        } catch {
            //  already gone, or the server can't be reached: forget it here
        }
        this.db.prepare('DELETE FROM hub_oauth_session WHERE did = ?').run(did);
    }

    async request(nsid: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
        const did = this.did();
        if (!did) {
            throw new HubError('hub-account', 'The hub has no AT account connected ("hub-account connect")');
        }
        const client = await this.getClient();
        const session = await client.restore(did);
        const resp = await session.fetchHandler(`/xrpc/${nsid}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const text = await resp.text();
        let parsed: Record<string, unknown> = {};
        try {
            parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
        } catch {
            parsed = { message: text.slice(0, 200) };
        }
        if (!resp.ok) {
            throw new XrpcError(nsid, resp.status, parsed);
        }
        return parsed;
    }

    async putRecord(collection: string, rkey: string, record: Record<string, unknown>): Promise<void> {
        const repo = this.did() as string;
        await this.request('com.atproto.repo.putRecord', { repo, collection, rkey, record });
    }

    async deleteRecord(collection: string, rkey: string): Promise<void> {
        const repo = this.did() as string;
        await this.request('com.atproto.repo.deleteRecord', { repo, collection, rkey });
    }
}
