#!/usr/bin/env bash
#  End-to-end test of the hub on one machine, in front of a real BBS:
#  the control plane, frps and Caddy from generated configs, an honest agent,
#  dishonest agents, odd paths, suspension and handle verification.
#
#  Everything listens on 127.0.0.1 only, with Caddy's own test CA.
#
#  Needs: node 24+, and frps, frpc and caddy (set BIN to their directory).
#  The BBS under test: its web server on BBS_WEB_PORT, WebSocket on BBS_WS_PORT.
#
#    BIN=~/dev/hub-spike BBS_WEB_PORT=8080 BBS_WS_PORT=8810 hub/test/e2e.sh

set -u
HERE=$(cd "$(dirname "$0")" && pwd)
CONTROL="$HERE/../control"
BIN=${BIN:?set BIN to the directory holding frps, frpc and caddy}
BBS_WEB_PORT=${BBS_WEB_PORT:-8080}
BBS_WS_PORT=${BBS_WS_PORT:-8810}

WORK=$(mktemp -d /tmp/hub-e2e.XXXXXX)
PIDS=()
cleanup() {
    for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null; done
    wait 2>/dev/null
}
trap cleanup EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; }
check() { # description expected actual
    if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected $2, got $3)"; fi
}

cat > "$WORK/hub.json" <<EOF
{ "domain": "hub.test", "database": "$WORK/hub.sqlite" }
EOF
hub() { node "$CONTROL/src/cli.ts" --config "$WORK/hub.json" "$@"; }
start() { # name command...
    local name=$1; shift
    (cd "$WORK" && exec "$@" >"$WORK/$name.log" 2>&1) &
    PIDS+=($!)
}

echo "== setup in $WORK"
hub frps-config >"$WORK/frps.toml"
hub caddyfile >"$WORK/Caddyfile"
"$BIN/caddy" validate --config "$WORK/Caddyfile" >/dev/null 2>&1 && ok "generated Caddyfile is valid" || bad "generated Caddyfile is valid"

SYSOP=did:plc:aaaaaaaaaaaaaaaaaaaaaaaa
TOKEN=$(hub add testbbs --sysop $SYSOP --web-port "$BBS_WEB_PORT" --ws-port "$BBS_WS_PORT" --out "$WORK/agent.toml" | sed -n 's/^Token (shown once): //p')
OTHER=$(hub add other --sysop did:plc:bbbbbbbbbbbbbbbbbbbbbbbb --out "$WORK/agent-other.toml" | sed -n 's/^Token (shown once): //p')
[ -n "$TOKEN" ] && [ -n "$OTHER" ] && ok "registered two BBSes" || bad "registered two BBSes"
check "agent config is private" "600" "$(stat -c %a "$WORK/agent.toml")"

start control node "$CONTROL/src/main.ts" "$WORK/hub.json"
sleep 1
start frps "$BIN/frps" -c "$WORK/frps.toml"
sleep 1
start caddy "$BIN/caddy" run --config "$WORK/Caddyfile"
start agent "$BIN/frpc" -c "$WORK/agent.toml"
sleep 4

CA="$WORK/caddy-data/pki/authorities/local/root.crt"
[ -f "$CA" ] || CA=$(find "$HOME/.local/share/caddy/pki/authorities/local" -name root.crt 2>/dev/null | head -1)
get() { # host path [curl args]: prints the HTTP status
    local h=$1 p=$2; shift 2
    curl -s --path-as-is -m 8 --cacert "$CA" --resolve "$h:7443:127.0.0.1" -o /dev/null -w '%{http_code}' "$@" "https://$h:7443$p"
}
#  "reached": the request got through the edge and the tunnel to the BBS,
#  whatever the BBS then said (it rate limits its sign-in page, for one)
reached() { case "$(get "$@")" in 000 | 404 | 502) echo no ;; *) echo reached ;; esac; }
body() { local h=$1 p=$2; shift 2; curl -s --path-as-is -m 8 --cacert "$CA" --resolve "$h:7443:127.0.0.1" "$@" "https://$h:7443$p"; }

echo "== certificates"
check "registered BBS gets a certificate" 200 "$(get testbbs.hub.test /)"
check "the hub's own name gets one" 200 "$(get hub.test /)"
check "unregistered name gets none" 000 "$(get nobody.hub.test /)"
check "foreign name gets none" 000 "$(get evil.example /)"

echo "== paths, through the tunnel to the real BBS"
check "/_enig/signin reaches the BBS" reached "$(reached testbbs.hub.test /_enig/signin)"
check "/ws reaches the BBS" 200 "$(get testbbs.hub.test /ws)"
check "/_enig/handoff/ reaches the BBS (unknown code)" 410 "$(get testbbs.hub.test /_enig/handoff/AAAA-BBBB)"
for p in /admin /_enig/ /_enig/ws-term/ /_enig/signinX /_enig/signin/x /assets; do
    check "$p is not forwarded" 404 "$(get testbbs.hub.test "$p")"
done
for p in "/_enig/handoff/../x" "/_enig/handoff/..%2fx" "/_enig/handoff/%2e%2e/x" "/_enig/handoff//x" "/_enig/handoff/a\\b" "/_enig/handoff/a%00b"; do
    check "odd path $p refused" 400 "$(get testbbs.hub.test "$p")"
done
check "query strings are left alone" reached "$(reached testbbs.hub.test '/_enig/signin?x=../y%2F')"

echo "== the terminal, over wss"
WS_OUT=$(cd "$WORK" && CA="$CA" node -e '
const fs = require("fs");
const WebSocket = require(process.env.HOME + "/dev/enigma-bbs/node_modules/ws");
const ws = new WebSocket("wss://testbbs.hub.test:7443/ws", {
    ca: fs.readFileSync(process.env.CA),
    lookup: (h, o, cb) => (o && o.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4)),
});
let n = 0;
ws.on("message", d => (n += d.length));
ws.on("error", e => { console.log("error " + e.message); process.exit(0); });
setTimeout(() => { console.log(n > 0 ? "bytes" : "none"); process.exit(0); }, 3000);
')
check "a terminal session opens and the BBS talks" bytes "$WS_OUT"

echo "== dishonest agents"
attack() { # name expected-reason toml-body
    cat >"$WORK/attack-$1.toml" <<EOF
serverAddr = "127.0.0.1"
serverPort = 7000
user = "$2"
metadatas.token = "$3"
loginFailExit = true
transport.tls.enable = true
log.to = "$WORK/attack-$1.log"

[[proxies]]
name = "p"
$4
EOF
    timeout 6 "$BIN/frpc" -c "$WORK/attack-$1.toml" >/dev/null 2>&1
    if grep -qiE "$5" "$WORK/attack-$1.log"; then ok "refused: $1"; else bad "refused: $1 ($(grep -E 'error|success' "$WORK/attack-$1.log" | tail -1 | cut -c25-140))"; fi
}
attack badtoken testbbs wrong 'type = "http"
localPort = 9
subdomain = "testbbs"
locations = ["/ws"]' "wrong token"
attack steal other "$OTHER" 'type = "http"
localPort = 9
subdomain = "testbbs"
locations = ["/ws"]' "not this BBS"
attack rootpath other "$OTHER" 'type = "http"
localPort = 9
subdomain = "other"
locations = ["/"]' "Path / is not"
attack nopaths other "$OTHER" 'type = "http"
localPort = 9
subdomain = "other"' "must list the paths"
attack tcp other "$OTHER" 'type = "tcp"
localPort = 22
remotePort = 7022' "remote_port|type tcp"
attack customdomain other "$OTHER" 'type = "http"
localPort = 9
customDomains = ["testbbs.hub.test"]
locations = ["/ws"]' "custom_domains"
attack traverse other "$OTHER" 'type = "http"
localPort = 9
subdomain = "other"
locations = ["/assets/../admin"]' "not one a BBS may serve"
attack group other "$OTHER" 'type = "http"
localPort = 9
subdomain = "other"
locations = ["/ws"]
loadBalancer.group = "g"
loadBalancer.groupKey = "k"' "group"
attack hostrewrite other "$OTHER" 'type = "http"
localPort = 9
subdomain = "other"
locations = ["/ws"]
hostHeaderRewrite = "testbbs.hub.test"' "host_header_rewrite"
#  an otherwise honest agent without TLS: the server must refuse it
variant() { # source target log: a copy of an agent config that logs to a file and gives up on failure
    {
        echo "log.to = \"$3\""
        sed 's/loginFailExit = false/loginFailExit = true/' "$1"
    } >"$2"
}
variant "$WORK/agent-other.toml" "$WORK/attack-plaintext.toml" "$WORK/attack-plaintext.log"
sed -i 's/transport.tls.enable = true/transport.tls.enable = false/' "$WORK/attack-plaintext.toml"
timeout 6 "$BIN/frpc" -c "$WORK/attack-plaintext.toml" >/dev/null 2>&1
if [ ! -s "$WORK/attack-plaintext.log" ]; then
    bad "an agent without TLS is refused (the agent didn't run)"
elif grep -q "login to server success" "$WORK/attack-plaintext.log"; then
    bad "an agent without TLS is refused"
else
    ok "an agent without TLS is refused ($(grep -E 'error' "$WORK/attack-plaintext.log" | tail -1 | cut -c25-90))"
fi
check "nothing listens on 7022" 0 "$(ss -ltn | grep -c ':7022 ')"
check "the honest BBS still works" 200 "$(get testbbs.hub.test /ws)"

echo "== handle verification"
check "no BBS DID yet: 404" 404 "$(get testbbs.hub.test /.well-known/atproto-did)"
hub set-did testbbs did:plc:cccccccccccccccccccccccc >/dev/null
check "answered by the hub from the registry" did:plc:cccccccccccccccccccccccc "$(body testbbs.hub.test /.well-known/atproto-did)"

echo "== state seen by the admin"
check "listed as connected" connected "$(hub list | awk '$1 == "testbbs" { print $3 }')"

echo "== suspension"
hub suspend testbbs >/dev/null
check "no certificate for a suspended name (asked directly)" 404 "$(curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:7200/tls/allowed?domain=testbbs.hub.test')"
check "handle verification stops" 404 "$(get testbbs.hub.test /.well-known/atproto-did)"
variant "$WORK/agent.toml" "$WORK/agent-again.toml" "$WORK/agent-again.log"
timeout 6 "$BIN/frpc" -c "$WORK/agent-again.toml" >/dev/null 2>&1
grep -q "suspended" "$WORK/agent-again.log" && ok "a new login is refused" || bad "a new login is refused"
SECONDS=0
CUT=""
while [ $SECONDS -lt 75 ]; do
    [ "$(get testbbs.hub.test /ws)" = 404 ] && { CUT=$SECONDS; break; }
    sleep 3
done
#  frpc sends no heartbeats by default, and a dishonest agent could stop
#  them anyway, so the hub can't cut an open tunnel itself: restarting the
#  tunnel server does, and the suspended BBS can't log in again
if [ -n "$CUT" ]; then ok "the open tunnel was cut after about ${CUT}s"; else echo "  note  the open tunnel stays up until the tunnel server restarts"; fi
kill "${PIDS[1]}" 2>/dev/null; wait "${PIDS[1]}" 2>/dev/null
start frps "$BIN/frps" -c "$WORK/frps.toml"
sleep 5
check "after restarting the tunnel server, the suspended BBS is gone" 404 "$(get testbbs.hub.test /ws)"
hub resume testbbs >/dev/null
SECONDS=0
while [ $SECONDS -lt 40 ] && [ "$(get testbbs.hub.test /ws)" != 200 ]; do sleep 2; done
check "resumed: its agent is back on its own" 200 "$(get testbbs.hub.test /ws)"

echo
echo "== $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] && rm -rf "$WORK" || echo "logs kept in $WORK"
[ $FAIL -eq 0 ]
