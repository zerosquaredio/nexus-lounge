//  The hub admin's command line (H3's minimal form). Changes take effect at
//  once: the server reads the same registry.
//
//  node src/cli.ts [--config FILE] COMMAND ...

import { writeFileSync } from 'node:fs';
import { loadConfig, type HubConfig } from './config.ts';
import { HubError } from './errors.ts';
import { agentConfig, caddyfile, frpsConfig } from './generate.ts';
import { Registry, type Bbs } from './registry.ts';
import { loadWebTerm } from './webterm.ts';
import { atClient } from './atproto.ts';
import { Directory } from './directory.ts';
import { fetchPublicJson } from './net.ts';
import { isDid } from './rules.ts';

const Usage = `Usage: node src/cli.ts [--config FILE] COMMAND

BBSes
  add NAME --sysop DID [--did BBS_DID] [--out FILE]
                         register a BBS; prints its token once, and writes
                         its agent config to FILE (or prints it)
  list                   all BBSes, with state and whether connected
  show NAME
  suspend NAME           refuse its tunnel and new certificates
  resume NAME
  rotate-token NAME [--out FILE]
                         a new token (the old one stops working), and a new
                         agent config
  set-did NAME DID|clear the BBS's own AT account, for its handle
  remove NAME

Generated configs
  agent-config NAME --token TOKEN [--web-port N] [--ws-port N]
  frps-config            the tunnel server's config
  caddyfile              the edge's config
  web-terminal-digest    the fingerprint of webTerminal.root, to pin it

The directory
  directory list         every listing the hub holds, and whose BBS it is
  directory hide DID [--reason TEXT]
                         keep an account's listing out of the directory
  directory unhide DID
  directory hidden       the accounts hidden
  directory sweep        fetch every listing now (the hub also does this daily)
`;

function parse(argv: string[]): { positional: string[]; options: Record<string, string> } {
    const positional: string[] = [];
    const options: Record<string, string> = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i] as string;
        if (arg.startsWith('--')) {
            const value = argv[i + 1];
            if (undefined === value || value.startsWith('--')) {
                throw new HubError('usage', `${arg} needs a value`);
            }
            options[arg.slice(2)] = value;
            i++;
        } else {
            positional.push(arg);
        }
    }
    return { positional, options };
}

function describe(bbs: Bbs, config: HubConfig): string {
    const link = bbs.connected
        ? 'connected'
        : bbs.lastDisconnectedAt
          ? `disconnected since ${bbs.lastDisconnectedAt}`
          : 'never connected';
    return [
        `${bbs.name}.${config.domain}  ${bbs.state}, ${link}`,
        `  sysop     ${bbs.sysopDid}`,
        `  BBS DID   ${bbs.bbsDid ?? '(none)'}`,
        `  ports     web ${bbs.webPort}, WebSocket ${bbs.wsPort} (on its own machine)`,
        `  created   ${bbs.createdAt}`,
    ].join('\n');
}

function giveAgentConfig(
    config: HubConfig,
    bbs: { name: string; webPort?: number; wsPort?: number },
    token: string,
    options: Record<string, string>
): void {
    const text = agentConfig(config, { name: bbs.name, token, webPort: bbs.webPort, wsPort: bbs.wsPort });
    if (options.out) {
        writeFileSync(options.out, text, { mode: 0o600 });
        console.log(`Agent config written to ${options.out}`);
    } else {
        console.log(`\n${text}`);
    }
}

function need(positional: string[], index: number, what: string): string {
    const value = positional[index];
    if (!value) {
        throw new HubError('usage', `Missing ${what}\n\n${Usage}`);
    }
    return value;
}

export async function run(argv: string[]): Promise<void> {
    const { positional, options } = parse(argv);
    const command = positional[0];
    if (!command || 'help' === command) {
        console.log(Usage);
        return;
    }
    const config = loadConfig(options.config ?? process.env.HUB_CONFIG);

    switch (command) {
        case 'frps-config':
            process.stdout.write(frpsConfig(config));
            return;
        case 'caddyfile':
            process.stdout.write(caddyfile(config));
            return;
        case 'web-terminal-digest': {
            if (!config.webTerminal.root) {
                throw new HubError('usage', 'Set webTerminal.root in the config first');
            }
            console.log(loadWebTerm(config.webTerminal.root).digest);
            return;
        }
        case 'agent-config': {
            const name = need(positional, 1, 'NAME');
            if (!options.token) {
                throw new HubError('usage', 'agent-config needs --token (from add or rotate-token)');
            }
            giveAgentConfig(
                config,
                {
                    name,
                    webPort: options['web-port'] ? Number(options['web-port']) : undefined,
                    wsPort: options['ws-port'] ? Number(options['ws-port']) : undefined,
                },
                options.token,
                options
            );
            return;
        }
    }

    const registry = new Registry(config.database, config.registration);
    try {
        switch (command) {
            case 'add': {
                const name = need(positional, 1, 'NAME');
                if (!options.sysop) {
                    throw new HubError('usage', 'add needs --sysop DID');
                }
                const { bbs, token } = registry.add(name, options.sysop, options.did ?? null, {
                    web: options['web-port'] ? Number(options['web-port']) : undefined,
                    ws: options['ws-port'] ? Number(options['ws-port']) : undefined,
                });
                console.log(describe(bbs, config));
                console.log(`\nToken (shown once): ${token}`);
                giveAgentConfig(config, bbs, token, options);
                return;
            }
            case 'list': {
                const all = registry.list();
                if (!all.length) {
                    console.log('No BBSes registered.');
                }
                for (const bbs of all) {
                    console.log(
                        `${bbs.name.padEnd(24)} ${bbs.state.padEnd(10)} ${bbs.connected ? 'connected' : '-'}`
                    );
                }
                return;
            }
            case 'show':
                console.log(describe(registry.mustGet(need(positional, 1, 'NAME')), config));
                return;
            case 'suspend': {
                const bbs = registry.setState(need(positional, 1, 'NAME'), 'suspended');
                console.log(describe(bbs, config));
                console.log(
                    '\nIts agent can no longer log in or open proxies, and no new certificate is made.' +
                        '\nA tunnel already open stays up until it drops; restart the tunnel server to cut it now.'
                );
                return;
            }
            case 'resume':
                console.log(describe(registry.setState(need(positional, 1, 'NAME'), 'active'), config));
                return;
            case 'rotate-token': {
                const name = need(positional, 1, 'NAME');
                const token = registry.rotateToken(name);
                console.log(`New token for ${name} (shown once): ${token}`);
                giveAgentConfig(config, registry.mustGet(name), token, options);
                return;
            }
            case 'set-did': {
                const name = need(positional, 1, 'NAME');
                const did = need(positional, 2, 'DID (or "clear")');
                console.log(describe(registry.setBbsDid(name, 'clear' === did ? null : did), config));
                return;
            }
            case 'remove': {
                const name = need(positional, 1, 'NAME');
                registry.remove(name);
                console.log(`Removed ${name}.`);
                return;
            }
            case 'directory': {
                const directory = new Directory(registry, config);
                const what = need(positional, 1, 'list, hide, unhide, hidden or sweep');
                if ('list' === what) {
                    const all = directory.entries();
                    if (!all.length) {
                        console.log('The directory is empty.');
                    }
                    for (const e of all) {
                        console.log(
                            `${e.did}  ${e.bbs ? `${e.bbs.name} (this hub)` : 'elsewhere'}  ${e.listing.name}`
                        );
                    }
                    return;
                }
                if ('hidden' === what) {
                    for (const h of directory.hidden()) {
                        console.log(`${h.did}  since ${h.hiddenAt}  ${h.reason}`);
                    }
                    return;
                }
                if ('hide' === what || 'unhide' === what) {
                    const did = need(positional, 2, 'DID');
                    if (!isDid(did)) {
                        throw new HubError('bad-did', `"${did}" is not a did:plc or did:web`);
                    }
                    if ('hide' === what) {
                        directory.hide(did, options.reason ?? '');
                        console.log(`${did} is hidden from the directory.`);
                    } else {
                        directory.unhide(did);
                        console.log(
                            `${did} may be listed again; its listing returns with the next change or sweep.`
                        );
                    }
                    return;
                }
                if ('sweep' === what) {
                    await directory.sweep(atClient(fetchPublicJson, config.directory.relay), line =>
                        console.log(line)
                    );
                    return;
                }
                throw new HubError('usage', `Unknown directory command "${what}"\n\n${Usage}`);
            }
            default:
                throw new HubError('usage', `Unknown command "${command}"\n\n${Usage}`);
        }
    } finally {
        registry.close();
    }
}

if (import.meta.main) {
    run(process.argv.slice(2)).catch(e => {
        if (e instanceof HubError) {
            console.error(e.message);
            process.exit(1);
        }
        throw e;
    });
}
