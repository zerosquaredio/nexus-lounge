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
        //  frps's admin API, on 127.0.0.1 only: the control plane asks it
        //  which tunnels are really up. Its password comes from the
        //  HUB_FRPS_ADMIN_PASSWORD environment variable, for both programs
        adminPort: number;
    };
    //  the hub's own AT account, which publishes observed status
    hubAccount: {
        //  connecting it ("hub-account connect") listens here, on
        //  127.0.0.1, for the browser to come back after approving
        callbackPort: number;
    };
    //  what the hub sees of each BBS's tunnel, published from its account
    //  (publishing spec §3.3)
    observedStatus: {
        enabled: boolean;
        //  a change is published once it has held this long, so a tunnel
        //  that drops and comes straight back writes nothing
        settleSeconds: number;
        //  how often the tunnels are checked and changes published
        intervalSeconds: number;
    };
    //  the hub's own web pages (sign-in, registering a BBS), behind the edge
    site: {
        host: string;
        port: number;
        //  the address people use. http://127.0.0.1:<port> (development, on
        //  this machine or through an SSH tunnel) signs in with AT's
        //  loopback client; an https:// address will use a public client
        publicUrl: string;
    };
    //  the web terminal the hub serves for every BBS: a copy of enig-term's
    //  release (its dist/ directory); empty for none. digest pins the
    //  release: print it with "node src/cli.ts web-terminal-digest"
    webTerminal: { root: string; digest: string };
    //  the directory of BBSes, from listings published on the AT network
    directory: {
        enabled: boolean;
        //  "network": every BBS with a listing (this hub's own first);
        //  "hub": only this hub's own BBSes, fetching nothing else
        scope: 'network' | 'hub';
        //  record type names: the development names until they're final
        nsidPrefix: string;
        //  asked which accounts hold listings, for the first sweep
        relay: string;
        //  followed for changes
        jetstream: string;
        //  accounts fetched at once during a sweep
        concurrency: number;
        //  listings shown (hub spec §5.4); mature and adult need age checks
        ratings: string[];
    };
    //  the common space (hub plan H13 to H18): off by default. On, people
    //  who sign in get a profile and can choose to be shown in it
    space: {
        enabled: boolean;
        //  who may join (vision §8.7): "members" of a BBS on this hub, as
        //  the BBS reports them (the default), or "anyone" with an AT account
        join: 'members' | 'anyone';
        //  a waiting period: a member of their BBS for at least this long
        memberDays: number;
        //  BBSes whose listing admits anyone ("open") don't make their
        //  members members here
        excludeOpenBbses: boolean;
        //  BBSes whose members without an AT account are shown, as
        //  alice@coolbbs (vision §6.4); none by default
        vouchedFrom: string[];
        //  a BBS that has sent no report for this long counts as having
        //  nobody on (it reports every minute)
        reportTimeoutSeconds: number;
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
        //  anyone with an AT account may register a BBS on the hub's site;
        //  false: only the admin, from the command line
        open: boolean;
        reservedNames: string[];
        maxBbsPerSysop: number;
    };
}

//  The tunnel server's admin password, for frps and the control plane both:
//  kept out of config files
export const FrpsAdminPasswordEnv = 'HUB_FRPS_ADMIN_PASSWORD';

export const Defaults: HubConfig = {
    domain: 'hub.test',
    database: './data/hub.sqlite',
    control: { host: '127.0.0.1', port: 7200 },
    tunnel: {
        publicAddr: '127.0.0.1',
        bindAddr: '127.0.0.1',
        bindPort: 7000,
        vhostHttpPort: 7080,
        adminPort: 7400,
    },
    hubAccount: { callbackPort: 7220 },
    observedStatus: { enabled: true, settleSeconds: 20, intervalSeconds: 15 },
    site: { host: '127.0.0.1', port: 7210, publicUrl: 'http://127.0.0.1:7210' },
    webTerminal: { root: '', digest: '' },
    directory: {
        enabled: true,
        scope: 'network',
        nsidPrefix: 'nexus.cyberspace.dev',
        relay: 'https://relay1.us-west.bsky.network',
        jetstream: 'wss://jetstream2.us-west.bsky.network/subscribe',
        concurrency: 4,
        ratings: ['general'],
    },
    space: {
        enabled: false,
        join: 'members',
        memberDays: 0,
        excludeOpenBbses: false,
        vouchedFrom: [],
        reportTimeoutSeconds: 180,
    },
    edge: { tls: 'internal', bindAddr: '127.0.0.1', httpPort: 7081, httpsPort: 7443 },
    registration: { open: true, reservedNames: DefaultReservedNames, maxBbsPerSysop: 3 },
};

const DomainRe = /^(?=.{1,200}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$/;

export function makeConfig(overrides: Partial<Record<keyof HubConfig, unknown>> = {}): HubConfig {
    const config: HubConfig = {
        domain: (overrides.domain as string) ?? Defaults.domain,
        database: (overrides.database as string) ?? Defaults.database,
        control: { ...Defaults.control, ...(overrides.control as object) },
        tunnel: { ...Defaults.tunnel, ...(overrides.tunnel as object) },
        hubAccount: { ...Defaults.hubAccount, ...(overrides.hubAccount as object) },
        observedStatus: { ...Defaults.observedStatus, ...(overrides.observedStatus as object) },
        site: { ...Defaults.site, ...(overrides.site as object) },
        webTerminal: { ...Defaults.webTerminal, ...(overrides.webTerminal as object) },
        directory: { ...Defaults.directory, ...(overrides.directory as object) },
        space: { ...Defaults.space, ...(overrides.space as object) },
        edge: { ...Defaults.edge, ...(overrides.edge as object) },
        registration: { ...Defaults.registration, ...(overrides.registration as object) },
    };
    if (!DomainRe.test(config.domain)) {
        throw new HubError('config', `"${config.domain}" is not a domain name`);
    }
    if (!['internal', 'onDemand'].includes(config.edge.tls)) {
        throw new HubError('config', 'edge.tls is "internal" or "onDemand"');
    }
    if ('boolean' !== typeof config.space.enabled || 'boolean' !== typeof config.space.excludeOpenBbses) {
        throw new HubError('config', 'space.enabled and space.excludeOpenBbses are true or false');
    }
    if (!['members', 'anyone'].includes(config.space.join)) {
        throw new HubError('config', 'space.join is "members" or "anyone"');
    }
    if (!(config.space.memberDays >= 0) || !(config.space.reportTimeoutSeconds >= 30)) {
        throw new HubError('config', 'space.memberDays is 0 or more, and reportTimeoutSeconds 30 or more');
    }
    if (
        !Array.isArray(config.space.vouchedFrom) ||
        !config.space.vouchedFrom.every(n => 'string' === typeof n)
    ) {
        throw new HubError('config', 'space.vouchedFrom is a list of BBS names');
    }
    if (!['network', 'hub'].includes(config.directory.scope)) {
        throw new HubError('config', 'directory.scope is "network" or "hub"');
    }
    for (const [what, port] of [
        ['tunnel.adminPort', config.tunnel.adminPort],
        ['hubAccount.callbackPort', config.hubAccount.callbackPort],
    ] as const) {
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new HubError('config', `${what} is a port, 1 to 65535`);
        }
    }
    const { settleSeconds, intervalSeconds } = config.observedStatus;
    if (!(settleSeconds >= 0) || !(intervalSeconds >= 1)) {
        throw new HubError(
            'config',
            'observedStatus.settleSeconds is 0 or more, and intervalSeconds 1 or more'
        );
    }
    let site: URL;
    try {
        site = new URL(config.site.publicUrl);
    } catch {
        throw new HubError('config', `site.publicUrl "${config.site.publicUrl}" is not a URL`);
    }
    if (!('https:' === site.protocol || ('http:' === site.protocol && '127.0.0.1' === site.hostname))) {
        throw new HubError('config', 'site.publicUrl is https://, or http://127.0.0.1 for development');
    }
    config.site.publicUrl = site.origin;
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
