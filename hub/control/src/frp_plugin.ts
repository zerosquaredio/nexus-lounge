//  The tunnel server's approval hook (hub plan H2): frps asks before
//  accepting an agent's login and before opening each of its proxies.
//  Anything not explicitly allowed is refused, and when this hook can't be
//  reached frps refuses too (spike H0.2), so it fails closed.
//
//  Request:  { "version": "0.1.0", "op": "Login" | "NewProxy" | ..., "content": {...} }
//  Response: { "reject": false, "unchange": true } or { "reject": true, "reject_reason": "..." }

import type { Registry } from './registry.ts';
import { AllowedLocations } from './rules.ts';

export type Decision = { reject: false; unchange: true } | { reject: true; reject_reason: string };

export const Allow: Decision = { reject: false, unchange: true };

function refuse(reason: string): Decision {
    return { reject: true, reject_reason: reason };
}

//  The operations the hub's frps config sends us
export const Ops = ['Login', 'NewProxy', 'CloseProxy', 'Ping'] as const;

//  NewProxy fields a BBS's proxy may carry. Any other field with a value
//  (load-balancing groups, HTTP auth, host rewriting, routing by user,
//  remote ports, custom domains, ...) is refused, including fields added by
//  later frp versions, which must be reviewed before they are allowed.
const AllowedProxyFields = new Set([
    'user',
    'proxy_name',
    'proxy_type',
    'subdomain',
    'locations',
    //  request headers the agent sets on requests to its own BBS
    'headers',
    'use_encryption',
    'use_compression',
    'bandwidth_limit',
    'bandwidth_limit_mode',
    'metas',
]);

function isEmpty(value: unknown): boolean {
    return (
        null === value ||
        undefined === value ||
        false === value ||
        0 === value ||
        '' === value ||
        (Array.isArray(value) && 0 === value.length) ||
        ('object' === typeof value && !Array.isArray(value) && 0 === Object.keys(value as object).length)
    );
}

type Content = Record<string, unknown>;

function obj(value: unknown): Content {
    return value && 'object' === typeof value && !Array.isArray(value) ? (value as Content) : {};
}

export interface HookEvent {
    op: string;
    bbs: string | null;
    proxy?: string;
    decision: Decision;
}

export interface HookDeps {
    registry: Registry;
    onEvent?: (event: HookEvent) => void;
}

export function decide(op: unknown, rawContent: unknown, deps: HookDeps): Decision {
    const content = obj(rawContent);
    let bbs: string | null = null;
    let proxy: string | undefined;
    let decision: Decision;

    switch (op) {
        case 'Login': {
            //  user and token straight from the agent's login
            bbs = 'string' === typeof content.user ? content.user : null;
            decision = deps.registry.authenticate(content.user, obj(content.metas).token)
                ? Allow
                : refuse('Unknown BBS, wrong token, or suspended');
            break;
        }

        case 'NewProxy': {
            //  the user is the one frps logged in; the token is checked again
            //  so a rotated token or a suspension stops new proxies at once
            const user = obj(content.user);
            bbs = 'string' === typeof user.user ? user.user : null;
            proxy = 'string' === typeof content.proxy_name ? content.proxy_name : undefined;
            const registered = deps.registry.authenticate(user.user, obj(user.metas).token);
            decision = registered
                ? checkProxy(content, registered.name)
                : refuse('Unknown BBS, wrong token, or suspended');
            if (!decision.reject && registered && proxy) {
                deps.registry.proxyOpened(
                    registered.name,
                    proxy,
                    'string' === typeof user.run_id ? user.run_id : null
                );
            }
            break;
        }

        case 'CloseProxy': {
            const user = obj(content.user);
            bbs = 'string' === typeof user.user ? user.user : null;
            proxy = 'string' === typeof content.proxy_name ? content.proxy_name : undefined;
            if (bbs && proxy && deps.registry.get(bbs)) {
                deps.registry.proxyClosed(bbs, proxy);
            }
            decision = Allow;
            break;
        }

        case 'Ping': {
            const user = obj(content.user);
            bbs = 'string' === typeof user.user ? user.user : null;
            decision = deps.registry.authenticate(user.user, obj(user.metas).token)
                ? Allow
                : refuse('Unknown BBS, wrong token, or suspended');
            break;
        }

        default:
            decision = refuse(`Operation ${String(op)} is not handled by this hub`);
    }

    deps.onEvent?.({ op: String(op), bbs, proxy, decision });
    return decision;
}

function checkProxy(content: Content, name: string): Decision {
    for (const [field, value] of Object.entries(content)) {
        if (!AllowedProxyFields.has(field) && !isEmpty(value)) {
            return refuse(`Proxy option ${field} is not allowed`);
        }
    }
    if ('http' !== content.proxy_type) {
        return refuse(`Proxy type ${String(content.proxy_type)} is not allowed; only http`);
    }
    if (content.subdomain !== name) {
        return refuse(`Subdomain ${String(content.subdomain)} is not this BBS's (${name})`);
    }
    const locations = content.locations;
    if (!Array.isArray(locations) || 0 === locations.length) {
        return refuse('A proxy must list the paths it serves');
    }
    for (const location of locations) {
        if ('string' !== typeof location || !AllowedLocations.includes(location)) {
            return refuse(`Path ${String(location)} is not one a BBS may serve`);
        }
    }
    return Allow;
}
