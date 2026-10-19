#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run as root'; exit 1; }
previous=$(cat /opt/zeydrop/previous)
[[ $previous == /opt/zeydrop/releases/* && -f $previous/dist/build.json && -f $previous/server/index.js ]] || { echo 'Invalid previous release'; exit 1; }
current=$(readlink -f /opt/zeydrop/current)
ln -s "$previous" /opt/zeydrop/current.next
mv -Tf /opt/zeydrop/current.next /opt/zeydrop/current
printf '%s\n' "$current" > /opt/zeydrop/previous
systemctl restart zeydrop
systemctl reload nginx
systemctl is-active --quiet zeydrop
printf 'Rolled back to %s\n' "$previous"
