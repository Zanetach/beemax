#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${THRUVERA_BIN_DIR:-${BEEMAX_BIN_DIR:-${HOME}/.local/bin}}"
CLI="${ROOT}/apps/cli/dist/cli.js"

node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 19)) {
  console.error(`Thruvera requires Node.js 22.19 or newer; found ${process.versions.node}`);
  process.exit(1);
}
'

cd "${ROOT}"
[[ -f "${ROOT}/pi/package.json" ]] || {
  echo "Thruvera source install failed: vendored Pi source is missing." >&2
  exit 1
}
bash "${ROOT}/scripts/install-media-dependencies.sh"
npm ci
npm run build

mkdir -p "${BIN_DIR}"
chmod +x "${CLI}"
NODE="$(command -v node)"
printf '#!/usr/bin/env bash\nexport THRUVERA_ROOT=%q\nexec %q %q "$@"\n' "${ROOT}" "${NODE}" "${CLI}" > "${BIN_DIR}/thruvera"
cp "${BIN_DIR}/thruvera" "${BIN_DIR}/beemax"
chmod 0755 "${BIN_DIR}/thruvera" "${BIN_DIR}/beemax"

echo "Thruvera installed: ${BIN_DIR}/thruvera"
case ":${PATH}:" in
  *":${BIN_DIR}:"*) ;;
  *) echo "Add ${BIN_DIR} to PATH, then open a new shell." ;;
esac
echo "Next: thruvera init --profile personal"
