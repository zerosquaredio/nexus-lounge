//  Tunnel tokens: shown once, stored only as a hash

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function newToken(): string {
    return `hub_${randomBytes(32).toString('base64url')}`;
}

export function hashToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function tokenMatches(token: unknown, storedHash: string): boolean {
    if ('string' !== typeof token || !token) {
        return false;
    }
    const a = Buffer.from(hashToken(token), 'hex');
    const b = Buffer.from(storedHash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
}
