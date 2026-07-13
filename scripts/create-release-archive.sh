#!/usr/bin/env bash
# Create a self-contained BeeMax source archive, including vendored Pi source.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:?Usage: scripts/create-release-archive.sh <version> [output-directory]}"
OUTPUT_DIR="${2:-${ROOT}/dist/release}"
ARCHIVE_NAME="beemax-${VERSION}.tar.gz"

package_version() {
	node -e 'const fs=require("fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).version)' "$1"
}

ROOT_PACKAGE_VERSION="$(package_version "${ROOT}/package.json")"
[[ "${VERSION}" == "v${ROOT_PACKAGE_VERSION}" ]] || {
	echo "Release tag ${VERSION} does not match package version v${ROOT_PACKAGE_VERSION}" >&2
	exit 1
}
for manifest in "${ROOT}/apps/cli/package.json" "${ROOT}"/packages/*/package.json; do
	[[ "$(package_version "${manifest}")" == "${ROOT_PACKAGE_VERSION}" ]] || {
		echo "BeeMax workspace version does not match ${ROOT_PACKAGE_VERSION}: ${manifest}" >&2
		exit 1
	}
done

[[ -f "${ROOT}/pi/package.json" ]] || {
	echo "Vendored Pi source is missing from this BeeMax checkout" >&2
	exit 1
}

STAGING="$(mktemp -d)"
trap 'rm -rf "${STAGING}"' EXIT
mkdir -p "${OUTPUT_DIR}" "${STAGING}/beemax"

tar -C "${ROOT}" \
	--exclude='./.git' \
	--exclude='./pi/.git' \
	--exclude='node_modules' \
	--exclude='*/node_modules' \
	--exclude='dist' \
	--exclude='*/dist' \
	--exclude='*.tsbuildinfo' \
	--exclude='./docs' \
	--exclude='./output' \
	--exclude='./dist' \
	--exclude='./data' \
	--exclude='./.cursor' \
	--exclude='./.claude' \
	--exclude='./.pi' \
	--exclude='./.DS_Store' \
	--exclude='./.beemax' \
	-cf - . | tar -C "${STAGING}/beemax" -xf -

# Release archives omit Git metadata, so retain the exact release identity for runtime status checks.
printf '%s\n' "${VERSION}" > "${STAGING}/beemax/RELEASE_VERSION"

tar -C "${STAGING}" -czf "${OUTPUT_DIR}/${ARCHIVE_NAME}" beemax
if command -v sha256sum >/dev/null 2>&1; then
	sha256sum "${OUTPUT_DIR}/${ARCHIVE_NAME}" > "${OUTPUT_DIR}/${ARCHIVE_NAME}.sha256"
elif command -v shasum >/dev/null 2>&1; then
	shasum -a 256 "${OUTPUT_DIR}/${ARCHIVE_NAME}" > "${OUTPUT_DIR}/${ARCHIVE_NAME}.sha256"
else
	echo "sha256sum or shasum is required to create the release checksum" >&2
	exit 1
fi
echo "Created ${OUTPUT_DIR}/${ARCHIVE_NAME}"
