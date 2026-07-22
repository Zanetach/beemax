#!/usr/bin/env bash
# Thruvera single-package installer for Linux and macOS.
set -euo pipefail

VERSION="${THRUVERA_VERSION:-${BEEMAX_VERSION:-latest}}"
RELEASE_BASE="${THRUVERA_RELEASE_BASE:-${BEEMAX_RELEASE_BASE:-https://github.com/Zanetach/beemax/releases/download}}"
RELEASE_API="${THRUVERA_RELEASE_API:-${BEEMAX_RELEASE_API:-https://api.github.com/repos/Zanetach/beemax/releases?per_page=1}}"
DEFAULT_INSTALL_DIR="${HOME}/.thruvera/app"
if [[ ! -e "${DEFAULT_INSTALL_DIR}" && -e "${HOME}/.beemax/app" ]]; then DEFAULT_INSTALL_DIR="${HOME}/.beemax/app"; fi
INSTALL_DIR="${THRUVERA_INSTALL_DIR:-${BEEMAX_INSTALL_DIR:-${DEFAULT_INSTALL_DIR}}}"
BIN_DIR="${THRUVERA_BIN_DIR:-${BEEMAX_BIN_DIR:-${HOME}/.local/bin}}"

usage() {
	cat <<'EOF'
Thruvera installer

Usage:
  curl -fsSL https://raw.githubusercontent.com/Zanetach/beemax/v1.0.0/scripts/bootstrap-install.sh | bash

Options:
  --version <tag>  Install a specific release tag
  --dir <path>     Install application files at this path
  --uninstall      Remove application files and command, keeping Profiles and data
  --help           Show this help

Environment:
  THRUVERA_VERSION, THRUVERA_RELEASE_BASE, THRUVERA_RELEASE_API, THRUVERA_INSTALL_DIR, THRUVERA_BIN_DIR

Legacy BEEMAX_* installer variables remain accepted during the rename transition.
EOF
}

fail() {
	echo "Thruvera install failed: $*" >&2
	exit 1
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--version) VERSION="${2:?--version requires a value}"; shift 2 ;;
		--dir) INSTALL_DIR="${2:?--dir requires a value}"; shift 2 ;;
		--uninstall)
			for command_path in "${BIN_DIR}/thruvera" "${BIN_DIR}/beemax"; do
				if [[ -f "${command_path}" ]] && { grep -Fq "THRUVERA_ROOT=${INSTALL_DIR}" "${command_path}" || grep -Fq "BEEMAX_ROOT=${INSTALL_DIR}" "${command_path}"; }; then rm "${command_path}"; fi
			done
			if [[ -f "${INSTALL_DIR}/package.json" ]] && grep -Eq '"name": "(thruvera|beemax)-agent"' "${INSTALL_DIR}/package.json"; then rm -rf "${INSTALL_DIR}"; fi
			echo "Thruvera application files removed. Profile data was kept."
			exit 0
			;;
		--help|-h) usage; exit 0 ;;
		*) fail "unknown option: $1" ;;
	esac
done

for command in curl tar node npm; do
	command -v "${command}" >/dev/null 2>&1 || fail "${command} is required; install it and retry"
done
if [[ "${VERSION}" == "latest" ]]; then
	VERSION="$(curl --fail --location --silent --show-error "${RELEASE_API}" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
	[[ "${VERSION}" =~ ^v[0-9] ]] || fail "could not resolve the latest Thruvera release"
fi
if command -v shasum >/dev/null 2>&1; then
	CHECKSUM_COMMAND="shasum -a 256"
elif command -v sha256sum >/dev/null 2>&1; then
	CHECKSUM_COMMAND="sha256sum"
else
	fail "shasum or sha256sum is required; install one and retry"
fi
node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 19)) process.exit(1);
' || fail "Node.js 22.19+ is required; found $(node --version)"

ARCHIVE="thruvera-${VERSION}.tar.gz"
TEMP="$(mktemp -d)"
BACKUP="${INSTALL_DIR}.previous-$$"
trap 'rm -rf "${TEMP}"' EXIT

curl --fail --location --silent --show-error "${RELEASE_BASE}/${VERSION}/${ARCHIVE}" -o "${TEMP}/${ARCHIVE}"
curl --fail --location --silent --show-error "${RELEASE_BASE}/${VERSION}/${ARCHIVE}.sha256" -o "${TEMP}/${ARCHIVE}.sha256"
EXPECTED="$(awk '{print $1}' "${TEMP}/${ARCHIVE}.sha256")"
ACTUAL="$(${CHECKSUM_COMMAND} "${TEMP}/${ARCHIVE}" | awk '{print $1}')"
[[ -n "${EXPECTED}" && "${EXPECTED}" == "${ACTUAL}" ]] || fail "release archive checksum verification failed"

tar -xzf "${TEMP}/${ARCHIVE}" -C "${TEMP}"
[[ -f "${TEMP}/thruvera/package.json" ]] || fail "release archive has an invalid layout"
mkdir -p "$(dirname "${INSTALL_DIR}")"

if [[ -e "${INSTALL_DIR}" ]]; then
	[[ -f "${INSTALL_DIR}/package.json" ]] && grep -Eq '"name": "(thruvera|beemax)-agent"' "${INSTALL_DIR}/package.json" || fail "install directory is not a Thruvera installation: ${INSTALL_DIR}"
	mv "${INSTALL_DIR}" "${BACKUP}"
fi
mv "${TEMP}/thruvera" "${INSTALL_DIR}"

if ! THRUVERA_BIN_DIR="${BIN_DIR}" "${INSTALL_DIR}/scripts/install.sh"; then
	rm -rf "${INSTALL_DIR}"
	if [[ -d "${BACKUP}" ]]; then mv "${BACKUP}" "${INSTALL_DIR}"; fi
	fail "application setup failed; previous installation was restored"
fi
rm -rf "${BACKUP}"
echo "Thruvera ${VERSION} installed from one verified release archive. Next: thruvera setup --profile personal"
