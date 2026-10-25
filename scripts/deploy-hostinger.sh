#!/usr/bin/env bash
#
# Deploy an archive to a Hostinger shared-hosting website.
#
#   scripts/deploy-hostinger.sh path/to/site.zip
#
# Sequence: generate TUS upload credentials → upload the archive → trigger the
# server-side extraction → wait for the files → verify the site answers →
# leave no downloadable archive behind.
#
# Required env: HOSTINGER_API_TOKEN
# Optional env: HOSTINGER_API (default https://developers.hostinger.com)
#               HOSTINGER_USERNAME (default u170282392)
#               HOSTINGER_DOMAIN   (default vva.chrif.net)
#
set -euo pipefail

API="${HOSTINGER_API:-https://developers.hostinger.com}"
ACC="${HOSTINGER_USERNAME:-u170282392}"
DOMAIN="${HOSTINGER_DOMAIN:-vva.chrif.net}"
ARCHIVE="${1:?usage: deploy-hostinger.sh <archive>}"

die() { echo "::error::$*" >&2; exit 1; }

[ -n "${HOSTINGER_API_TOKEN:-}" ] || die "HOSTINGER_API_TOKEN is not set"
command -v jq >/dev/null 2>&1 || die "jq is required"
command -v curl >/dev/null 2>&1 || die "curl is required"
[ -f "$ARCHIVE" ] || die "archive not found: $ARCHIVE"

ARCHIVE=$(cd "$(dirname "$ARCHIVE")" && pwd)/$(basename "$ARCHIVE")
NAME=$(basename "$ARCHIVE")
SIZE=$(stat -c%s "$ARCHIVE")
AUTH=(-H "Authorization: Bearer ${HOSTINGER_API_TOKEN}" -H "Content-Type: application/json" -H "Accept: application/json")
# Retries + bounded timeouts: a single slow round-trip must never fail a deploy.
CURL=(--retry 4 --retry-all-errors --retry-delay 3 --connect-timeout 20 --max-time 600)

request_creds() {
  CREDS=$(curl -fsS "${CURL[@]}" -X POST "$API/api/hosting/v1/files/upload-urls" "${AUTH[@]}" \
    --data "$(jq -n --arg u "$ACC" --arg d "$DOMAIN" '{username: $u, domain: $d}')") \
    || { echo "could not get upload credentials" >&2; return 1; }
  URL=$(jq -r '.url // empty' <<<"$CREDS")
  AK=$(jq -r '.auth_key // empty' <<<"$CREDS")
  RK=$(jq -r '.rest_auth_key // empty' <<<"$CREDS")
  [ -n "$URL" ] && [ -n "$AK" ] && [ -n "$RK" ] || { echo "unexpected credential response: $CREDS" >&2; return 1; }
}

echo "→ requesting upload credentials"
request_creds || die "no upload credentials"

TUS=(-H "X-Auth: $AK" -H "X-Auth-Rest: $RK" -H "Tus-Resumable: 1.0.0")

# TUS create + upload, retried with fresh credentials each time.
tus_upload() {
  local attempt code
  for attempt in 1 2 3; do
    request_creds || { sleep 5; continue; }
    TUS=(-H "X-Auth: $AK" -H "X-Auth-Rest: $RK" -H "Tus-Resumable: 1.0.0")
    echo "→ opening upload slot for $NAME ($((SIZE / 1024 / 1024)) MB), attempt $attempt/3"
    code=$(curl -sS "${CURL[@]}" -o /tmp/tus.log -w '%{http_code}' -X POST "$URL/$NAME?override=true" "${TUS[@]}" \
      -H "Upload-Length: $SIZE" -H "Upload-Offset: 0" 2>/tmp/tus.err) || code=0
    [ "$code" = "201" ] || { echo "   create returned ${code:-curl-error}: $(cat /tmp/tus.err /tmp/tus.log 2>/dev/null | tr '\n' ' ' | cut -c1-300)" >&2; sleep 6; continue; }

    echo "→ uploading"
    code=$(curl -sS "${CURL[@]}" -o /tmp/tus.log -w '%{http_code}' -X PATCH "$URL/$NAME?override=true" "${TUS[@]}" \
      -H "Upload-Offset: 0" -H "Content-Type: application/offset+octet-stream" \
      --data-binary "@$ARCHIVE" 2>/tmp/tus.err) || code=0
    [ "$code" = "204" ] || { echo "   upload returned ${code:-curl-error}: $(cat /tmp/tus.err /tmp/tus.log 2>/dev/null | tr '\n' ' ' | cut -c1-300)" >&2; sleep 6; continue; }
    return 0
  done
  return 1
}

tus_upload || die "upload failed after 3 attempts"

echo "→ extracting on the server"
curl -fsS "${CURL[@]}" -X POST "$API/api/hosting/v1/accounts/$ACC/websites/$DOMAIN/deploy" "${AUTH[@]}" \
  --data "$(jq -n --arg a "$NAME" '{archive_path: $a}')" >/dev/null \
  || die "deploy request rejected"

echo "→ waiting for the files to land"
ready=0
for _ in $(seq 1 24); do
  sleep 5
  files=$(curl -fsS "${CURL[@]}" -H "Authorization: Bearer ${HOSTINGER_API_TOKEN}" \
    "$API/api/hosting/v1/accounts/$ACC/domains/$DOMAIN/files?max_depth=1&max_items=80" 2>/dev/null || true)
  if jq -e '([.items[]?.name] | (index("index.html") != null) and (index(".env") != null))' \
      <<<"$files" >/dev/null 2>&1; then
    ready=1
    break
  fi
done
[ "$ready" = "1" ] || die "files did not appear within 2 minutes"

echo "→ verifying https://$DOMAIN"
ok=0
for _ in $(seq 1 12); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://$DOMAIN/api/categories.php" || true)
  if [ "$code" = "200" ]; then ok=1; break; fi
  echo "   HTTP ${code:-none}, retrying"
  sleep 10
done
[ "$ok" = "1" ] || die "site did not answer HTTP 200"

# Leave nothing downloadable behind: replace the archive with a zero-byte file
# (the API exposes no delete). It is also a dotfile, which .htaccess denies.
echo "→ clearing the uploaded archive"
curl -s -o /dev/null -X POST "$URL/$NAME?override=true" "${TUS[@]}" \
  -H "Upload-Length: 0" -H "Upload-Offset: 0" || true

echo "✓ deployed to https://$DOMAIN"
