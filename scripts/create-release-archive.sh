#!/usr/bin/env bash
# Create a self-contained BeeMax source archive, including vendored Pi source.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:?Usage: scripts/create-release-archive.sh <version> [output-directory]}"
OUTPUT_DIR="${2:-${ROOT}/dist/release}"
ARCHIVE_NAME="beemax-${VERSION}.tar.gz"

node "${ROOT}/scripts/verify-release-version.mjs" "${ROOT}" "${VERSION}"

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
	--exclude='./.github' \
	--exclude='*/.github' \
	--exclude='./.scratch' \
	--exclude='./tmp' \
	--exclude='./evals' \
	--exclude='./scripts' \
	--exclude='./tickets.md' \
	--exclude='node_modules' \
	--exclude='*/node_modules' \
	--exclude='*/test' \
	--exclude='*/test/*' \
	--exclude='*/docs' \
	--exclude='*/docs/*' \
	--exclude='*/examples' \
	--exclude='*/examples/*' \
	--exclude='dist' \
	--exclude='*/dist' \
	--exclude='*.tsbuildinfo' \
	--exclude='./docs' \
	--exclude='./pi/scripts' \
	--exclude='./pi/packages/*/README.md' \
	--exclude='./pi/packages/*/CHANGELOG.md' \
	--exclude='./pi/packages/ai/scripts' \
	--exclude='./pi/packages/ai/src/api/openai-codex-responses.ts' \
	--exclude='./pi/packages/ai/src/api/openai-codex-responses.lazy.ts' \
	--exclude='./pi/packages/ai/src/providers/openai-codex.ts' \
	--exclude='./pi/packages/ai/src/utils/oauth/openai-codex.ts' \
	--exclude='./output' \
	--exclude='./dist' \
	--exclude='./data' \
	--exclude='./.cursor' \
	--exclude='./.claude' \
	--exclude='./.pi' \
	--exclude='./.DS_Store' \
	--exclude='./.beemax' \
	-cf - . | tar -C "${STAGING}/beemax" -xf -

# Chromium or native crashes can leave root-level core dumps in a checkout.
# Remove only those staging-root files; packages/core is production source.
rm -f "${STAGING}/beemax/core" "${STAGING}/beemax"/core.*

mkdir -p "${STAGING}/beemax/scripts"
for RELEASE_SCRIPT in clean-build-output.mjs install-media-dependencies.sh install.sh verify-release-version.mjs; do
	cp "${ROOT}/scripts/${RELEASE_SCRIPT}" "${STAGING}/beemax/scripts/${RELEASE_SCRIPT}"
done
node --input-type=module -e '
	import { readFileSync, writeFileSync } from "node:fs";
	const path = process.argv[1];
	const config = JSON.parse(readFileSync(path, "utf8"));
	config.exclude = (config.exclude ?? []).filter((entry) => !/codex/iu.test(entry));
	writeFileSync(path, `${JSON.stringify(config, null, "\t")}\n`);
' "${STAGING}/beemax/pi/packages/ai/tsconfig.build.json"

# Release archives omit Git metadata, so retain the exact release identity for runtime status checks.
printf '%s\n' "${VERSION}" > "${STAGING}/beemax/RELEASE_VERSION"

tar -C "${STAGING}" -czf "${OUTPUT_DIR}/${ARCHIVE_NAME}" beemax
if command -v sha256sum >/dev/null 2>&1; then
	(cd "${OUTPUT_DIR}" && sha256sum "${ARCHIVE_NAME}" > "${ARCHIVE_NAME}.sha256")
elif command -v shasum >/dev/null 2>&1; then
	(cd "${OUTPUT_DIR}" && shasum -a 256 "${ARCHIVE_NAME}" > "${ARCHIVE_NAME}.sha256")
else
	echo "sha256sum or shasum is required to create the release checksum" >&2
	exit 1
fi
echo "Created ${OUTPUT_DIR}/${ARCHIVE_NAME}"
