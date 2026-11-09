#!/usr/bin/env bash
# Vendor agent-threads' TypeScript packages into potfit/vendor/ as npm tarballs.
#
#   scripts/vendor-agent-threads.sh [<commit or branch>]   (default: main)
#
# agent-threads isn't published to npm, so potfit depends on packed tarballs of its protocol, Node
# and React packages (package.json: file:vendor/...). This clones dire-kiwi/agent-threads at the
# given commit, builds its packages with pnpm, packs them (pnpm turns their workspace:* dependencies
# into versions) and records the commit in vendor/AGENT_THREADS. Run `npm install` afterwards.
# Needs git, Node 24+ and pnpm.
set -euo pipefail

ref=${1:-main}
repo=${AGENT_THREADS_REPO:-https://github.com/dire-kiwi/agent-threads}
here=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

git clone --quiet "$repo" "$work/agent-threads"
git -C "$work/agent-threads" checkout --quiet "$ref"
commit=$(git -C "$work/agent-threads" rev-parse HEAD)
echo "==> agent-threads $commit"
(cd "$work/agent-threads/ts" && pnpm install --frozen-lockfile --silent && pnpm build)

rm -f "$here"/vendor/dire-kiwi-agent-threads-*.tgz
for pkg in protocol node react; do
  (cd "$work/agent-threads/ts/packages/$pkg" && pnpm pack --pack-destination "$here/vendor" > /dev/null)
done
printf '%s\n' "$commit" > "$here/vendor/AGENT_THREADS"
ls -l "$here/vendor"
