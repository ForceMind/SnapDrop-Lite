#!/usr/bin/env bash
# Zeydrop HTTPS deployment. Uses an existing domain/certificate, never buys one.
set -euo pipefail
cd "$(dirname "$0")"
if [[ ${EUID} -ne 0 ]]; then echo 'Run as root on the deployment host.' >&2; exit 1; fi
: "${DOMAIN:?Set DOMAIN to a domain you own}"
: "${TLS_CERT:?Set TLS_CERT to the fullchain PEM path}"
: "${TLS_KEY:?Set TLS_KEY to the private key PEM path}"
[[ $DOMAIN =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ && $DOMAIN == *.* ]] || { echo 'Invalid DOMAIN' >&2; exit 1; }
for item in "$TLS_CERT" "$TLS_KEY"; do [[ $item =~ ^/[a-zA-Z0-9_./-]+$ && -r $item ]] || { echo 'Invalid or unreadable certificate path' >&2; exit 1; }; done
for tool in node npm nginx systemctl openssl; do command -v "$tool" >/dev/null || { echo "Missing $tool" >&2; exit 1; }; done
node -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)'
openssl x509 -checkend 86400 -noout -in "$TLS_CERT"
openssl x509 -checkhost "$DOMAIN" -noout -in "$TLS_CERT"
cert_pub=$(openssl x509 -in "$TLS_CERT" -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256)
key_pub=$(openssl pkey -in "$TLS_KEY" -pubout -outform DER | openssl dgst -sha256)
[[ $cert_pub == "$key_pub" ]] || { echo 'Certificate and key do not match' >&2; exit 1; }
if systemctl is-active --quiet snapdrop; then echo 'Legacy snapdrop service is active. Follow docs/DEPLOYMENT.md migration; it has not been stopped.' >&2; exit 1; fi
npm ci --ignore-scripts
npm --prefix server ci --omit=dev --ignore-scripts
npm test
npm run build
revision=$(node -p "require('./dist/build.json').revision")
release="/opt/zeydrop/releases/$revision"
[[ ! -e $release ]] || { echo 'Release already exists; use rollback.sh to select it.' >&2; exit 1; }
id zeydrop >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin zeydrop
mkdir -p "$release" /etc/zeydrop
cp -r dist server "$release/"
chown -R root:root "$release"
chmod -R go-w "$release"
cat > /etc/zeydrop/signaling.env <<ENV
NODE_ENV=production
PORT=3001
WS_HOST=127.0.0.1
ALLOWED_ORIGINS=https://$DOMAIN
ENV
chmod 640 /etc/zeydrop/signaling.env
chown root:zeydrop /etc/zeydrop/signaling.env
sed "s|@NODE@|$(command -v node)|g" deployment/zeydrop.service > /etc/systemd/system/zeydrop.service
sed -e "s|@DOMAIN@|$DOMAIN|g" -e "s|@TLS_CERT@|$TLS_CERT|g" -e "s|@TLS_KEY@|$TLS_KEY|g" deployment/nginx.conf > /etc/nginx/conf.d/zeydrop.conf
previous=$(readlink -f /opt/zeydrop/current || true)
ln -s "$release" /opt/zeydrop/current.next
mv -Tf /opt/zeydrop/current.next /opt/zeydrop/current
if ! nginx -t; then
    if [[ -n $previous ]]; then ln -s "$previous" /opt/zeydrop/current.next; mv -Tf /opt/zeydrop/current.next /opt/zeydrop/current; fi
    echo 'Nginx validation failed; service has not been restarted. Restore configuration from your backup.' >&2; exit 1
fi
if [[ -n $previous ]]; then printf '%s\n' "$previous" > /opt/zeydrop/previous; fi
systemctl daemon-reload
systemctl enable zeydrop
systemctl restart zeydrop
systemctl reload nginx
systemctl is-active --quiet zeydrop
printf 'Deployed Zeydrop %s to https://%s\n' "$revision" "$DOMAIN"
