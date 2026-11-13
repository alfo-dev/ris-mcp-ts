#!/usr/bin/env bash
#
# Re-applies the yinda-dev customization (custom CA certificate support) on top
# of the alfo-dev release that was just merged.
#
# Idempotent. Fails loudly if an anchor in the Dockerfile has moved, so a
# half-patched Dockerfile can never be committed.
#
# Fork-only files (never touched by alfo-dev, no patching needed):
#   docker-entrypoint.sh
#   .github/workflows/sync-from-alfo.yml, tag-synced-from-alfo.yml
#   .github/fork-yinda/*
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

die() { echo "::error::apply-ca-update: $*" >&2; exit 1; }

# ── 1. alfo-dev's own upstream-sync pipeline must not run in this repo ──────
# (it would sync from Honeyfield-Org and tag with the wrong branch prefix)
rm -rf .github/fork
rm -f .github/workflows/sync-upstream.yml .github/workflows/tag-synced-release.yml

# ── 2. Entrypoint must exist and must drop privileges ───────────────────────
[ -f docker-entrypoint.sh ] || die "docker-entrypoint.sh missing (fork-only file)"
grep -q 'exec su-exec node' docker-entrypoint.sh \
  || die "docker-entrypoint.sh no longer drops privileges via su-exec"

# ── 3. Dockerfile: CA packages, entrypoint, no USER node ────────────────────
python3 - Dockerfile <<'PY'
import re, sys
path = sys.argv[1]
s = open(path).read()
if "docker-entrypoint.sh" in s:
    sys.exit(0)                      # already patched

idx = s.rfind("\nFROM ")
if idx < 0:
    sys.exit("Dockerfile: no FROM found")
head, final = s[: idx + 1], s[idx + 1:]

def sub1(pattern, text, what):
    new, n = re.subn(pattern, lambda m: text, final_ref[0], count=1, flags=re.M)
    if n != 1:
        sys.exit(f"Dockerfile: anchor not found ({what}) - upstream layout changed?")
    final_ref[0] = new

final_ref = [final]
sub1(r"^RUN corepack enable pnpm[ \t]*$",
     "# ca-certificates: system CA bundle + update-ca-certificates.\n"
     "# su-exec: lets the entrypoint drop from root to the node user.\n"
     "RUN corepack enable pnpm \\\n && apk add --no-cache ca-certificates su-exec",
     "corepack enable")
sub1(r"^EXPOSE 3000[ \t]*\n+USER node[ \t]*$",
     "# The entrypoint installs custom CA certificates (mounted at\n"
     "# /opt/custom-certificates) as root and then drops to the node user.\n"
     "COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh\n"
     "RUN chmod +x /usr/local/bin/docker-entrypoint.sh \\\n"
     " && mkdir -p /opt/custom-certificates /usr/local/share/ca-certificates\n"
     "\n"
     "EXPOSE 3000\n"
     "# No `USER node` here on purpose: the entrypoint needs root for\n"
     "# update-ca-certificates and then runs the CMD as node via su-exec.",
     "EXPOSE 3000 + USER node")
sub1(r"^CMD \[",
     'ENTRYPOINT ["docker-entrypoint.sh"]\nCMD [',
     "CMD")
open(path, "w").write(head + final_ref[0])
PY
grep -q '^ENTRYPOINT \["docker-entrypoint.sh"\]' Dockerfile || die "Dockerfile: ENTRYPOINT missing after patch"
if awk '/^FROM /{n++} n>=2 && /^USER /{found=1} END{exit !found}' Dockerfile; then
  die "Dockerfile: runtime stage still has a USER directive"
fi

echo "apply-ca-update: done"
