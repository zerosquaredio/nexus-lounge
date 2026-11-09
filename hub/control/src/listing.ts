//  Listing and status records as published by BBSes (publishing spec §3.1,
//  §3.3). Anyone can publish them, so only known fields are kept, each
//  checked and cut to size; anything else is dropped.

export type Rating = 'general' | 'mature' | 'adult';
export const Ratings: readonly Rating[] = ['general', 'mature', 'adult'];

export interface Endpoint {
    protocol: string;
    uri: string;
}

export interface Listing {
    name: string;
    description: string;
    tags: string[];
    rating: Rating;
    rules: string;
    endpoints: Endpoint[];
    admission: { policy: string[]; howToJoin: string };
    hours: { timezone: string; weekly: { days: string[]; from: string; to: string }[]; note: string } | null;
    sysop: string | null;
    createdAt: string | null;
}

export interface Status {
    state: string;
    message: string;
    until: string | null;
    updatedAt: string | null;
}

type Json = Record<string, unknown>;

function obj(value: unknown): Json {
    return value && 'object' === typeof value && !Array.isArray(value) ? (value as Json) : {};
}

//  one line of plain text: control characters removed, length capped
function text(value: unknown, max: number, multiline = false): string {
    if ('string' !== typeof value) {
        return '';
    }
    const cleaned = value
        .replace(
            multiline ? /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g : /[\u0000-\u001f\u007f-\u009f]/g,
            ' '
        )
        .replace(/[‪-‮⁦-⁩]/g, '') //  no direction overrides
        .trim();
    return Array.from(cleaned).slice(0, max).join('');
}

function words(value: unknown, maxItems: number, maxLength: number, pattern: RegExp): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const seen = new Set<string>();
    for (const item of value) {
        const word = text(item, maxLength).toLowerCase();
        if (pattern.test(word)) {
            seen.add(word);
        }
        if (seen.size >= maxItems) {
            break;
        }
    }
    return [...seen];
}

const EndpointSchemes: Record<string, string[]> = {
    web: ['https:'],
    ssh: ['ssh:'],
    telnet: ['telnet:'],
    wss: ['wss:'],
};

function endpoints(value: unknown): Endpoint[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const out: Endpoint[] = [];
    for (const item of value.slice(0, 16)) {
        const e = obj(item);
        const protocol = text(e.protocol, 16).toLowerCase();
        const uri = text(e.uri, 300);
        let url: URL;
        try {
            url = new URL(uri);
        } catch {
            continue;
        }
        const schemes = EndpointSchemes[protocol];
        if (!schemes || !schemes.includes(url.protocol) || url.username || url.password) {
            continue;
        }
        out.push({ protocol, uri: url.href });
    }
    return out;
}

function datetime(value: unknown): string | null {
    if ('string' !== typeof value || value.length > 40) {
        return null;
    }
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
}

const Days = new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
const Clock = /^([01]\d|2[0-3]):[0-5]\d$/;

function hours(value: unknown): Listing['hours'] {
    const h = obj(value);
    const timezone = text(h.timezone, 64);
    const weekly = (Array.isArray(h.weekly) ? h.weekly : [])
        .slice(0, 14)
        .map(obj)
        .map(w => ({
            days: (Array.isArray(w.days) ? w.days : []).filter(
                (d): d is string => 'string' === typeof d && Days.has(d)
            ),
            from: 'string' === typeof w.from && Clock.test(w.from) ? w.from : '',
            to: 'string' === typeof w.to && Clock.test(w.to) ? w.to : '',
        }))
        .filter(w => w.days.length && w.from && w.to);
    const note = text(h.note, 200);
    if (!weekly.length && !note) {
        return null;
    }
    let zone = '';
    try {
        zone = timezone && Intl.DateTimeFormat(undefined, { timeZone: timezone }) ? timezone : '';
    } catch {
        zone = '';
    }
    return { timezone: zone, weekly, note };
}

export function sanitizeListing(value: unknown): Listing | null {
    const v = obj(value);
    const name = text(v.name, 80);
    if (!name) {
        return null;
    }
    const admission = obj(v.admission);
    const rating = text(v.rating, 16).toLowerCase();
    return {
        name,
        description: text(v.description, 500, true),
        tags: words(v.tags, 10, 32, /^[a-z0-9][a-z0-9 -]{0,31}$/),
        rating: (Ratings as readonly string[]).includes(rating) ? (rating as Rating) : 'general',
        rules: text(v.rules, 2000, true),
        endpoints: endpoints(v.endpoints),
        admission: {
            policy: words(admission.policy, 8, 32, /^[a-z0-9-]+$/),
            howToJoin: text(admission.howToJoin, 300, true),
        },
        hours: hours(v.hours),
        sysop:
            'string' === typeof v.sysop && /^did:[a-z]+:[a-zA-Z0-9._:%-]{1,200}$/.test(v.sysop)
                ? v.sysop
                : null,
        createdAt: datetime(v.createdAt),
    };
}

export function sanitizeStatus(value: unknown): Status | null {
    const v = obj(value);
    const state = text(v.state, 24).toLowerCase();
    if (!/^[a-z][a-z-]*$/.test(state)) {
        return null;
    }
    return {
        state,
        message: text(v.message, 300),
        until: datetime(v.until),
        updatedAt: datetime(v.updatedAt),
    };
}

//  Does this listing name the BBS's address on this hub? (Its owner's side
//  of the link between a registered name and the BBS's account.)
export function pointsAtHub(listing: Listing, name: string, domain: string): boolean {
    const host = `${name}.${domain}`;
    return listing.endpoints.some(e => {
        try {
            return new URL(e.uri).hostname === host;
        } catch {
            return false;
        }
    });
}
