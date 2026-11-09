//  Runs the control plane: node src/main.ts [config.json]

import { loadConfig } from './config.ts';
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

const site = createSite({
    config,
    registry,
    signin: new SignIn(registry.db, config),
    webterm,
    directory,
    at,
    log,
});
site.listen(config.site.port, config.site.host, () => {
    log(`hub site on ${config.site.host}:${config.site.port}, for ${config.site.publicUrl}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
        stream?.stop();
        site.close();
        server.close(() => {
            registry.close();
            process.exit(0);
        });
    });
}
