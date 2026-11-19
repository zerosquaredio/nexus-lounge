//  Runs the control plane: node src/main.ts [config.json]

import { Chat, ChatSecretEnv, MinChatSecret } from './chat.ts';
import { FrpsAdminPasswordEnv, loadConfig } from './config.ts';
import { HubAccount } from './hub_account.ts';
import { checkTunnels, ObservedStatus } from './observed.ts';
import { Registry } from './registry.ts';
import { createControlServer } from './server.ts';
import { SignIn } from './signin.ts';
import { createSite } from './site.ts';
import { loadWebTerm } from './webterm.ts';
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
let checking = false;
const check = async () => {
    if (checking) {
        return;
    }
    checking = true;
    try {
        if (adminPassword) {
            await checkTunnels(registry, { port: config.tunnel.adminPort, password: adminPassword }, log);
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

const site = createSite({
    config,
    registry,
    signin: new SignIn(registry.db, config),
    webterm,
    directory,
    at,
    chat,
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
