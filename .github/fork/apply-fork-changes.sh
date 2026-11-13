#!/usr/bin/env bash
#
# Re-applies the fork's customizations on top of upstream-owned files.
#
# Idempotent: safe to run on a fresh upstream checkout or on an already
# patched tree. Fails loudly (non-zero exit) when an anchor it relies on has
# moved upstream, so a silent half-patch can never be committed.
#
# Fork-only files that need no patching (never touched by upstream):
#   .github/workflows/publish-docker-image.yaml
#   .github/workflows/sync-upstream.yml, tag-synced-release.yml
#   src/proxy-fetch.ts, src/__tests__/proxy-fetch.test.ts
#   .github/fork/*
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

die() { echo "::error::apply-fork-changes: $*" >&2; exit 1; }

# ── 1. Docker image publishing replaces the upstream ECR deploy ──────────────
rm -f .github/workflows/deploy.yml

# ── 2. CI: Node 24 only ──────────────────────────────────────────────────────
ci=.github/workflows/ci.yml
[ -f "$ci" ] || die "$ci missing"
sed -i -E \
  -e 's/node-version: \[20, 22\]/node-version: [24]/' \
  -e 's/matrix\.node-version == 22/matrix.node-version == 24/' "$ci"
grep -q 'node-version: \[24\]' "$ci" || die "ci.yml: matrix anchor not found"
grep -q 'matrix.node-version == 24' "$ci" || die "ci.yml: coverage condition anchor not found"

# ── 3. Dockerfile: Node 24 base images ───────────────────────────────────────
sed -i -E 's/^FROM node:22-alpine/FROM node:24-alpine/' Dockerfile
[ "$(grep -c '^FROM node:24-alpine' Dockerfile)" -ge 2 ] || die "Dockerfile: expected 2 node:24-alpine stages"

# ── 4. release.yml: keep only the `release` job ─────────────────────────────
# Upstream's npm / MCP-registry publishing and ECR build+deploy jobs are
# dropped: this fork publishes its image via publish-docker-image.yaml.
rel=.github/workflows/release.yml
[ -f "$rel" ] || die "$rel missing"
python3 - "$rel" <<'PY2'
import re, sys
path = sys.argv[1]
drop = {"publish-npm", "publish-registry", "build-image", "deploy-gateway", "deploy-lightsail"}
out, skipping, seen = [], False, set()
for line in open(path).read().split("\n"):
    m = re.match(r"^  ([A-Za-z0-9_-]+):\s*$", line)
    if m:                         # a top-level job starts
        seen.add(m.group(1))
        skipping = m.group(1) in drop
    elif re.match(r"^\S", line):   # left the `jobs:` block
        skipping = False
    if not skipping:
        out.append(line)
if "release" not in seen:
    sys.exit("release.yml: `release` job not found (upstream layout changed?)")
open(path, "w").write("\n".join(out).rstrip("\n") + "\n")
PY2
grep -q '^  release:' "$rel" || die "release.yml: release job lost"
if grep -qE '^  (publish-npm|publish-registry|build-image|deploy-gateway|deploy-lightsail):' "$rel"; then
  die "release.yml: a dropped job is still present"
fi

# ── 5. Proxy: route RIS requests through src/proxy-fetch.ts ──────────────────
[ -f src/proxy-fetch.ts ] || die "src/proxy-fetch.ts missing (fork-only file)"
fc=src/fetch-context.ts
[ -f "$fc" ] || die "$fc missing (upstream layout changed? re-point the proxy patch)"
if ! grep -q 'proxyFetch' "$fc"; then
  python3 - "$fc" <<'PY'
import sys
path = sys.argv[1]
s = open(path).read()
imp = "import { AsyncLocalStorage } from 'node:async_hooks';\n"
call = "override === undefined ? fetch(url, init) : override(url, init)"
if imp not in s or call not in s:
    sys.exit("fetch-context.ts: anchors not found (upstream layout changed?)")
s = s.replace(imp, imp + "\nimport { proxyFetch } from './proxy-fetch.js';\n", 1)
s = s.replace(call, "override === undefined ? proxyFetch(url, init) : override(url, init)", 1)
open(path, "w").write(s)
PY
fi
# Guard: nothing else in src/ may call the global fetch directly, otherwise it
# would silently bypass the proxy.
if grep -rnE '(^|[^.A-Za-z_])fetch\(' src --include='*.ts' \
     --exclude-dir=__tests__ --exclude=proxy-fetch.ts --exclude=fetch-context.ts \
     | grep -vE '^\S+:\s*[0-9]+:\s*(//|\*)' ; then
  die "direct fetch() calls found outside fetch-context.ts — route them through risFetch/proxyFetch"
fi

# ── 6. package.json: undici dependency + security floor override ────────────
node - <<'JS'
const fs = require('node:fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.dependencies = { ...pkg.dependencies, undici: '^7.24.0' };
pkg.dependencies = Object.fromEntries(Object.entries(pkg.dependencies).sort(([a], [b]) => a.localeCompare(b)));
pkg.pnpm = pkg.pnpm ?? {};
pkg.pnpm.overrides = { ...(pkg.pnpm.overrides ?? {}), undici: '^7.24.0' };
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
JS

# ── 7. Lockfile: regenerate instead of replaying a stale diff ───────────────
if command -v pnpm >/dev/null 2>&1; then
  pnpm install --lockfile-only --no-frozen-lockfile
else
  echo "pnpm not found - skipping lockfile refresh" >&2
fi

echo "apply-fork-changes: done"
