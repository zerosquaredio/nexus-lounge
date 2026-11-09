//  The rules shared by the control plane, the tunnel agent's config and the
//  edge's config, kept in one place so they can't drift apart (hub.md §4)

//  Paths a BBS may serve through the hub. frp matches "locations" as
//  prefixes; the edge matches the exact ones exactly.
export const BbsExactPaths = ['/ws', '/peer', '/_enig/signin', '/_enig/signout'] as const;
export const BbsPrefixPaths = ['/_enig/atproto/', '/_enig/handoff/', '/_enig/verify/', '/assets/'] as const;
export const AllowedLocations: readonly string[] = [...BbsExactPaths, ...BbsPrefixPaths];

//  Paths the edge refuses before anything else, since the tunnel passes
//  paths on unchanged (spike H0.2): dot segments, doubled or encoded
//  slashes, backslashes, encoded nulls. Only the path is checked, not the
//  query string. The same pattern in RE2 syntax, for Caddy:
export const OddPathRe2 = '(?i)^[^?]*([.][.]|//|\\x5c|%2e|%2f|%5c|%00)';
const OddPath = /^[^?]*(\.\.|\/\/|\\|%2e|%2f|%5c|%00)/i;

export function isOddPath(rawUri: string): boolean {
    return OddPath.test(rawUri);
}

//  Names in use by the hub itself, or that look official
export const DefaultReservedNames = [
    'www',
    'api',
    'admin',
    'hub',
    'status',
    'mail',
    'help',
    'about',
    'support',
    'abuse',
    'security',
    'root',
    'sysop',
    'login',
    'signin',
    'auth',
    'oauth',
    'pds',
    'assets',
    'static',
    'test',
];

//  A BBS name becomes a DNS label (name.hub.example): lower-case letters,
//  digits and single hyphens, not at either end. "--" is refused anywhere,
//  which also rules out IDN look-alikes ("xn--").
const NameRe = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export function nameProblem(name: string, reserved: readonly string[]): string | null {
    if (!NameRe.test(name) || name.length < 2) {
        return 'Names are 2 to 32 characters: lower-case letters, digits and hyphens, not starting or ending with a hyphen';
    }
    if (name.includes('--')) {
        return 'Names may not contain two hyphens in a row';
    }
    if (reserved.includes(name)) {
        return `"${name}" is reserved`;
    }
    return null;
}

//  The BBS label of a host under the hub's domain ("coolbbs" for
//  coolbbs.hub.example:443), or null. Says nothing about registration.
export function labelForHost(host: string | undefined, domain: string): string | null {
    const name = (host ?? '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
    const suffix = `.${domain}`;
    if (!name.endsWith(suffix)) {
        return null;
    }
    const label = name.slice(0, -suffix.length);
    return label && !label.includes('.') ? label : null;
}

const DidRe = /^did:(?:plc:[a-z2-7]{24}|web:[a-zA-Z0-9.%:-]{1,253})$/;

export function isDid(value: string): boolean {
    return DidRe.test(value);
}
