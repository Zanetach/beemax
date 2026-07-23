#!/usr/bin/env bash
# Verify a BeeMax release archive by checksum, source layout, isolated install, and Profile smoke test.
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
RECORDED_NAME="$(awk 'NR == 1 { print $2 }' "${CHECKSUM}")"
[[ "${RECORDED_NAME}" == "$(basename "${ARCHIVE}")" ]] || fail "checksum must contain only the portable archive filename"
if command -v shasum >/dev/null 2>&1; then ACTUAL="$(shasum -a 256 "${ARCHIVE}" | awk '{ print $1 }')"
elif command -v sha256sum >/dev/null 2>&1; then ACTUAL="$(sha256sum "${ARCHIVE}" | awk '{ print $1 }')"
else fail "shasum or sha256sum is required"
fi
[[ -n "${EXPECTED}" && "${EXPECTED}" == "${ACTUAL}" ]] || fail "sha256 checksum mismatch"

STAGING="$(mktemp -d)"
trap 'rm -rf "${STAGING}"' EXIT
tar -xzf "${ARCHIVE}" -C "${STAGING}"
SOURCE="${STAGING}/beemax"
[[ -f "${SOURCE}/package.json" && -f "${SOURCE}/pi/package.json" && -f "${SOURCE}/scripts/bootstrap-install.sh" ]] \
	|| fail "archive source layout or delegated uninstaller is incomplete"
[[ -f "${SOURCE}/.beemax-release-payload" ]] || fail "archive release provenance payload is missing"
[[ "$(tr -d '\r\n' < "${SOURCE}/RELEASE_VERSION")" == "${VERSION}" ]] || fail "RELEASE_VERSION does not match ${VERSION}"
node "${SOURCE}/scripts/verify-release-version.mjs" "${SOURCE}" "${VERSION}" || fail "release version metadata is inconsistent"
node "${ROOT}/scripts/verify-release-agent-boundary.mjs" "${SOURCE}" --whole-tree || fail "release archive external-Agent boundary failed"
PROVIDER_LOCK_ROOT="${SOURCE}/apps/cli/provider-locks/agent-reach-exa"
PROVIDER_LOCK="${PROVIDER_LOCK_ROOT}/package-lock.json"
[[ -f "${PROVIDER_LOCK_ROOT}/package.json" && -f "${PROVIDER_LOCK}" ]] || fail "pinned exa-mcporter Provider lock is missing"
if command -v shasum >/dev/null 2>&1; then PROVIDER_LOCK_SHA="$(shasum -a 256 "${PROVIDER_LOCK}" | awk '{ print $1 }')"
elif command -v sha256sum >/dev/null 2>&1; then PROVIDER_LOCK_SHA="$(sha256sum "${PROVIDER_LOCK}" | awk '{ print $1 }')"
else fail "shasum or sha256sum is required"
fi
grep -Fq "EXA_MCPORTER_LOCK_SHA256 = \"${PROVIDER_LOCK_SHA}\"" "${SOURCE}/apps/cli/src/capability-provider-composition.ts" || fail "Provider lock SHA does not match the runtime trust root"
node --input-type=module -e '
	import { readFileSync } from "node:fs";
	const [manifestPath, lockPath] = process.argv.slice(1);
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const lock = JSON.parse(readFileSync(lockPath, "utf8"));
	if (manifest.dependencies?.mcporter !== "0.9.0" || lock.packages?.["node_modules/mcporter"]?.version !== "0.9.0") process.exit(1);
' "${PROVIDER_LOCK_ROOT}/package.json" "${PROVIDER_LOCK}" || fail "Provider lock does not contain pinned mcporter 0.9.0"
if find "${SOURCE}" \( -name .git -o -name node_modules -o -name dist -o -name '*.tsbuildinfo' \) -print -quit | grep -q .; then
	fail "archive contains Git metadata, node_modules, dist, or TypeScript build state"
fi

mkdir -p "${STAGING}/home" "${STAGING}/bin"
SMOKE_HOME="${STAGING}/home/.beemax"
HOME="${STAGING}/home" BEEMAX_HOME="${SMOKE_HOME}" BEEMAX_BIN_DIR="${STAGING}/bin" BEEMAX_INSTALL_MEDIA_DEPS=0 bash "${SOURCE}/scripts/install.sh"
[[ -f "${SOURCE}/.beemax-release-install" && -f "${SMOKE_HOME}/.beemax-home" ]] \
	|| fail "installed release provenance markers are missing"
run_beemax() {
	env -i HOME="${STAGING}/home" BEEMAX_HOME="${SMOKE_HOME}" PATH="${PATH}" "${STAGING}/bin/beemax" "$@"
}
HELP_OUTPUT="$(run_beemax --help)"
grep -Fq "BeeMax" <<<"${HELP_OUTPUT}" || fail "installed beemax --help did not start correctly"
grep -Fq "quickstart" <<<"${HELP_OUTPUT}" || fail "installed release does not expose the quickstart entry point"
PROFILE_CREATE_OUTPUT="$(run_beemax profile create release-smoke)"
grep -Fq "Created Agent 'release-smoke'" <<<"${PROFILE_CREATE_OUTPUT}" || fail "installed beemax could not create a Profile"
PROFILE_SHOW_OUTPUT="$(run_beemax profile show release-smoke)"
grep -Fq '"profile": "release-smoke"' <<<"${PROFILE_SHOW_OUTPUT}" || fail "installed beemax could not reload the created Profile"
SKILLS_OUTPUT="$(run_beemax skills list --profile release-smoke)"
grep -Fq "business-report" <<<"${SKILLS_OUTPUT}" || fail "installed Profile does not contain packaged Skills"
grep -Fq "historical-market-research" <<<"${SKILLS_OUTPUT}" || fail "installed Profile does not contain the stage-release historical market research Skill"
[[ "$(tr -d '\r\n' < "${SOURCE}/RELEASE_VERSION")" == "${VERSION}" ]] || fail "installed release identity changed"
run_beemax uninstall --yes
[[ ! -e "${STAGING}/bin/beemax" && ! -e "${SOURCE}" ]] || fail "installed release did not remove its command and application"
[[ -f "${SMOKE_HOME}/profiles/release-smoke/config.yaml" ]] || fail "default uninstall did not preserve Profile data"

echo "Verified ${ARCHIVE}: checksum, layout, isolated install, build, Profile reload, packaged Skills, and uninstall passed"
