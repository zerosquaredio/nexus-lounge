//  Runs the control plane: node src/main.ts [config.json]

import { loadConfig } from './config.ts';
import { Registry } from './registry.ts';
import { createControlServer } from './server.ts';
import { SignIn } from './signin.ts';
import { createSite } from './site.ts';

const config = loadConfig(process.argv[2] ?? process.env.HUB_CONFIG);
const registry = new Registry(config.database, config.registration);
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

const server = createControlServer({ config, registry, log });
server.listen(config.control.port, config.control.host, () => {
    log(`hub control for ${config.domain} on ${config.control.host}:${config.control.port}`);
});

const site = createSite({ config, registry, signin: new SignIn(registry.db, config), log });
site.listen(config.site.port, config.site.host, () => {
    log(`hub site on ${config.site.host}:${config.site.port}, for ${config.site.publicUrl}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
        site.close();
        server.close(() => {
            registry.close();
            process.exit(0);
        });
    });
}
