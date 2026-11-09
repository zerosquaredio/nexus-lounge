//  Config files generated from the hub's config and rules.ts, so the edge,
//  the tunnel server and every agent agree on names, ports and paths.

import type { HubConfig } from './config.ts';
import { BbsExactPaths, BbsPrefixPaths, OddPathRe2 } from './rules.ts';

function tomlString(value: string): string {
    return JSON.stringify(value); //  a valid TOML basic string for these values
}

function tomlArray(values: readonly string[]): string {
    return `[${values.map(tomlString).join(', ')}]`;
}

export interface AgentOptions {
    name: string;
    token: string;
    //  where ENiGMA½ listens on the BBS's own machine
    localIp?: string;
    webPort?: number;
    wsPort?: number;
}

//  ENiGMA½'s routes that must be reachable through the hub (hub.md §4)
export const EnigmaWebLocations = ['/_enig/atproto/', '/_enig/handoff/', '/_enig/signin', '/_enig/signout'];

//  The tunnel agent's config (frpc), given to the sysop at registration
export function agentConfig(config: HubConfig, options: AgentOptions): string {
    const localIp = options.localIp ?? '127.0.0.1';
    const proxy = (name: string, port: number, locations: readonly string[]) => `
[[proxies]]
name = ${tomlString(name)}
type = "http"
localIP = ${tomlString(localIp)}
localPort = ${port}
subdomain = ${tomlString(options.name)}
locations = ${tomlArray(locations)}
#  the edge took the connection over https; frps would say http
requestHeaders.set.x-forwarded-proto = "https"
`;
    return `#  Tunnel agent (frpc) for ${options.name}.${config.domain}, made by the hub.
#  The token is a password for this BBS on the hub: keep this file private.
serverAddr = ${tomlString(config.tunnel.publicAddr)}
serverPort = ${config.tunnel.bindPort}
user = ${tomlString(options.name)}
metadatas.token = ${tomlString(options.token)}
#  keep trying if the hub is down or restarting
loginFailExit = false
transport.tls.enable = true
${proxy('ws', options.wsPort ?? 8810, ['/ws'])}${proxy('web', options.webPort ?? 8080, EnigmaWebLocations)}`;
}

//  The tunnel server's config (frps)
export function frpsConfig(config: HubConfig): string {
    const control = `${config.control.host}:${config.control.port}`;
    return `#  Tunnel server (frps) for ${config.domain}, made by the hub.
bindAddr = ${tomlString(config.tunnel.bindAddr)}
bindPort = ${config.tunnel.bindPort}
#  only the edge reaches the BBSes' HTTP routes
proxyBindAddr = "127.0.0.1"
vhostHTTPPort = ${config.tunnel.vhostHttpPort}
subDomainHost = ${tomlString(config.domain)}
#  agents must use TLS (their token crosses this connection)
transport.tls.force = true
#  no raw TCP or UDP ports for anyone
allowPorts = []

log.to = "console"
log.level = "info"

#  every login and proxy is approved by the control plane
[[httpPlugins]]
name = "hub-control"
addr = ${tomlString(control)}
path = "/frp/handler"
ops = ["Login", "NewProxy", "CloseProxy", "Ping"]
`;
}

//  The edge's config (Caddy). One catch-all site: certificates are made on
//  demand, only for names the control plane says are registered.
export function caddyfile(config: HubConfig): string {
    const control = `${config.control.host}:${config.control.port}`;
    const tunnel = `127.0.0.1:${config.tunnel.vhostHttpPort}`;
    const tls =
        'internal' === config.edge.tls
            ? '\ttls internal {\n\t\ton_demand\n\t}'
            : '\ttls {\n\t\ton_demand\n\t}';
    const exact = BbsExactPaths.join(' ');
    const prefixes = BbsPrefixPaths.map(p => `${p}*`).join(' ');
    return `#  Edge (Caddy) for ${config.domain}, made by the hub.
{
	admin off
	http_port ${config.edge.httpPort}
	https_port ${config.edge.httpsPort}
	default_bind ${config.edge.bindAddr}
${'internal' === config.edge.tls ? '\tskip_install_trust\n' : ''}	#  before making a certificate for a name, ask the control plane
	on_demand_tls {
		ask http://${control}/tls/allowed
	}
}

https:// {
${tls}

	#  in this order, first match wins
	route {
		#  the tunnel passes paths on unchanged, so odd ones stop here
		@odd expression \`{http.request.orig_uri}.matches(r"${OddPathRe2}")\`
		handle @odd {
			respond 400
		}

		#  the hub's own site
		@hub host ${config.domain}
		handle @hub {
			respond "Nexus Lounge hub" 200
		}

		#  answered by the hub, never by the BBS, so a BBS can't claim
		#  another DID, and it works while the BBS is offline
		@did path /.well-known/atproto-did
		handle @did {
			reverse_proxy ${control}
		}

		#  the BBS's page (served by the hub, H5)
		@root path /
		handle @root {
			respond "{http.request.host}" 200
		}

		#  forwarded to the BBS through its tunnel
		@bbs path ${exact} ${prefixes}
		handle @bbs {
			reverse_proxy ${tunnel} {
				#  Caddy replaces X-Forwarded-For but keeps this one
				header_up -X-Real-IP
			}
		}

		handle {
			respond 404
		}
	}
}
`;
}
