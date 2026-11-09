//  Fetching from addresses other people choose (account servers named in DID
//  documents, did:web hosts, handles): only public https:// servers, checked
//  at the moment of connecting so DNS can't be switched under us, with
//  limits on size and time.

import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { HubError } from './errors.ts';

function v4Private(ip: string): boolean {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    return (
        0 === a ||
        10 === a ||
        127 === a ||
        (100 === a && b >= 64 && b <= 127) ||
        (169 === a && 254 === b) ||
        (172 === a && b >= 16 && b <= 31) ||
        (192 === a && 0 === b) ||
        (192 === a && 168 === b) ||
        (198 === a && (18 === b || 19 === b)) ||
        a >= 224
    );
}

//  Is this address on the public internet?
export function isPublicAddress(ip: string): boolean {
    const kind = isIP(ip);
    if (4 === kind) {
        return !v4Private(ip);
    }
    if (6 === kind) {
        const lower = ip.toLowerCase();
        const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
        if (mapped) {
            return !v4Private(mapped[1] as string);
        }
        return !(
            '::' === lower ||
            '::1' === lower ||
            /^f[cd]/.test(lower) || //  unique local
            /^fe[89ab]/.test(lower) || //  link local
            /^ff/.test(lower) || //  multicast
            lower.startsWith('64:ff9b:') || //  NAT64, could reach private v4
            lower.startsWith('2001:db8:')
        );
    }
    return false;
}

type LookupCallback = (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number
) => void;

//  A DNS lookup that refuses non-public answers
function publicLookup(hostname: string, options: { all?: boolean }, cb: LookupCallback): void {
    dnsLookup(hostname, { all: true }, (err, addresses) => {
        if (err) {
            return cb(err, []);
        }
        const bad = addresses.find(a => !isPublicAddress(a.address));
        if (bad || 0 === addresses.length) {
            const e = new Error(`${hostname} is not a public address`) as NodeJS.ErrnoException;
            e.code = 'ENOTPUBLIC';
            return cb(e, []);
        }
        if (options.all) {
            return cb(null, addresses);
        }
        const first = addresses[0] as LookupAddress;
        cb(null, first.address, first.family);
    });
}

export interface FetchOptions {
    maxBytes?: number;
    timeoutMs?: number;
    //  return the body as text instead of parsing it as JSON
    text?: boolean;
}

export type JsonFetcher = (url: string, options?: FetchOptions) => Promise<unknown>;

//  GET a JSON document from a public https:// server
export const fetchPublicJson: JsonFetcher = (url, options = {}) => {
    const maxBytes = options.maxBytes ?? 64 * 1024;
    const timeoutMs = options.timeoutMs ?? 10_000;
    let target: URL;
    try {
        target = new URL(url);
    } catch {
        return Promise.reject(new HubError('fetch', `Not a URL: ${url}`));
    }
    if ('https:' !== target.protocol || target.username || target.password) {
        return Promise.reject(new HubError('fetch', `Only plain https:// addresses: ${url}`));
    }
    const host = target.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && !isPublicAddress(host)) {
        return Promise.reject(new HubError('fetch', `${host} is not a public address`));
    }
    return new Promise((resolve, reject) => {
        const req = request(
            target,
            {
                method: 'GET',
                lookup: publicLookup as never,
                headers: {
                    Accept: options.text ? 'text/plain' : 'application/json',
                    'User-Agent': 'nexus-lounge-hub',
                },
                timeout: timeoutMs,
            },
            res => {
                if (200 !== res.statusCode) {
                    res.resume();
                    return reject(new HubError('fetch', `${url}: HTTP ${res.statusCode}`));
                }
                let size = 0;
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => {
                    size += chunk.length;
                    if (size > maxBytes) {
                        req.destroy(new HubError('fetch', `${url}: more than ${maxBytes} bytes`));
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on('end', () => {
                    const body = Buffer.concat(chunks).toString('utf8');
                    if (options.text) {
                        return resolve(body);
                    }
                    try {
                        resolve(JSON.parse(body));
                    } catch {
                        reject(new HubError('fetch', `${url}: not JSON`));
                    }
                });
                res.on('error', reject);
            }
        );
        req.on('timeout', () => req.destroy(new HubError('fetch', `${url}: timed out`)));
        req.on('error', reject);
        req.end();
    });
};
