#!/usr/bin/env bash
# BeeMax one-command installer for Linux and macOS.
set -euo pipefail

REPOSITORY="${BEEMAX_REPOSITORY:-https://github.com/Zanetach/beemax.git}"
VERSION="${BEEMAX_VERSION:-v0.1.0-preview.2}"
INSTALL_DIR="${BEEMAX_INSTALL_DIR:-${HOME}/.beemax/app}"
BIN_DIR="${BEEMAX_BIN_DIR:-${HOME}/.local/bin}"

usage() {
	cat <<'EOF'
BeeMax installer

Usage:
  curl -fsSL https://raw.githubusercontent.com/Zanetach/beemax/v0.1.0-preview.2/scripts/bootstrap-install.sh | bash

Options:
  --version <tag-or-branch>  Install a specific version
  --dir <path>               Install application files at this path
  --uninstall                Remove the BeeMax command and application files (keeps Profiles and data)
  --help                     Show this help

Environment:
  BEEMAX_VERSION, BEEMAX_INSTALL_DIR, BEEMAX_BIN_DIR, BEEMAX_REPOSITORY
EOF
}

fail() {
	echo "BeeMax install failed: $*" >&2
	exit 1
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--version) VERSION="${2:?--version requires a value}"; shift 2 ;;
		--dir) INSTALL_DIR="${2:?--dir requires a value}"; shift 2 ;;
		--uninstall)
			if [[ -f "${BIN_DIR}/beemax" ]] && grep -Fq "BEEMAX_ROOT=${INSTALL_DIR}" "${BIN_DIR}/beemax"; then rm "${BIN_DIR}/beemax"; fi
			if [[ -d "${INSTALL_DIR}/.git" ]]; then rm -rf "${INSTALL_DIR}"; fi
			echo "BeeMax application files removed. Profiles and data under ${HOME}/.beemax/profiles were kept."
			exit 0
			;;
		--help|-h) usage; exit 0 ;;
		*) fail "unknown option: $1" ;;
	esac
done

command -v git >/dev/null 2>&1 || fail "git is required; install git and retry"
command -v node >/dev/null 2>&1 || fail "Node.js 22.19+ is required; install it and retry"
node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 19)) process.exit(1);
' || fail "Node.js 22.19+ is required; found $(node --version)"

if [[ -e "${INSTALL_DIR}" && ! -d "${INSTALL_DIR}/.git" ]]; then
	fail "install directory exists but is not a BeeMax git checkout: ${INSTALL_DIR}"
fi

if [[ -d "${INSTALL_DIR}/.git" ]]; then
	git -C "${INSTALL_DIR}" diff --quiet || fail "installation directory has uncommitted changes: ${INSTALL_DIR}"
	git -C "${INSTALL_DIR}" fetch --tags origin
	git -C "${INSTALL_DIR}" checkout --detach "${VERSION}"
	git -C "${INSTALL_DIR}" submodule update --init --recursive
else
	mkdir -p "$(dirname "${INSTALL_DIR}")"
	git clone --branch "${VERSION}" --recurse-submodules "${REPOSITORY}" "${INSTALL_DIR}"
fi

BEEMAX_BIN_DIR="${BIN_DIR}" "${INSTALL_DIR}/scripts/install.sh"
echo "BeeMax ${VERSION} installed. Next: beemax setup --profile personal"
