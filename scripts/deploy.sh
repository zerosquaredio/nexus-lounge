#!/usr/bin/env bash
#  Deploy the hub to its server, from a checkout of this repo.
#
#    HUB_SSH=admin@hub.example scripts/deploy.sh hub [REF]
#
#  Commands:
#    hub [REF]            Deploy hub/control at REF (default HEAD) and restart
#                         the control plane. If it doesn't come back healthy,
#                         the previous code is put back.
#    rollback             Put back the code from before the last deploy.
#    configs              Regenerate frps.toml and the Caddyfile; install and
#                         restart only what changed (restarting frps drops
#                         every tunnel for a few seconds).
#    status               Services, the deployed revision, and the BBSes.
#    board-image [REF]    Build an ENiGMA½ image on the server from the fork
#                         at $FORK (REF default HEAD), tagged enigma-bbs:<rev>.
#    board NAME TAG       Replace the Docker container NAME with one from the
#                         image TAG (e.g. enigma-bbs:aabead7f), keeping its
#                         ports, volumes, memory cap and restart policy. Goes
#                         back to the old image if the new one doesn't stay up.
#
#  Settings (environment):
#    HUB_SSH            ssh destination, a user with sudo (required)
#    HUB_ROOT           the hub's home, holding control/ and hub.json (/srv/hub)
#    HUB_USER           the user the hub runs as (hub)
#    HUB_NODE           directory with node and npm (/opt/node/bin)
#    HUB_SERVICE        the control plane's systemd unit (hub-control)
#    HUB_CTL            the admin CLI wrapper on the server (hubctl)
#    HUB_CONTROL_PORT   the control plane's port, for /healthz (7200)
#    FORK               checkout of the ENiGMA½ fork, for board-image
#
#  The server layout this expects is in hub/README.md. Files are exported
#  with core.autocrlf off, so scripts keep LF line endings from Windows too.

set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
HUB_SSH=${HUB_SSH:-}
HUB_ROOT=${HUB_ROOT:-/srv/hub}
HUB_USER=${HUB_USER:-hub}
HUB_NODE=${HUB_NODE:-/opt/node/bin}
HUB_SERVICE=${HUB_SERVICE:-hub-control}
HUB_CTL=${HUB_CTL:-hubctl}
HUB_CONTROL_PORT=${HUB_CONTROL_PORT:-7200}

usage() {
    sed -n '2,/^$/s/^# \{0,2\}//p' "$0"
    exit "${1:-0}"
}

die() {
    echo "deploy: $*" >&2
    exit 1
}

need_ssh() {
    [ -n "$HUB_SSH" ] || die 'set HUB_SSH to the server (user@host), a user with sudo'
}

#  Run a bash script on the server, with arguments. The settings go first,
#  so remote scripts can use them. The script is wrapped in a function, so
#  bash has read all of it before anything runs that might read stdin.
remote() {
    local script=$1
    shift
    ssh -T "$HUB_SSH" bash -s -- "$HUB_ROOT" "$HUB_USER" "$HUB_NODE" "$HUB_SERVICE" \
        "$HUB_CTL" "$HUB_CONTROL_PORT" "$@" <<<"main() {
$script
}
main \"\$@\""
}

#  Shared by the remote scripts: names for the settings, and a health check
Prelude='
set -euo pipefail
ROOT=$1 USER_=$2 NODE=$3 SERVICE=$4 CTL=$5 PORT=$6
shift 6
healthy() {
    for _ in $(seq 1 30); do
        if systemctl is-active --quiet "$SERVICE" &&
            curl -fsS -m 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    return 1
}
swap_back() {
    sudo rm -rf "$ROOT/control.failed"
    sudo mv "$ROOT/control" "$ROOT/control.failed"
    sudo mv "$ROOT/control.old" "$ROOT/control"
    sudo systemctl restart "$SERVICE"
}
'

#  The commit REF names, short, refusing one that is not in this repo
rev_of() {
    git -C "$1" rev-parse --verify --short "$2^{commit}" 2>/dev/null || die "no commit \"$2\" in $1"
}

deploy_hub() {
    need_ssh
    local ref=${1:-HEAD} rev
    rev=$(rev_of "$REPO" "$ref")
    if [ "$ref" = HEAD ] && [ -n "$(git -C "$REPO" status --porcelain -- hub/control)" ]; then
        echo "deploy: note: hub/control has uncommitted changes; deploying the commit $rev without them" >&2
    fi
    echo "Deploying hub/control at $rev to $HUB_SSH..."

    #  upload and install alongside the running code
    git -C "$REPO" -c core.autocrlf=false archive --format=tar "$rev:hub/control" |
        ssh -T "$HUB_SSH" "set -e
            sudo rm -rf '$HUB_ROOT/control.new'
            sudo install -d -o '$HUB_USER' -g '$HUB_USER' '$HUB_ROOT/control.new'
            sudo -u '$HUB_USER' tar -C '$HUB_ROOT/control.new' -xf -"

    remote "$Prelude"'
REV=$1
sudo test -d "$ROOT/control" || { echo "deploy: $ROOT/control is missing; is this the hub server?" >&2; exit 1; }
sudo -u "$USER_" env HOME="$ROOT" PATH="$NODE:/usr/bin:/bin" REV="$REV" \
    bash -c "cd \"$ROOT/control.new\" && npm ci --omit=dev --no-audit --no-fund --loglevel=error && echo \"\$REV\" > REVISION" </dev/null
was=$(sudo cat "$ROOT/control/REVISION" 2>/dev/null || echo unknown)
sudo rm -rf "$ROOT/control.old"
sudo mv "$ROOT/control" "$ROOT/control.old"
sudo mv "$ROOT/control.new" "$ROOT/control"
sudo systemctl restart "$SERVICE"
if healthy; then
    echo "Deployed $REV (was $was); the previous code is in $ROOT/control.old."
    exit 0
fi
echo "deploy: $REV did not come back healthy; its log:" >&2
sudo journalctl -u "$SERVICE" -n 30 --no-pager >&2 || true
swap_back
if healthy; then
    echo "deploy: put $was back, which is running; the failed code is in $ROOT/control.failed" >&2
else
    echo "deploy: put $was back, but it is not healthy either; check $SERVICE now" >&2
fi
exit 1
' "$rev"
}

rollback() {
    need_ssh
    remote "$Prelude"'
sudo test -d "$ROOT/control.old" || { echo "deploy: nothing to roll back to ($ROOT/control.old is missing)" >&2; exit 1; }
from=$(sudo cat "$ROOT/control/REVISION" 2>/dev/null || echo unknown)
to=$(sudo cat "$ROOT/control.old/REVISION" 2>/dev/null || echo unknown)
swap_back
if healthy; then
    echo "Rolled back from $from to $to; $from is in $ROOT/control.failed."
else
    echo "deploy: rolled back to $to, but it is not healthy; check $SERVICE now" >&2
    exit 1
fi
'
}

configs() {
    need_ssh
    remote "$Prelude"'
install_if_changed() {
    local what=$1 dest=$2 unit=$3 new mode owner group
    new=$(mktemp)
    if ! sudo "$CTL" "$what" >"$new"; then
        rm -f "$new"
        echo "deploy: $CTL $what failed" >&2
        exit 1
    fi
    if sudo cmp -s "$new" "$dest"; then
        echo "$dest: unchanged"
    else
        sudo diff -u "$dest" "$new" | sed "s/^/  /" || true
        #  keep the file'"'"'s owner and mode
        read -r mode owner group < <(sudo stat -c "%a %U %G" "$dest" 2>/dev/null || echo "644 root root")
        sudo install -m "$mode" -o "$owner" -g "$group" "$new" "$dest"
        sudo systemctl restart "$unit"
        echo "$dest: updated; restarted $unit"
    fi
    rm -f "$new"
}
install_if_changed frps-config /etc/hub/frps.toml hub-frps
install_if_changed caddyfile /etc/caddy/Caddyfile caddy
'
}

status() {
    need_ssh
    remote "$Prelude"'
echo "Revision: $(sudo cat "$ROOT/control/REVISION" 2>/dev/null || echo unknown)" \
    "(previous: $(sudo cat "$ROOT/control.old/REVISION" 2>/dev/null || echo none))"
systemctl list-units --type=service --all --no-pager --no-legend "hub-*" caddy.service "*bbs-agent*" |
    awk "{ printf \"  %-28s %s %s\n\", \$1, \$3, \$4 }"
sudo "$CTL" list
'
}

board_image() {
    need_ssh
    [ -n "${FORK:-}" ] || die 'set FORK to a checkout of the ENiGMA½ fork'
    local ref=${1:-HEAD} rev
    rev=$(rev_of "$FORK" "$ref")
    if [ "$ref" = HEAD ] && [ -n "$(git -C "$FORK" status --porcelain --untracked-files=no)" ]; then
        echo "deploy: note: the fork has uncommitted changes; building the commit $rev without them" >&2
    fi
    echo "Building enigma-bbs:$rev on $HUB_SSH (this takes several minutes)..."
    git -C "$FORK" -c core.autocrlf=false archive --format=tar "$rev" |
        ssh -T "$HUB_SSH" "set -e
            rm -rf ~/build/enigma && mkdir -p ~/build/enigma && tar -C ~/build/enigma -xf -
            cd ~/build/enigma
            sudo docker buildx build --load --progress=plain -t 'enigma-bbs:$rev' -f docker/Dockerfile . >~/build/enigma-$rev.log 2>&1 ||
                { tail -30 ~/build/enigma-$rev.log >&2; exit 1; }
            echo 'Built enigma-bbs:$rev (log in ~/build/enigma-$rev.log).'"
    echo "To use it: scripts/deploy.sh board <container> enigma-bbs:$rev"
}

board() {
    need_ssh
    local name=${1:-} tag=${2:-}
    [ -n "$name" ] && [ -n "$tag" ] || die 'usage: board NAME TAG'
    [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || die "not a container name: $name"
    [[ "$tag" =~ ^[A-Za-z0-9][A-Za-z0-9_./:-]*$ ]] || die "not an image tag: $tag"
    remote "$Prelude"'
NAME=$1 TAG=$2
sudo docker image inspect "$TAG" >/dev/null 2>&1 || { echo "deploy: no image $TAG on the server" >&2; exit 1; }
sudo docker container inspect "$NAME" >/dev/null 2>&1 || { echo "deploy: no container $NAME" >&2; exit 1; }
#  its settings, as run options
read -r -a opts <<<"$(sudo docker container inspect -f '"'"'{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}-p {{if .HostIp}}{{.HostIp}}:{{end}}{{.HostPort}}:{{$p}} {{end}}{{end}}{{range .HostConfig.Binds}}-v {{.}} {{end}}{{with .HostConfig.Memory}}--memory {{.}} {{end}}--restart {{.HostConfig.RestartPolicy.Name}}'"'"' "$NAME")"
old=$(sudo docker container inspect -f "{{.Config.Image}}" "$NAME")
start() {
    sudo docker run -d --name "$NAME" "${opts[@]}" "$1" >/dev/null
}
stays_up() {
    sleep 20
    [ "$(sudo docker container inspect -f "{{.State.Running}} {{.RestartCount}}" "$NAME")" = "true 0" ]
}
echo "Replacing $NAME ($old) with $TAG: ${opts[*]}"
sudo docker stop -t 25 "$NAME" >/dev/null
sudo docker rename "$NAME" "$NAME.previous"
if start "$TAG" && stays_up; then
    sudo docker rm "$NAME.previous" >/dev/null
    echo "$NAME runs $TAG. The old image $old is kept; \"docker image prune\" clears unused ones."
    exit 0
fi
echo "deploy: $NAME did not stay up on $TAG; its log:" >&2
sudo docker logs --tail 30 "$NAME" >&2 || true
sudo docker rm -f "$NAME" >/dev/null 2>&1 || true
sudo docker rename "$NAME.previous" "$NAME"
sudo docker start "$NAME" >/dev/null
echo "deploy: put $NAME back on $old" >&2
exit 1
' "$name" "$tag"
}

case "${1:-}" in
    hub) deploy_hub "${2:-}" ;;
    rollback) rollback ;;
    configs) configs ;;
    status) status ;;
    board-image) board_image "${2:-}" ;;
    board) board "${2:-}" "${3:-}" ;;
    -h | --help | help) usage ;;
    *) usage 1 >&2 ;;
esac
