#!/usr/bin/env bash
# Create a self-contained BeeMax source archive, including the Pi submodule.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:?Usage: scripts/create-release-archive.sh <version> [output-directory]}"
OUTPUT_DIR="${2:-${ROOT}/dist/release}"
ARCHIVE_NAME="beemax-${VERSION}.tar.gz"

[[ -f "${ROOT}/pi/package.json" ]] || {
	echo "Pi submodule is missing; run git submodule update --init --recursive first" >&2
	exit 1
}

STAGING="$(mktemp -d)"
trap 'rm -rf "${STAGING}"' EXIT
mkdir -p "${OUTPUT_DIR}" "${STAGING}/beemax"

tar -C "${ROOT}" \
	--exclude='./.git' \
	--exclude='./pi/.git' \
	--exclude='./node_modules' \
	--exclude='./pi/node_modules' \
	--exclude='./**/dist' \
	--exclude='./**/*.tsbuildinfo' \
	--exclude='./docs' \
	--exclude='./data' \
	--exclude='./.cursor' \
	--exclude='./.claude' \
	--exclude='./.pi' \
	--exclude='./.DS_Store' \
	--exclude='./.beemax' \
	-cf - . | tar -C "${STAGING}/beemax" -xf -

tar -C "${STAGING}" -czf "${OUTPUT_DIR}/${ARCHIVE_NAME}" beemax
shasum -a 256 "${OUTPUT_DIR}/${ARCHIVE_NAME}" > "${OUTPUT_DIR}/${ARCHIVE_NAME}.sha256"
echo "Created ${OUTPUT_DIR}/${ARCHIVE_NAME}"
