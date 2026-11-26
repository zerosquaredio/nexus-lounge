//  Config files generated from the hub's config and rules.ts, so the edge,
//  the tunnel server and every agent agree on names, ports and paths.

import { VgaFontPath } from './art_html.ts';
import { chatDomain, ChatSecretEnv } from './chat.ts';
import { FrpsAdminPasswordEnv, type HubConfig } from './config.ts';
import { BbsExactPaths, BbsPrefixPaths, OddPathRe2 } from './rules.ts';

//  A cookie's Domain attribute, wherever it is among the others (RE2, for
//  Caddy, in a Caddyfile quoted string)
export const CookieDomainRe2 = String.raw`"(?i);\s*domain\s*=[^;]*"`;
//  The hub's own view cookie in a request's Cookie header (RE2, for Caddy):
//  it is set for the whole hub domain, so browsers send it to BBSes'
//  addresses too, and the edge takes it out before a BBS sees it
//  Two rules, so no stray separator is left: the cookie first in the
//  header (with the separator after it), then anywhere later (with the one
//  before it)
export const ViewCookieFirstRe2 = String.raw`"^hub_view=[^;]*(?:;\s*)?"`;
export const ViewCookieRe2 = String.raw`";\s*hub_view=[^;]*"`;

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

//  ENiGMA½'s routes that must be reachable through the hub (hub.md §4), and
//  /assets/, where a BBS offers its splash screen (F21)
export const EnigmaWebLocations = [
    '/_enig/atproto/',
    '/_enig/handoff/',
    '/_enig/signin',
    '/_enig/signout',
    '/assets/',
];

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
#  For the board's own setup (ENiGMA½: oputil.js config hub --agent FILE):
#  hub: ${config.site.publicUrl}
#  address: https://${options.name}.${config.domain}
serverAddr = ${tomlString(config.tunnel.publicAddr)}
serverPort = ${config.tunnel.bindPort}
user = ${tomlString(options.name)}
metadatas.token = ${tomlString(options.token)}
#  keep trying if the hub is down or restarting
loginFailExit = false
transport.tls.enable = true
${agentTls(config)}#  the hub needs a heartbeat: without one, it closes the tunnel
transport.heartbeatInterval = ${config.tunnel.heartbeatSeconds}
transport.heartbeatTimeout = ${heartbeatTimeout(config)}
${proxy('ws', options.wsPort ?? 8810, ['/ws'])}${proxy('web', options.webPort ?? 8080, EnigmaWebLocations)}`;
}

//  How the agent knows it reached the hub: the hub's name in its certificate,
//  from an authority the agent's system trusts. The token goes only to it
function agentTls(config: HubConfig): string {
    if ('' === config.tunnel.tlsCertFile) {
        return '#  this hub has no certificate for agents to check (development only)\n';
    }
    return `#  check the hub's certificate before sending the token
transport.tls.serverName = ${tomlString(tunnelName(config))}
transport.tls.useSystemCa = true
`;
}

//  The name agents expect in the tunnel server's certificate: the address
//  they connect to, unless that is an IP address, then the hub's domain
export function tunnelName(config: HubConfig): string {
    const addr = config.tunnel.publicAddr;
    return /^[\d.]+$|:/.test(addr) ? config.domain : addr;
}

//  How long a tunnel lasts with no heartbeat accepted: three missed
export function heartbeatTimeout(config: HubConfig): number {
    return config.tunnel.heartbeatSeconds * 3;
}

//  The tunnel server's certificate, if the hub has one for agents to check
function frpsTls(config: HubConfig): string {
    if ('' === config.tunnel.tlsCertFile) {
        return '#  no certificate given: frps makes its own, which agents cannot check\n';
    }
    return `#  a public certificate for ${tunnelName(config)}, which agents check; frps
#  reads it only at start, so it is restarted when the certificate renews
transport.tls.certFile = ${tomlString(config.tunnel.tlsCertFile)}
transport.tls.keyFile = ${tomlString(config.tunnel.tlsKeyFile)}
`;
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
${frpsTls(config)}#  no raw TCP or UDP ports for anyone
allowPorts = []
#  close an agent's tunnel, and every session in it, when no heartbeat has
#  been accepted for this long. The control plane refuses those of a
#  suspended BBS or an old token, so this is how they are cut; an agent
#  that sends none is cut too
transport.heartbeatTimeout = ${heartbeatTimeout(config)}

log.to = "console"
#  warnings and errors only: the control plane logs each login and route,
#  and at "info" frps also logs every request to its admin API
log.level = "warn"

#  the admin API, on this machine only: the control plane asks it which
#  tunnels are really up. Start frps with ${FrpsAdminPasswordEnv} set (the
#  control plane needs the same); without it, frps's API has no password
webServer.addr = "127.0.0.1"
webServer.port = ${config.tunnel.adminPort}
webServer.user = "hub"
webServer.password = "{{ .Envs.${FrpsAdminPasswordEnv} }}"

#  every login and proxy is approved by the control plane
[[httpPlugins]]
name = "hub-control"
addr = ${tomlString(control)}
path = "/frp/handler"
ops = ["Login", "NewProxy", "CloseProxy", "Ping"]
`;
}

//  How to start the chat server (freeq, hub plan H15). On this machine only,
//  with no database, so messages stay in memory; no guests; and only the
//  identities the hub issues (chat.ts)
export function chatCommand(config: HubConfig, binary = 'freeq-server'): string {
    const chat = config.space.chat;
    return [
        `BROKER_SHARED_SECRET="$${ChatSecretEnv}"`,
        binary,
        `--listen-addr 127.0.0.1:${chat.ircPort}`,
        `--web-addr 127.0.0.1:${chat.webPort}`,
        `--server-name ${config.domain}`,
        `--data-dir ${chat.dataDir}`,
        '--no-guest',
        `--allowed-did-domains ${chatDomain(config.domain)}`,
    ].join(' ');
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
			reverse_proxy ${config.site.host}:${config.site.port} {
				header_up -X-Real-IP
			}
		}

		#  answered by the hub, never by the BBS, so a BBS can't claim
		#  another DID, and it works while the BBS is offline
		@did path /.well-known/atproto-did
		handle @did {
			reverse_proxy ${control}
		}

		#  served by the hub, not the BBS: its page, the font that page and
		#  views use, and the web terminal
		@hubpage path / ${VgaFontPath} /_enig/ws-term /_enig/ws-term/*
		handle @hubpage {
			reverse_proxy ${config.site.host}:${config.site.port} {
				header_up -X-Real-IP
			}
		}

		#  forwarded to the BBS through its tunnel
		@bbs path ${exact} ${prefixes}
		handle @bbs {
			reverse_proxy ${tunnel} {
				#  Caddy replaces X-Forwarded-For but keeps this one
				header_up -X-Real-IP
				#  the hub's own view cookie is the hub's: not passed on
				header_up Cookie ${ViewCookieFirstRe2} ""
				header_up Cookie ${ViewCookieRe2} ""
				#  a cookie a BBS sets is for that BBS alone: without its
				#  Domain, the browser keeps it to the BBS's own name, never
				#  sending it to the hub or another BBS
				header_down Set-Cookie ${CookieDomainRe2} ""
			}
		}

		handle {
			respond 404
		}
	}
}
`;
}
