//  The little of AT the directory needs, over plain HTTPS: where an account's
//  data lives, one record, and which accounts hold a record type.

import { resolveTxt } from 'node:dns/promises';
import { HubError } from './errors.ts';
import type { JsonFetcher } from './net.ts';
import { isDid } from './rules.ts';

export const PlcDirectory = 'https://plc.directory';

type Json = Record<string, unknown>;

function obj(value: unknown): Json {
    return value && 'object' === typeof value && !Array.isArray(value) ? (value as Json) : {};
}

export interface AtClient {
    //  the account's server (PDS), from its DID document
    resolvePds(did: string): Promise<string>;
    getRecord(did: string, collection: string, rkey: string): Promise<{ cid: string; value: unknown } | null>;
    //  one page of the accounts holding a record type, from a relay
    listRepos(collection: string, cursor?: string): Promise<{ dids: string[]; cursor?: string }>;
    resolveHandle(handle: string): Promise<string>;
}

export function atClient(fetchJson: JsonFetcher, relay: string): AtClient {
    async function didDocument(did: string): Promise<Json> {
        if (!isDid(did)) {
            throw new HubError('did', `Not a DID: ${did}`);
        }
        if (did.startsWith('did:plc:')) {
            return obj(await fetchJson(`${PlcDirectory}/${did}`));
        }
        const host = decodeURIComponent(did.slice('did:web:'.length));
        if (host.includes(':') || host.includes('/')) {
            throw new HubError('did', `did:web with a port or path isn't supported: ${did}`);
        }
        return obj(await fetchJson(`https://${host}/.well-known/did.json`));
    }

    return {
        async resolvePds(did) {
            const doc = await didDocument(did);
            if (doc.id !== did) {
                throw new HubError('did', `The DID document isn't for ${did}`);
            }
            const services = Array.isArray(doc.service) ? doc.service : [];
            const pds = services
                .map(obj)
                .find(s => 'string' === typeof s.id && s.id.endsWith('#atproto_pds'));
            const url = pds && 'string' === typeof pds.serviceEndpoint ? pds.serviceEndpoint : '';
            if (!url.startsWith('https://')) {
                throw new HubError('did', `${did} names no https:// account server`);
            }
            return url.replace(/\/+$/, '');
        },

        async getRecord(did, collection, rkey) {
            const pds = await this.resolvePds(did);
            const q = new URLSearchParams({ repo: did, collection, rkey });
            try {
                const reply = obj(
                    await fetchJson(`${pds}/xrpc/com.atproto.repo.getRecord?${q}`, { maxBytes: 32 * 1024 })
                );
                return 'string' === typeof reply.cid ? { cid: reply.cid, value: reply.value } : null;
            } catch (e) {
                if (/HTTP 400|HTTP 404/.test((e as Error).message)) {
                    return null; //  no such record
                }
                throw e;
            }
        },

        async listRepos(collection, cursor) {
            const q = new URLSearchParams({ collection, limit: '500' });
            if (cursor) {
                q.set('cursor', cursor);
            }
            const reply = obj(
                await fetchJson(`${relay}/xrpc/com.atproto.sync.listReposByCollection?${q}`, {
                    maxBytes: 1024 * 1024,
                })
            );
            const dids = (Array.isArray(reply.repos) ? reply.repos : [])
                .map(r => obj(r).did)
                .filter((d): d is string => 'string' === typeof d && isDid(d));
            return {
                dids,
                cursor: 'string' === typeof reply.cursor && reply.cursor ? reply.cursor : undefined,
            };
        },

        //  A handle's DID, by DNS then HTTPS, checked against the DID
        //  document so a handle can't claim an account that doesn't name it
        async resolveHandle(handle) {
            const name = handle.replace(/^@/, '').toLowerCase();
            let did: string | null = null;
            try {
                const txt = (await resolveTxt(`_atproto.${name}`)).map(parts => parts.join(''));
                did = txt.map(t => /^did=(did:\S+)$/.exec(t)?.[1]).find(d => d && isDid(d)) ?? null;
            } catch {
                did = null;
            }
            if (!did) {
                try {
                    const text = await fetchJson(`https://${name}/.well-known/atproto-did`, {
                        text: true,
                        maxBytes: 256,
                    }).catch(() => null);
                    did = 'string' === typeof text && isDid(text.trim()) ? text.trim() : null;
                } catch {
                    did = null;
                }
            }
            if (!did) {
                throw new HubError('handle', `Couldn't find the account for ${name}`);
            }
            const doc = await didDocument(did);
            const aka = Array.isArray(doc.alsoKnownAs) ? doc.alsoKnownAs : [];
            if (!aka.includes(`at://${name}`)) {
                throw new HubError('handle', `${name} isn't confirmed by its account`);
            }
            return did;
        },
    };
}
