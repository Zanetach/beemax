#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${HOME}/.local/bin"
CLI="${ROOT}/apps/cli/dist/cli.js"

node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 19)) {
  console.error(`BeeMax requires Node.js 22.19 or newer; found ${process.versions.node}`);
  process.exit(1);
}
'

cd "${ROOT}"
if [[ ! -f "${ROOT}/pi/package.json" ]]; then
  git submodule update --init --recursive
fi
npm ci --ignore-scripts
npm run build

mkdir -p "${BIN_DIR}"
chmod +x "${CLI}"
ln -sfn "${CLI}" "${BIN_DIR}/beemax"

echo "BeeMax installed: ${BIN_DIR}/beemax"
case ":${PATH}:" in
  *":${BIN_DIR}:"*) ;;
  *) echo "Add ${BIN_DIR} to PATH, then open a new shell." ;;
esac
echo "Next: beemax init --profile personal"
