#!/bin/sh
#  Gives the hub's tunnel server (frps) the edge's certificate for the hub's
#  own name, so agents can check they reached the hub before sending their
#  token (hub plan §5.2). Caddy gets and renews the certificate; frps reads
#  it only when it starts, so this copies it over when it has changed and
#  restarts frps (every tunnel drops for a few seconds, and the agents
#  reconnect by themselves).
#
#  Run as root, daily, by hub-tunnel-cert.timer (docs/admin/running_a_hub.md
#  §2), and once by hand when setting up:
#
#      tunnel-cert.sh hub.example
#
#  The hub's config then names the copies:
#      "tunnel": { "tlsCertFile": "/etc/hub/tunnel-tls/tunnel.crt",
#                  "tlsKeyFile": "/etc/hub/tunnel-tls/tunnel.key" }
set -eu

NAME="${1:?usage: tunnel-cert.sh HUB_DOMAIN}"
CERTS="${CADDY_CERTS:-/var/lib/caddy/.local/share/caddy/certificates}"
DEST="${TUNNEL_TLS_DIR:-/etc/hub/tunnel-tls}"
GROUP="${HUB_GROUP:-hub}"
SERVICE="${FRPS_SERVICE:-hub-frps}"

#  Caddy keeps a folder per authority (Let's Encrypt, or ZeroSSL if it fell
#  back): take the newest certificate for the name from any of them
CRT="$(find "$CERTS" -type f -name "$NAME.crt" -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)"
if [ -z "$CRT" ]; then
    echo "tunnel-cert: Caddy has no certificate for $NAME (open https://$NAME once)" >&2
    exit 1
fi
KEY="${CRT%.crt}.key"

if cmp -s "$CRT" "$DEST/tunnel.crt" && cmp -s "$KEY" "$DEST/tunnel.key"; then
    exit 0
fi

#  never hand frps something it can't start with
if ! openssl x509 -in "$CRT" -noout -checkend 86400 >/dev/null; then
    echo "tunnel-cert: $CRT expires within a day; left as it was" >&2
    exit 1
fi
if [ "$(openssl x509 -in "$CRT" -noout -pubkey)" != "$(openssl pkey -in "$KEY" -pubout)" ]; then
    echo "tunnel-cert: $CRT and its key don't match; left as it was" >&2
    exit 1
fi

install -d -m 750 -o root -g "$GROUP" "$DEST"
install -m 640 -o root -g "$GROUP" "$KEY" "$DEST/tunnel.key.new"
install -m 644 -o root -g "$GROUP" "$CRT" "$DEST/tunnel.crt.new"
mv -f "$DEST/tunnel.key.new" "$DEST/tunnel.key"
mv -f "$DEST/tunnel.crt.new" "$DEST/tunnel.crt"
echo "tunnel-cert: the certificate for $NAME changed; restarting $SERVICE"
systemctl try-restart "$SERVICE"
