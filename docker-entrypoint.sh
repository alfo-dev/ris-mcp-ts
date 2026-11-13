#!/bin/sh
# Container entrypoint: installs custom CA certificates, then runs the CMD as
# the unprivileged `node` user.
#
# Mount a directory with *.crt / *.pem files at /opt/custom-certificates to have
# them added to the system trust store (and to Node via NODE_EXTRA_CA_CERTS).
#
# CERT_DIR / CA_BUNDLE_DIR can be overridden through the environment; this is
# only meant for testing.
set -e

CERT_DIR="${CERT_DIR:-/opt/custom-certificates}"
CA_BUNDLE_DIR="${CA_BUNDLE_DIR:-/usr/local/share/ca-certificates}"

# Already unprivileged (e.g. `docker run --user`, runAsNonRoot): the trust store
# cannot be modified, so skip injection instead of failing the container.
if [ "$(id -u)" != "0" ]; then
  echo "[entrypoint] Not running as root - skipping custom CA injection."
  exec "$@"
fi

if [ -d "$CERT_DIR" ]; then
  CERT_COUNT=0

  for cert in "$CERT_DIR"/*.crt "$CERT_DIR"/*.pem; do
    # Skip glob patterns that didn't match any file
    [ -f "$cert" ] || continue

    CERT_NAME="$(basename "$cert")"
    # update-ca-certificates only processes files ending in .crt, so *.pem files
    # are installed under a .crt name.
    TARGET_NAME="${CERT_NAME%.*}.crt"
    echo "[entrypoint] Installing custom CA certificate: $CERT_NAME"
    cp "$cert" "$CA_BUNDLE_DIR/$TARGET_NAME"
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
  echo "[entrypoint] Custom certificate directory $CERT_DIR not mounted - skipping CA injection."
fi

# Drop privileges: the application must not run as root.
exec su-exec node "$@"
