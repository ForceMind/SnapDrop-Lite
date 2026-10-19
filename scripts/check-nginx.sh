#!/usr/bin/env bash
# Parse the real deployment template with an ephemeral test certificate; do not run Nginx.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v nginx >/dev/null
mkdir -p test-results/nginx
result_dir=$(cd test-results/nginx && pwd)
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 -subj /CN=transfer.example.test \
    -keyout "$result_dir/key.pem" -out "$result_dir/cert.pem" >/dev/null 2>&1
sed -e 's|@DOMAIN@|transfer.example.test|g' \
    -e "s|@TLS_CERT@|$result_dir/cert.pem|g" -e "s|@TLS_KEY@|$result_dir/key.pem|g" \
    -e "s|/var/log/nginx/zeydrop.access.log|$result_dir/access.log|g" \
    -e "s|/var/log/nginx/zeydrop.error.log|$result_dir/error.log|g" \
    deployment/nginx.conf > "$result_dir/site.conf"
printf 'pid %s/nginx.pid;\nerror_log %s/error.log;\nevents {}\nhttp { include %s/site.conf; }\n' "$result_dir" "$result_dir" "$result_dir" > "$result_dir/nginx.conf"
nginx -t -p "$result_dir/" -c "$result_dir/nginx.conf"
rm -f "$result_dir/key.pem"
