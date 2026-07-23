#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${BEEMAX_BIN_DIR:-${HOME}/.local/bin}"
DATA_HOME="${BEEMAX_HOME:-${HOME}/.beemax}"
CLI="${ROOT}/apps/cli/dist/cli.js"

node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 19)) {
  console.error(`BeeMax requires Node.js 22.19 or newer; found ${process.versions.node}`);
  process.exit(1);
}
'

cd "${ROOT}"
[[ -f "${ROOT}/pi/package.json" ]] || {
  echo "BeeMax source install failed: vendored Pi source is missing." >&2
  exit 1
}
bash "${ROOT}/scripts/install-media-dependencies.sh"
npm ci
npm run build

mkdir -p "${BIN_DIR}"
chmod +x "${CLI}"
NODE="$(command -v node)"
printf '#!/usr/bin/env bash\n# BeeMax command\nexport BEEMAX_ROOT=%q\nexport BEEMAX_INSTALL_DIR=%q\nexport BEEMAX_BIN_DIR=%q\nexport BEEMAX_HOME=%q\nexec %q %q "$@"\n' "${ROOT}" "${ROOT}" "${BIN_DIR}" "${DATA_HOME}" "${NODE}" "${CLI}" > "${BIN_DIR}/beemax"
chmod 0755 "${BIN_DIR}/beemax"

if [[ -f "${ROOT}/.beemax-release-payload" ]] \
	&& grep -Fxq "BeeMax verified release payload" "${ROOT}/.beemax-release-payload"; then
	[[ "${DATA_HOME}" == /* ]] || {
		echo "BeeMax release install failed: BEEMAX_HOME must be absolute." >&2
		exit 1
	}
	case "${DATA_HOME}" in
		*/../*|*/..|*/./*|*/.)
			echo "BeeMax release install failed: BEEMAX_HOME may not contain . or .. path segments." >&2
			exit 1
			;;
		"${ROOT}"|"${ROOT}"/*)
			echo "BeeMax release install failed: BEEMAX_HOME must be outside the application directory." >&2
			exit 1
			;;
	esac
	if [[ -e "${DATA_HOME}" || -L "${DATA_HOME}" ]]; then
		RESOLVED_DATA_HOME="$(cd -P "${DATA_HOME}" && pwd)"
		case "${RESOLVED_DATA_HOME}" in
			"${ROOT}"|"${ROOT}"/*)
				echo "BeeMax release install failed: resolved BEEMAX_HOME must be outside the application directory." >&2
				exit 1
				;;
		esac
	fi
	RELEASE_VERSION="$(sed -n 's/^version=//p' "${ROOT}/.beemax-release-payload" | head -n 1)"
	[[ "${RELEASE_VERSION}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]] || {
		echo "BeeMax release install failed: invalid release payload version." >&2
		exit 1
	}
	printf 'BeeMax verified release install\ninstall-root=%s\nversion=%s\n' "${ROOT}" "${RELEASE_VERSION}" > "${ROOT}/.beemax-release-install"
	mkdir -p "${DATA_HOME}"
	printf 'BeeMax Profile Home\ninstall-root=%s\n' "${ROOT}" > "${DATA_HOME}/.beemax-home"
fi

echo "BeeMax installed: ${BIN_DIR}/beemax"
case ":${PATH}:" in
  *":${BIN_DIR}:"*) ;;
  *) echo "Add ${BIN_DIR} to PATH, then open a new shell." ;;
esac
echo "Next: beemax init --profile personal"
