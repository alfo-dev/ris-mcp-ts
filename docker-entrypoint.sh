#!/bin/sh
set -e

CERT_DIR="/opt/custom-certificates"
CA_BUNDLE_DIR="/usr/local/share/ca-certificates"

# Install any custom CA certificates found in the mounted folder
if [ -d "$CERT_DIR" ]; then
  CERT_COUNT=0

  for cert in "$CERT_DIR"/*.crt "$CERT_DIR"/*.pem; do
    # Skip glob patterns that didn't match any file
    [ -f "$cert" ] || continue

    CERT_NAME="$(basename "$cert")"
    echo "[entrypoint] Installing custom CA certificate: $CERT_NAME"
    cp "$cert" "$CA_BUNDLE_DIR/$CERT_NAME"
    CERT_COUNT=$((CERT_COUNT + 1))
  done

  if [ "$CERT_COUNT" -gt 0 ]; then
    echo "[entrypoint] Updating CA certificate store with $CERT_COUNT custom certificate(s)..."
    update-ca-certificates
    echo "[entrypoint] CA certificate store updated successfully."

    # Point Node.js to the updated system CA bundle so it trusts the new certs
    export NODE_EXTRA_CA_CERTS="/etc/ssl/certs/ca-certificates.crt"
  else
    echo "[entrypoint] No custom CA certificates found in $CERT_DIR (expected *.crt or *.pem files)."
  fi
else
  echo "[entrypoint] Custom certificate directory $CERT_DIR not mounted — skipping CA injection."
fi

exec "$@"
