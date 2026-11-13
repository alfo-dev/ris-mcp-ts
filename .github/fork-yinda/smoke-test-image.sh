#!/usr/bin/env bash
#
# Smoke test for the custom-CA support of the built image.
# Usage: smoke-test-image.sh <image>
#
# Verifies, against a real container:
#   1. the app process does NOT run as root (privilege drop works)
#   2. a mounted *.crt AND a mounted *.pem both land in the system bundle
#   3. NODE_EXTRA_CA_CERTS points at the updated bundle
#   4. the container still starts (and still drops privileges) without a mount
set -euo pipefail
IMAGE="${1:?usage: smoke-test-image.sh <image>}"

fail() { echo "::error::smoke-test: $*" >&2; exit 1; }

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/certs"

mkcert() { # name
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=ca-update-test-$1" \
    -keyout "$tmp/$1.key" -out "$tmp/certs/$1" 2>/dev/null
}
mkcert test-a.crt
mkcert test-b.pem
chmod -R a+rX "$tmp/certs"

# A distinctive base64 line from each certificate (line 2 of the PEM body).
marker_a="$(sed -n 2p "$tmp/certs/test-a.crt")"
marker_b="$(sed -n 2p "$tmp/certs/test-b.pem")"

echo "== with mounted certificates"
out="$(docker run --rm -v "$tmp/certs:/opt/custom-certificates:ro" "$IMAGE" \
  sh -c 'echo "UID=$(id -u)"; echo "EXTRA=$NODE_EXTRA_CA_CERTS"; cat /etc/ssl/certs/ca-certificates.crt')"

grep -qx 'UID=0' <<<"$out" && fail "application runs as root"
grep -qE '^UID=[1-9][0-9]*$' <<<"$out" || fail "could not determine non-root uid"
grep -qx 'EXTRA=/etc/ssl/certs/ca-certificates.crt' <<<"$out" || fail "NODE_EXTRA_CA_CERTS not set"
grep -qF -- "$marker_a" <<<"$out" || fail "*.crt certificate missing from system bundle"
grep -qF -- "$marker_b" <<<"$out" || fail "*.pem certificate missing from system bundle"
echo "ok: non-root, NODE_EXTRA_CA_CERTS set, .crt and .pem installed"

echo "== without mounted certificates"
uid="$(docker run --rm "$IMAGE" id -u)"
[ "$uid" != "0" ] || fail "application runs as root without mount"
echo "ok: starts without mount, uid=$uid"
