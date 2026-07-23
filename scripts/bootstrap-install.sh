#!/usr/bin/env bash
# BeeMax single-package installer for Linux and macOS.
set -euo pipefail

VERSION="${BEEMAX_VERSION:-latest}"
RELEASE_BASE="${BEEMAX_RELEASE_BASE:-https://github.com/Zanetach/beemax/releases/download}"
RELEASE_API="${BEEMAX_RELEASE_API:-https://api.github.com/repos/Zanetach/beemax/releases?per_page=1}"
INSTALL_DIR="${BEEMAX_INSTALL_DIR:-${HOME}/.beemax/app}"
BIN_DIR="${BEEMAX_BIN_DIR:-${HOME}/.local/bin}"
QUICKSTART=0
PROFILE="${BEEMAX_PROFILE:-personal}"

usage() {
	cat <<'EOF'
BeeMax installer

Usage:
  curl -fsSL https://raw.githubusercontent.com/Zanetach/beemax/main/scripts/bootstrap-install.sh | bash
  curl -fsSL https://raw.githubusercontent.com/Zanetach/beemax/main/scripts/bootstrap-install.sh | bash -s -- --quickstart

Options:
  --version <tag>  Install a specific release tag
  --dir <path>     Install application files at this path
  --quickstart     Configure or verify a Profile, then open BeeMax chat
  --profile <name> Profile used by --quickstart (default: personal)
  --uninstall      Remove application files and command, keeping Profiles and data
  --help           Show this help

Environment:
  BEEMAX_VERSION, BEEMAX_RELEASE_BASE, BEEMAX_RELEASE_API, BEEMAX_INSTALL_DIR, BEEMAX_BIN_DIR, BEEMAX_PROFILE
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
		--quickstart) QUICKSTART=1; shift ;;
		--profile) PROFILE="${2:?--profile requires a value}"; shift 2 ;;
		--uninstall)
			if [[ -f "${BIN_DIR}/beemax" ]] && grep -Fq "BEEMAX_ROOT=${INSTALL_DIR}" "${BIN_DIR}/beemax"; then rm "${BIN_DIR}/beemax"; fi
			if [[ -f "${INSTALL_DIR}/package.json" ]] && grep -Fq '"name": "beemax-agent"' "${INSTALL_DIR}/package.json"; then rm -rf "${INSTALL_DIR}"; fi
			echo "BeeMax application files removed. Profiles and data under ${HOME}/.beemax/profiles were kept."
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
	[[ "${VERSION}" =~ ^v[0-9] ]] || fail "could not resolve the latest BeeMax release"
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

ARCHIVE="beemax-${VERSION}.tar.gz"
TEMP="$(mktemp -d)"
BACKUP="${INSTALL_DIR}.previous-$$"
trap 'rm -rf "${TEMP}"' EXIT

curl --fail --location --silent --show-error "${RELEASE_BASE}/${VERSION}/${ARCHIVE}" -o "${TEMP}/${ARCHIVE}"
curl --fail --location --silent --show-error "${RELEASE_BASE}/${VERSION}/${ARCHIVE}.sha256" -o "${TEMP}/${ARCHIVE}.sha256"
EXPECTED="$(awk '{print $1}' "${TEMP}/${ARCHIVE}.sha256")"
ACTUAL="$(${CHECKSUM_COMMAND} "${TEMP}/${ARCHIVE}" | awk '{print $1}')"
[[ -n "${EXPECTED}" && "${EXPECTED}" == "${ACTUAL}" ]] || fail "release archive checksum verification failed"

tar -xzf "${TEMP}/${ARCHIVE}" -C "${TEMP}"
[[ -f "${TEMP}/beemax/package.json" ]] || fail "release archive has an invalid layout"
mkdir -p "$(dirname "${INSTALL_DIR}")"

if [[ -e "${INSTALL_DIR}" ]]; then
	[[ -f "${INSTALL_DIR}/package.json" ]] && grep -Fq '"name": "beemax-agent"' "${INSTALL_DIR}/package.json" || fail "install directory is not a BeeMax installation: ${INSTALL_DIR}"
	mv "${INSTALL_DIR}" "${BACKUP}"
fi
mv "${TEMP}/beemax" "${INSTALL_DIR}"

if ! BEEMAX_BIN_DIR="${BIN_DIR}" "${INSTALL_DIR}/scripts/install.sh"; then
	rm -rf "${INSTALL_DIR}"
	if [[ -d "${BACKUP}" ]]; then mv "${BACKUP}" "${INSTALL_DIR}"; fi
	fail "application setup failed; previous installation was restored"
fi
rm -rf "${BACKUP}"
echo "BeeMax ${VERSION} installed from one verified release archive."
if [[ "${QUICKSTART}" == "1" ]]; then
	[[ -r /dev/tty ]] || fail "--quickstart requires an interactive terminal; rerun beemax quickstart --profile ${PROFILE}"
	"${BIN_DIR}/beemax" quickstart --profile "${PROFILE}" < /dev/tty
else
	echo "Next: beemax quickstart --profile ${PROFILE}"
fi
