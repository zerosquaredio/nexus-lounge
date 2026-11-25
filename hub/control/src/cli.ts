//  The hub admin's command line (H3's minimal form). Changes take effect at
//  once: the server reads the same registry.
//
//  node src/cli.ts [--config FILE] COMMAND ...

import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { HubAccount, HubAccountCallbackPath } from './hub_account.ts';
import { isPublicClient } from './signin.ts';
import { ObservedStatus } from './observed.ts';
import { loadConfig, type HubConfig } from './config.ts';
import { HubError } from './errors.ts';
import { agentConfig, caddyfile, chatCommand, frpsConfig, heartbeatTimeout } from './generate.ts';
import { Registry, type Bbs } from './registry.ts';
import { loadWebTerm } from './webterm.ts';
import { atClient } from './atproto.ts';
import { Directory } from './directory.ts';
import { fetchPublicJson } from './net.ts';
import { isDid } from './rules.ts';
import { describeSubject, Moderation, parseDuration, parseSubject, type Block } from './moderation.ts';
import { Profiles } from './profiles.ts';
import { AbuseKinds, AbuseReports, type AbuseReport } from './abuse.ts';
import { sizeText, Usage as UsageTrends } from './usage.ts';

const Usage = `Usage: node src/cli.ts [--config FILE] COMMAND

BBSes
  add NAME --sysop DID [--did BBS_DID] [--out FILE]
                         register a BBS; prints its token once, and writes
                         its agent config to FILE (or prints it)
  list                   all BBSes, with state and whether connected
  show NAME
  suspend NAME [--reason TEXT]
                         on probation: its tunnel is cut within a minute and
                         new ones refused, until resumed; the reason is shown
                         to its sysop
  resume NAME
  rotate-token NAME [--out FILE]
                         a new token (the old one stops working), and a new
                         agent config
  set-did NAME DID|clear the BBS's own AT account, for its handle
  remove NAME            everything of it is deleted; its name is held for
                         90 days, so nobody else takes it at once
  release NAME           free a removed BBS's name early

Applications (when registration.approval is on, sysops apply on the site)
  applications [--all]   those waiting, oldest first (--all: rejected ones too)
  approve NAME           register it; its sysop gets the agent config on the site
  reject NAME [--reason TEXT]
                         turn it down; the sysop sees the reason for 30 days
  ban DID [--reason TEXT]
                         for good: remove every BBS the DID runs (or is), and
                         refuse it registering another, as sysop or BBS
                         account; the DID stays on the ban list
  unban DID              take it off the list (its BBSes stay removed)
  bans                   the DIDs banned

Generated configs
  agent-config NAME --token TOKEN [--web-port N] [--ws-port N]
  frps-config            the tunnel server's config
  caddyfile              the edge's config
  chat-command [--binary PATH]
                         how to start the chat server (freeq); it needs
                         HUB_CHAT_SECRET set, as the control plane does
  web-terminal-digest    the fingerprint of webTerminal.root, to pin it

The directory
  directory list         every listing the hub holds, and whose BBS it is
  directory hide DID [--reason TEXT]
                         keep an account's listing out of the directory
  directory unhide DID
  directory hidden       the accounts hidden
  directory sweep        fetch every listing now (the hub also does this daily)

The hub's own AT account (it publishes observed status)
  hub-account connect HANDLE
                         prints a link to approve in a browser, then waits
                         for the browser to come back (to the hub's site on
                         an https:// address, else to 127.0.0.1)
  hub-account show
  hub-account disconnect gives the session back and forgets the account
  observed               each BBS: what the hub sees, and what it published

Abuse reports (from the report form on the hub's site, by anyone)
  abuse reports [--all]  open reports (--all: closed ones too)
  abuse report ID        one report in full
  abuse close ID [--outcome TEXT]
                         done with it: what it said, and how to reply, are
                         deleted; what it was about and the outcome stay

Usage (counted while the control plane runs; totals only, no DIDs)
  usage [--days N] [--json]
                         each day: BBSes, people, the space's peaks, reports
                         and blocks; and each BBS's time connected and traffic

The common space: moderation (takes effect within seconds)
  space block WHO [--room] [--for 30m|12h|7d] [--reason TEXT]
                         WHO is a DID, user@bbs (a BBS member without an AT
                         account) or *@bbs (all of that BBS's); from the whole
                         space, or with --room only its chat; for good unless
                         --for. They are told it was the hub's admin, and why
  space unblock ID
  space blocks [--all]   blocks in force (--all: lifted and ended ones too)
  space reports [--all]  open reports (--all: closed ones too)
  space report ID        one report, with what was said in the room
  space close ID [--outcome TEXT]
                         done with it: what was said is let go
  space log [--limit N]  what was done, latest last
`;

//  options that take no value
const Flags = new Set(['room', 'all', 'json']);

//  What others wrote, safe to print to a terminal
function plain(text: string): string {
    return text.replace(/[\p{C}]+/gu, ' ');
}

function describeBlock(b: Block): string {
    const state = b.liftedAt
        ? `lifted ${b.liftedAt}`
        : b.until && Date.parse(b.until) <= Date.now()
          ? `ended ${b.until}`
          : b.until
            ? `until ${b.until}`
            : 'for good';
    return `#${b.id}  ${describeSubject(b.subject)}  ${b.scope}, ${state}${b.reason ? `  "${plain(b.reason)}"` : ''}`;
}

//  Wait for the browser to come back from approving, on 127.0.0.1 only
function awaitCallback(port: number, path: string, timeoutMs: number): Promise<URLSearchParams> {
    return new Promise((resolve, reject) => {
        const server = createServer((req, res) => {
            const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
            if (url.pathname !== path) {
                res.writeHead(404).end();
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(
                'Done. You can close this window and go back to the terminal.\n'
            );
            clearTimeout(timer);
            server.close();
            resolve(url.searchParams);
        });
        const timer = setTimeout(() => {
            server.close();
            reject(new HubError('timeout', 'Nobody came back from approving in time; run it again'));
        }, timeoutMs);
        server.on('error', e => {
            clearTimeout(timer);
            reject(new HubError('listen', `Can't listen on 127.0.0.1:${port}: ${e.message}`));
        });
        server.listen(port, '127.0.0.1');
    });
}

function parse(argv: string[]): { positional: string[]; options: Record<string, string> } {
    const positional: string[] = [];
    const options: Record<string, string> = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i] as string;
        if (arg.startsWith('--') && Flags.has(arg.slice(2))) {
            options[arg.slice(2)] = 'true';
        } else if (arg.startsWith('--')) {
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
        case 'chat-command':
            console.log(chatCommand(config, options.binary));
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
                const bbs = registry.setState(need(positional, 1, 'NAME'), 'suspended', options.reason ?? '');
                new Moderation(registry.db).log('suspend', bbs.name, bbs.stateReason ?? '');
                console.log(describe(bbs, config));
                console.log(
                    '\nIts agent can no longer log in or open proxies, and no new certificate is made.' +
                        `\nAn open tunnel is cut, sessions and all, within ${heartbeatTimeout(config)} seconds, ` +
                        'when its heartbeats are refused.'
                );
                return;
            }
            case 'resume': {
                const bbs = registry.setState(need(positional, 1, 'NAME'), 'active');
                new Moderation(registry.db).log('resume', bbs.name);
                console.log(describe(bbs, config));
                return;
            }
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
                console.log(
                    `Removed ${name}. Its name is held until ${registry.heldUntil(name)?.slice(0, 10)}.`
                );
                return;
            }
            case 'applications': {
                const apps = registry.applications(!!options.all);
                if (!apps.length) {
                    console.log(options.all ? 'No applications.' : 'No applications are waiting.');
                }
                for (const a of apps) {
                    const kind = a.sysopDid.startsWith('did:web:') ? '  (did:web: its age is unknown)' : '';
                    console.log(
                        [
                            `${a.name.padEnd(24)} ${a.createdAt.slice(0, 16).replace('T', ' ')}  ${
                                'rejected' === a.status
                                    ? `rejected${a.reason ? `: ${plain(a.reason)}` : ''}`
                                    : 'waiting'
                            }`,
                            `  sysop    ${a.sysopDid}${kind}`,
                            `  account  ${a.bbsDid ?? '(none given)'}`,
                            a.note ? `  note     ${plain(a.note).replace(/\n/g, '\n           ')}` : '',
                        ]
                            .filter(Boolean)
                            .join('\n')
                    );
                }
                return;
            }
            case 'approve': {
                const bbs = registry.approve(need(positional, 1, 'NAME'));
                new Moderation(registry.db).log('approve', bbs.name, `for ${bbs.sysopDid}`);
                console.log(describe(bbs, config));
                console.log('\nApproved. Its sysop gets its agent config on the hub\'s site ("New token").');
                return;
            }
            case 'reject': {
                const app = registry.reject(need(positional, 1, 'NAME'), options.reason ?? '');
                new Moderation(registry.db).log('reject', app.name, app.reason ?? '');
                console.log(
                    `Rejected the application for ${app.name}${app.reason ? ` (${app.reason})` : ''}.`
                );
                return;
            }
            case 'release': {
                const name = need(positional, 1, 'NAME');
                console.log(registry.release(name) ? `${name} is free again.` : `${name} isn't held.`);
                return;
            }
            case 'ban': {
                const did = need(positional, 1, 'DID');
                const { ban, removed } = registry.banDid(did, options.reason ?? '');
                new Moderation(registry.db).log(
                    'ban',
                    did,
                    [ban.reason, removed.length ? `removed ${removed.join(', ')}` : '']
                        .filter(Boolean)
                        .join('; ')
                );
                console.log(`Banned ${did}${ban.reason ? ` (${ban.reason})` : ''}.`);
                console.log(
                    removed.length
                        ? `Removed ${removed.join(', ')}; their tunnels drop within ${heartbeatTimeout(config)} seconds.`
                        : 'It runs no BBS here.'
                );
                return;
            }
            case 'unban': {
                const did = need(positional, 1, 'DID');
                registry.unbanDid(did);
                new Moderation(registry.db).log('unban', did);
                console.log(`Unbanned ${did}. It may register BBSes again.`);
                return;
            }
            case 'bans': {
                const bans = registry.bans();
                if (!bans.length) {
                    console.log('No bans.');
                }
                for (const b of bans) {
                    console.log(`${b.did}  since ${b.bannedAt}${b.reason ? `  ${b.reason}` : ''}`);
                }
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
            case 'hub-account': {
                const account = new HubAccount(registry.db, config);
                const what = need(positional, 1, 'connect, show or disconnect');
                if ('show' === what) {
                    const info = account.info();
                    console.log(
                        info
                            ? `${info.handle ?? '(no handle)'}  ${info.did}  connected ${info.connectedAt}`
                            : 'No hub account connected.'
                    );
                    return;
                }
                if ('connect' === what) {
                    const handle = need(positional, 2, 'HANDLE');
                    if (isPublicClient(config)) {
                        //  the browser comes back to the site, which finishes;
                        //  watch for the account to change
                        const before = account.info()?.connectedAt ?? null;
                        console.log(
                            `Open this link in a browser, signed in as ${handle}, and approve:\n\n` +
                                `${await account.start(handle)}\n\n` +
                                `The browser comes back to ${config.site.publicUrl}, which connects the account.\n` +
                                `The hub's control plane must be running. Waiting...`
                        );
                        const until = Date.now() + 10 * 60 * 1000;
                        while (Date.now() < until) {
                            await new Promise(r => setTimeout(r, 2000));
                            const info = account.info();
                            if (info && info.connectedAt !== before) {
                                console.log(`Connected: ${info.handle ?? '(no handle)'} ${info.did}`);
                                return;
                            }
                        }
                        throw new HubError(
                            'hub-account',
                            'Gave up after 10 minutes; run it again for a new link'
                        );
                    }
                    const port = config.hubAccount.callbackPort;
                    const back = awaitCallback(port, HubAccountCallbackPath, 10 * 60 * 1000);
                    console.log(
                        `Open this link in a browser, signed in as ${handle}, and approve:\n\n` +
                            `${await account.start(handle)}\n\n` +
                            `The browser comes back to 127.0.0.1:${port}. If this is another machine, forward\n` +
                            `that port first (ssh -L ${port}:127.0.0.1:${port} ...). Waiting...`
                    );
                    const info = await account.finish(await back);
                    console.log(`Connected: ${info.handle ?? '(no handle)'} ${info.did}`);
                    return;
                }
                if ('disconnect' === what) {
                    const info = await account.disconnect();
                    console.log(info ? `Disconnected ${info.did}.` : 'No hub account was connected.');
                    return;
                }
                throw new HubError('usage', `Unknown hub-account command "${what}"\n\n${Usage}`);
            }
            case 'abuse': {
                const reports = new AbuseReports(registry.db);
                const what = need(positional, 1, 'reports, report or close');
                const about = (r: AbuseReport) => (r.bbs ? `${r.bbs}.${config.domain}` : 'the hub');
                const line = (r: AbuseReport) =>
                    `${String(r.id).padEnd(5)} ${r.createdAt.slice(0, 16).replace('T', ' ')}  ${about(r).padEnd(30)} ` +
                    `${AbuseKinds[r.kind]}${r.closedAt ? `  (closed: ${plain(r.outcome ?? '')})` : ''}`;
                const id = () => {
                    const n = Number(need(positional, 2, 'ID'));
                    if (!Number.isInteger(n) || n < 1) {
                        throw new HubError('usage', 'ID is a report number');
                    }
                    return n;
                };
                if ('reports' === what) {
                    const all = reports.list(!!options.all);
                    if (!all.length) {
                        console.log(options.all ? 'No abuse reports.' : 'No open abuse reports.');
                    }
                    all.forEach(r => console.log(line(r)));
                    return;
                }
                if ('report' === what) {
                    const r = reports.mustGet(id());
                    console.log(
                        [
                            line(r),
                            `  from     ${r.reporter ?? (r.closedAt ? '(deleted)' : '(not signed in)')}`,
                            `  reply to ${r.contact ? plain(r.contact) : r.closedAt ? '(deleted)' : '(none given)'}`,
                            '',
                            r.details ? plain(r.details) : '(deleted when it was closed)',
                        ].join('\n')
                    );
                    return;
                }
                if ('close' === what) {
                    console.log(line(reports.close(id(), options.outcome ?? '')));
                    return;
                }
                throw new HubError('usage', `Unknown abuse command "${what}"\n\n${Usage}`);
            }
            case 'usage': {
                const days = Number(options.days ?? 14);
                const { hub, bbses } = new UsageTrends(registry).days(
                    Number.isInteger(days) && days > 0 ? days : 14
                );
                if (options.json) {
                    console.log(JSON.stringify({ hub, bbses }, null, 2));
                    return;
                }
                if (!hub.length && !bbses.length) {
                    console.log('Nothing counted yet: usage is counted while the control plane runs.');
                    return;
                }
                console.log(
                    'day         BBSes (active, most connected)  people (shown, signed in)  map  chat  reports  blocks'
                );
                for (const d of hub) {
                    console.log(
                        `${d.day}  ${`${d.bbsRegistered} (${d.bbsActive}, ${d.bbsConnectedPeak})`.padEnd(31)} ` +
                            `${`${d.people} (${d.presenceOn}, ${d.signedIn})`.padEnd(26)} ` +
                            `${String(d.livePeak).padEnd(4)} ${String(d.chatPeak).padEnd(5)} ` +
                            `${String(d.reports).padEnd(8)} ${d.blocks}`
                    );
                }
                console.log(
                    '\nday         BBS                      connected  in          out         most connections'
                );
                for (const b of bbses) {
                    const hours = (b.connectedSeconds / 3600).toFixed(1);
                    console.log(
                        `${b.day}  ${b.bbs.padEnd(24)} ${`${hours} h`.padEnd(10)} ${sizeText(b.bytesIn).padEnd(11)} ` +
                            `${sizeText(b.bytesOut).padEnd(11)} ${b.connsPeak}`
                    );
                }
                return;
            }
            case 'observed': {
                const observed = new ObservedStatus(
                    registry,
                    new HubAccount(registry.db, config),
                    { nsidPrefix: config.directory.nsidPrefix, settleMs: 0 },
                    () => undefined
                );
                const rows = observed.report();
                if (!rows.length) {
                    console.log('No BBS has a DID set, so there is nothing to publish.');
                }
                for (const { observation: o, published: p } of rows) {
                    const now = `${o.connected ? 'connected' : 'disconnected'} since ${o.since}`;
                    const was = p
                        ? `published ${p.connected ? 'connected' : 'disconnected'} at ${p.published_at}`
                        : 'not published';
                    console.log(`${o.name.padEnd(24)} ${now}; ${was}`);
                }
                return;
            }
            case 'space': {
                const moderation = new Moderation(registry.db);
                const what = need(positional, 1, 'block, unblock, blocks, reports, report, close or log');
                const id = (): number => {
                    const n = Number(need(positional, 2, 'ID'));
                    if (!Number.isInteger(n) || n < 1) {
                        throw new HubError('usage', 'An ID is a whole number');
                    }
                    return n;
                };
                if ('block' === what) {
                    const subject = parseSubject(need(positional, 2, 'WHO'));
                    const block = moderation.block(subject, options.room ? 'room' : 'space', {
                        forMs: parseDuration(options.for ?? 'forever'),
                        reason: options.reason ?? '',
                    });
                    console.log(describeBlock(block));
                    return;
                }
                if ('unblock' === what) {
                    console.log(describeBlock(moderation.unblock(id())));
                    return;
                }
                if ('blocks' === what) {
                    const all = moderation.blocks(!!options.all);
                    if (!all.length) {
                        console.log('No blocks.');
                    }
                    all.forEach(b => console.log(describeBlock(b)));
                    return;
                }
                const profiles = new Profiles(registry.db);
                const who = (did: string | null, nick: string) =>
                    did ? (profiles.get(did)?.handle ? `@${profiles.get(did)?.handle}` : did) : `${plain(nick)} (unverified)`;
                if ('reports' === what) {
                    const all = moderation.reports(!!options.all);
                    if (!all.length) {
                        console.log('No reports.');
                    }
                    for (const r of all) {
                        console.log(
                            `#${r.id}  ${r.createdAt}  about ${plain(r.label)}  from ${who(r.reporter.startsWith('did:') ? r.reporter : null, r.reporter)}` +
                                `${r.closedAt ? '  (closed)' : ''}`
                        );
                    }
                    return;
                }
                if ('report' === what) {
                    const r = moderation.mustGetReport(id());
                    console.log(
                        [
                            `Report #${r.id}, ${r.createdAt}${r.closedAt ? `, closed ${r.closedAt}: ${plain(r.outcome ?? '')}` : ''}`,
                            `  about   ${plain(r.label)}`,
                            `  block   ${r.subject ? describeSubject(r.subject) : '(the hub could not tell)'}` +
                                `${r.person.startsWith('person:via:') ? '  (a BBS says this is them; they never confirmed it)' : ''}`,
                            `  from    ${r.reporter.startsWith('did:') ? who(r.reporter, '') : plain(r.reporter)}`,
                            `  note    ${plain(r.note)}`,
                            r.messages.length ? '  said in the room before it:' : '  nothing was said in the room before it',
                            ...r.messages.map(m => `    ${m.time.slice(11, 19)}  ${who(m.did, m.nick)}: ${plain(m.text)}`),
                        ].join('\n')
                    );
                    return;
                }
                if ('close' === what) {
                    const r = moderation.closeReport(id(), options.outcome ?? '');
                    console.log(`Closed report #${r.id}.`);
                    return;
                }
                if ('log' === what) {
                    const limit = Number(options.limit ?? 50);
                    for (const e of moderation.history(Number.isInteger(limit) && limit > 0 ? limit : 50)) {
                        console.log(`${e.at}  ${e.action.padEnd(12)} ${describeSubject(e.subject)}  ${plain(e.detail)}`);
                    }
                    return;
                }
                throw new HubError('usage', `Unknown space command "${what}"\n\n${Usage}`);
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
