//  The hub's configuration: a JSON file, merged over these defaults

import { readFileSync } from 'node:fs';
import { DefaultReservedNames } from './rules.ts';
import { HubError } from './errors.ts';

export interface HubConfig {
    //  BBSes get <name>.<domain>; the hub's own pages are at <domain>
    domain: string;
    //  the registry (SQLite)
    database: string;
    //  the control plane's own HTTP listener: frp's hooks, Caddy's
    //  certificate check, and handle verification (through the edge).
    //  Never public.
    control: { host: string; port: number };
    tunnel: {
        //  where agents connect: the address given to sysops
        publicAddr: string;
        //  frps: the address and port agents connect to
        bindAddr: string;
        bindPort: number;
        //  frps: where the edge reaches it (never public)
        vhostHttpPort: number;
    };
    edge: {
        //  "internal": Caddy's own test CA (development); "onDemand": public
        //  certificates, one per registered name, on first use
        tls: 'internal' | 'onDemand';
        bindAddr: string;
        httpPort: number;
        httpsPort: number;
    };
    registration: {
        reservedNames: string[];
        maxBbsPerSysop: number;
    };
}

export const Defaults: HubConfig = {
    domain: 'hub.test',
    database: './data/hub.sqlite',
    control: { host: '127.0.0.1', port: 7200 },
    tunnel: {
        publicAddr: '127.0.0.1',
        bindAddr: '127.0.0.1',
        bindPort: 7000,
        vhostHttpPort: 7080,
    },
    edge: { tls: 'internal', bindAddr: '127.0.0.1', httpPort: 7081, httpsPort: 7443 },
    registration: { reservedNames: DefaultReservedNames, maxBbsPerSysop: 3 },
};

const DomainRe = /^(?=.{1,200}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$/;

export function makeConfig(overrides: Partial<Record<keyof HubConfig, unknown>> = {}): HubConfig {
    const config: HubConfig = {
        domain: (overrides.domain as string) ?? Defaults.domain,
        database: (overrides.database as string) ?? Defaults.database,
        control: { ...Defaults.control, ...(overrides.control as object) },
        tunnel: { ...Defaults.tunnel, ...(overrides.tunnel as object) },
        edge: { ...Defaults.edge, ...(overrides.edge as object) },
        registration: { ...Defaults.registration, ...(overrides.registration as object) },
    };
    if (!DomainRe.test(config.domain)) {
        throw new HubError('config', `"${config.domain}" is not a domain name`);
    }
    if (!['internal', 'onDemand'].includes(config.edge.tls)) {
        throw new HubError('config', 'edge.tls is "internal" or "onDemand"');
    }
    return config;
}

export function loadConfig(path: string | undefined): HubConfig {
    if (!path) {
        return makeConfig();
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
        throw new HubError('config', `Can't read ${path}: ${(e as Error).message}`);
    }
    if (!parsed || 'object' !== typeof parsed || Array.isArray(parsed)) {
        throw new HubError('config', `${path} must hold a JSON object`);
    }
    return makeConfig(parsed as Record<string, unknown>);
}
