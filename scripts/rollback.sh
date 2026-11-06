#!/usr/bin/env bash
# Transactional release rollback; no configuration/domain/TLS migration.
set -Eeuo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run as root'; exit 1; }
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
for tool in node nginx systemctl flock; do command -v "$tool" >/dev/null || { echo "Missing $tool" >&2; exit 1; }; done
exec 9>/opt/zeydrop/.deploy.lock
flock -n 9 || { echo 'Deployment is busy (install/build/rollback may still be running); retry after it exits.' >&2; exit 75; }
previous=$(cat /opt/zeydrop/previous)
current=$(readlink -f /opt/zeydrop/current)
valid_release() {
    [[ $1 =~ ^/opt/zeydrop/releases/[a-f0-9]{16}$ && $(readlink -f -- "$1") == "$1" && -f $1/dist/build.json && -f $1/server/index.js ]]
}
valid_release "$previous" && valid_release "$current" || { echo 'Invalid current or previous release'; exit 1; }
[[ $previous != "$current" ]] || { echo 'Current and previous already match'; exit 1; }
nginx -t
restore_failed_rollback() {
    local result=$?
    trap - ERR
    set +e
    rm -f /opt/zeydrop/current.next.$$ /opt/zeydrop/previous.next.$$
    ln -s "$current" /opt/zeydrop/current.restore.$$
    mv -Tf /opt/zeydrop/current.restore.$$ /opt/zeydrop/current
    systemctl restart zeydrop
    node "$script_dir/check-signaling.cjs" --env /etc/zeydrop/signaling.env --server-root /opt/zeydrop/current/server
    if nginx -t; then systemctl reload nginx; fi
    printf 'Rollback failed. Restoration of the original release was attempted; previous marker unchanged.\n' >&2
    exit "$result"
}
trap restore_failed_rollback ERR
ln -s "$previous" /opt/zeydrop/current.next.$$
mv -Tf /opt/zeydrop/current.next.$$ /opt/zeydrop/current
systemctl restart zeydrop
node "$script_dir/check-signaling.cjs" --env /etc/zeydrop/signaling.env --server-root /opt/zeydrop/current/server
systemctl reload nginx
systemctl is-active --quiet zeydrop
# Update the reverse-rollback marker only after the selected release is healthy.
printf '%s\n' "$current" > /opt/zeydrop/previous.next.$$
mv -Tf /opt/zeydrop/previous.next.$$ /opt/zeydrop/previous
trap - ERR
printf 'Rolled back to %s\n' "$previous"
