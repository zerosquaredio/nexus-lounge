//  Runs the control plane: node src/main.ts [config.json]

import { dirname, join } from 'node:path';
import { Chat, ChatSecretEnv, MinChatSecret } from './chat.ts';
import { FrpsAdminPasswordEnv, loadConfig } from './config.ts';
import { HubAccount } from './hub_account.ts';
import { checkTunnels, ObservedStatus, type TunnelCheck } from './observed.ts';
import { Usage } from './usage.ts';
import { Registry } from './registry.ts';
import { createControlServer } from './server.ts';
import { isPublicClient, SignIn } from './signin.ts';
import { createSite } from './site.ts';
import { loadWebTerm } from './webterm.ts';
import { AssetLibrary } from './assets.ts';
import { BoardArt } from './board_art.ts';
import { atClient } from './atproto.ts';
import { Directory } from './directory.ts';
import { followStream } from './jetstream.ts';
import { fetchPublicJson } from './net.ts';

const config = loadConfig(process.argv[2] ?? process.env.HUB_CONFIG);
const registry = new Registry(config.database, config.registration);
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

const server = createControlServer({ config, registry, log });
server.listen(config.control.port, config.control.host, () => {
    log(`hub control for ${config.domain} on ${config.control.host}:${config.control.port}`);
});

const webterm = config.webTerminal.root
    ? loadWebTerm(config.webTerminal.root, config.webTerminal.digest || undefined)
    : null;
if (webterm) {
    log(`web terminal from ${config.webTerminal.root}, fingerprint ${webterm.digest}`);
}
const at = atClient(fetchPublicJson, config.directory.relay);
const directory = config.directory.enabled ? new Directory(registry, config) : null;
let stream: { stop(): void } | null = null;
if (directory) {
    //  sweep at first start, after a long time away (longer than the stream
    //  keeps), and daily; the stream brings changes in between
    const dayMs = 24 * 60 * 60 * 1000;
    const lastSweep = Date.parse(directory.getState('lastSweep') ?? '') || 0;
    const cursorUs = Number(directory.getState('cursor') ?? 0);
    const sweep = () =>
        directory.sweep(at, log).catch(e => log(`directory: sweep failed: ${(e as Error).message}`));
    if (Date.now() - lastSweep > dayMs || Date.now() - cursorUs / 1000 > 12 * 60 * 60 * 1000) {
        log('directory: sweeping the network in the background');
        void sweep();
    }
    setInterval(sweep, dayMs).unref();
    stream = followStream(directory, log);
}

//  observed status (H6): check the tunnels, then publish what changed
const account = new HubAccount(registry.db, config);
const observed = config.observedStatus.enabled
    ? new ObservedStatus(
          registry,
          account,
          {
              nsidPrefix: config.directory.nsidPrefix,
              settleMs: config.observedStatus.settleSeconds * 1000,
          },
          log
      )
    : null;
const adminPassword = process.env[FrpsAdminPasswordEnv] ?? '';
if (!adminPassword) {
    log(`tunnels: ${FrpsAdminPasswordEnv} isn't set, so the tunnel server's own view isn't checked`);
}
//  usage trends (H8), counted from the same check
const usage = new Usage(registry);
let tunnels: TunnelCheck | 'unchecked' = 'unchecked';
let checking = false;
const check = async () => {
    if (checking) {
        return;
    }
    checking = true;
    try {
        if (adminPassword) {
            tunnels = await checkTunnels(
                registry,
                {
                    port: config.tunnel.adminPort,
                    password: adminPassword,
                    onProxies: proxies => usage.traffic(proxies),
                },
                log
            );
        }
        try {
            usage.sample({ live: site.liveViewers(), chat: chat?.links.size ?? 0 });
        } catch (e) {
            log(`usage: ${(e as Error).message}`);
        }
        await observed?.publish();
    } catch (e) {
        log(`observed status: ${(e as Error).message}`);
    } finally {
        checking = false;
    }
};
const checkTimer = setInterval(check, config.observedStatus.intervalSeconds * 1000);

//  chat (H15), if it's on and has its secret
let chat: Chat | null = null;
if (config.space.chat.enabled) {
    const secret = process.env[ChatSecretEnv] ?? '';
    if (secret.length >= MinChatSecret) {
        chat = new Chat(config, secret, log);
    } else {
        log(`chat: off, because ${ChatSecretEnv} isn't set to ${MinChatSecret} characters or more`);
    }
}

const signin = new SignIn(registry.db, config);
if (isPublicClient(config)) {
    //  load (or make) the signing key now, so a problem shows at start
    signin.getClient().then(
        () => log(`public sign-in client: ${config.site.publicUrl}`),
        e => log(`public sign-in client failed: ${(e as Error).message}`)
    );
}
//  art the hub offers (assets spec, a first slice): checked as it loads
let art: AssetLibrary | null = null;
if (config.assets.library) {
    try {
        art = AssetLibrary.load(config.assets.library, log);
    } catch (e) {
        log(`assets: can't load ${config.assets.library}: ${(e as Error).message}`);
    }
}
//  BBSes' own splash screens, from those the hub takes them from (F21)
let boardArt: BoardArt | null = null;
if (config.assets.boardArt.length) {
    try {
        boardArt = new BoardArt(
            {
                config,
                list: () => registry.list(),
                artOf: (bbs, kind) => directory?.forBbs(bbs)?.listing[kind] ?? null,
                log,
                at: atClient(fetchPublicJson, config.directory.relay),
                linked: bbs => !!directory?.forBbs(bbs),
            },
            join(dirname(config.database), 'board-art')
        );
        const take = () => void boardArt?.refresh().catch(e => log(`board art: ${(e as Error).message}`));
        setTimeout(take, 5_000).unref();
        setInterval(take, 60_000).unref();
        //  the art they publish from their accounts, less often
        const read = () =>
            void boardArt?.refreshPieces().catch(e => log(`board art: ${(e as Error).message}`));
        setTimeout(read, 20_000).unref();
        setInterval(read, 10 * 60_000).unref();
    } catch (e) {
        log(`board art: off: ${(e as Error).message}`);
    }
}
for (const [bbs, piece] of Object.entries(config.assets.splashes)) {
    if (!art?.find(piece)) {
        log(`assets: no art named ${piece} for ${bbs}'s splash; its pages go without`);
    }
}
const site = createSite({
    config,
    registry,
    signin,
    //  a public client finishes connecting the hub's account on the site
    hubAccount: isPublicClient(config) ? account : null,
    webterm,
    directory,
    at,
    chat,
    art,
    boardArt,
    tunnels: () => tunnels,
    log,
});
site.listen(config.site.port, config.site.host, () => {
    log(`hub site on ${config.site.host}:${config.site.port}, for ${config.site.publicUrl}`);
    chat?.start();
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
        stream?.stop();
        chat?.stop();
        clearInterval(checkTimer);
        site.close();
        server.close(() => {
            registry.close();
            process.exit(0);
        });
    });
}
