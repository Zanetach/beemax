#!/usr/bin/env bash
# Verify a BeeMax release archive by checksum, source layout, isolated install, and CLI startup.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:?Usage: scripts/verify-release-archive.sh <version> [archive-directory]}"
ARCHIVE_DIR="${2:-${ROOT}/dist/release}"
ARCHIVE="${ARCHIVE_DIR}/beemax-${VERSION}.tar.gz"
CHECKSUM="${ARCHIVE}.sha256"

fail() {
	echo "BeeMax release verification failed: $*" >&2
	exit 1
}

[[ -f "${ARCHIVE}" ]] || fail "archive not found: ${ARCHIVE}"
[[ -f "${CHECKSUM}" ]] || fail "sha256 checksum not found: ${CHECKSUM}"
EXPECTED="$(awk 'NR == 1 { print $1 }' "${CHECKSUM}")"
if command -v shasum >/dev/null 2>&1; then ACTUAL="$(shasum -a 256 "${ARCHIVE}" | awk '{ print $1 }')"
elif command -v sha256sum >/dev/null 2>&1; then ACTUAL="$(sha256sum "${ARCHIVE}" | awk '{ print $1 }')"
else fail "shasum or sha256sum is required"
fi
[[ -n "${EXPECTED}" && "${EXPECTED}" == "${ACTUAL}" ]] || fail "sha256 checksum mismatch"

STAGING="$(mktemp -d)"
trap 'rm -rf "${STAGING}"' EXIT
tar -xzf "${ARCHIVE}" -C "${STAGING}"
SOURCE="${STAGING}/beemax"
[[ -f "${SOURCE}/package.json" && -f "${SOURCE}/pi/package.json" ]] || fail "archive source layout is incomplete"
[[ "$(tr -d '\r\n' < "${SOURCE}/RELEASE_VERSION")" == "${VERSION}" ]] || fail "RELEASE_VERSION does not match ${VERSION}"
if find "${SOURCE}" \( -name .git -o -name node_modules -o -name dist -o -name '*.tsbuildinfo' \) -print -quit | grep -q .; then
	fail "archive contains Git metadata, node_modules, dist, or TypeScript build state"
fi

mkdir -p "${STAGING}/home" "${STAGING}/bin"
HOME="${STAGING}/home" BEEMAX_BIN_DIR="${STAGING}/bin" bash "${SOURCE}/scripts/install.sh"
HELP_OUTPUT="$(HOME="${STAGING}/home" "${STAGING}/bin/beemax" --help)"
grep -Fq "BeeMax" <<<"${HELP_OUTPUT}" || fail "installed beemax --help did not start correctly"
[[ "$(tr -d '\r\n' < "${SOURCE}/RELEASE_VERSION")" == "${VERSION}" ]] || fail "installed release identity changed"

echo "Verified ${ARCHIVE}: checksum, layout, isolated install, build, and CLI startup passed"
