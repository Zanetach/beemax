#!/usr/bin/env bash
# BeeMax single-package installer for Linux and macOS.
set -euo pipefail

VERSION="${BEEMAX_VERSION:-latest}"
RELEASE_BASE="${BEEMAX_RELEASE_BASE:-https://github.com/Zanetach/beemax/releases/download}"
RELEASE_API="${BEEMAX_RELEASE_API:-https://api.github.com/repos/Zanetach/beemax/releases?per_page=1}"
INSTALL_DIR="${BEEMAX_INSTALL_DIR:-${HOME}/.beemax/app}"
BIN_DIR="${BEEMAX_BIN_DIR:-${HOME}/.local/bin}"
DATA_HOME="${BEEMAX_HOME:-${HOME}/.beemax}"
QUICKSTART=0
UNINSTALL=0
PURGE=0
CONFIRMED=0
SERVICE_SCOPE="user"
PROFILE="${BEEMAX_PROFILE:-personal}"

usage() {
	cat <<'EOF'
BeeMax installer

Usage:
  curl -fsSL https://raw.githubusercontent.com/Zanetach/beemax/main/scripts/bootstrap-install.sh | bash
  curl -fsSL https://raw.githubusercontent.com/Zanetach/beemax/main/scripts/bootstrap-install.sh | bash -s -- --quickstart

Options:
  --version <tag>  Install a specific release tag
  --dir <path>     Install application files at this absolute path
  --quickstart     Configure or verify a Profile, then open BeeMax chat
  --profile <name> Profile used by --quickstart (default: personal)
  --uninstall      Remove application files and command, keeping Profiles and data
  --purge          With --uninstall, permanently remove all BeeMax Profile data
  --yes            Confirm permanent data removal requested by --purge
  --system         Also remove a root-installed Linux system service
  --help           Show this help

Environment:
  BEEMAX_VERSION, BEEMAX_RELEASE_BASE, BEEMAX_RELEASE_API, BEEMAX_INSTALL_DIR, BEEMAX_BIN_DIR, BEEMAX_HOME, BEEMAX_PROFILE
EOF
}

fail() {
	echo "BeeMax install failed: $*" >&2
	exit 1
}

validate_release_install() {
	local marker="${INSTALL_DIR}/.beemax-release-install"
	[[ -f "${marker}" ]] || fail "refusing to uninstall a directory without BeeMax release provenance: ${INSTALL_DIR}"
	grep -Fxq "BeeMax verified release install" "${marker}" \
		|| fail "invalid BeeMax release provenance marker: ${marker}"
	grep -Fxq "install-root=${INSTALL_DIR}" "${marker}" \
		|| fail "BeeMax release provenance does not match the requested install directory"
}

validate_data_home_separation() {
	[[ -e "${DATA_HOME}" || -L "${DATA_HOME}" ]] || return
	local resolved_install resolved_data
	resolved_install="$(cd -P "${INSTALL_DIR}" && pwd)"
	resolved_data="$(cd -P "${DATA_HOME}" && pwd)"
	case "${resolved_data}" in
		"${resolved_install}"|"${resolved_install}"/*)
			fail "refusing to uninstall because BEEMAX_HOME is inside the application directory: ${DATA_HOME}"
			;;
	esac
}

remove_services() {
	local platform="${BEEMAX_UNINSTALL_PLATFORM:-$(uname -s)}"
	if [[ "${platform}" == "Darwin" ]]; then
		[[ "${SERVICE_SCOPE}" == "user" ]] || fail "macOS system-wide Gateway services are not supported"
		local launch_agents="${BEEMAX_LAUNCH_AGENTS_DIR:-${HOME}/Library/LaunchAgents}"
		local launchctl="${BEEMAX_LAUNCHCTL:-launchctl}"
		local plist label
		command -v "${launchctl}" >/dev/null 2>&1 || fail "launchctl is required to remove a matching BeeMax LaunchAgent"
		for plist in "${launch_agents}"/com.beemax.agent.*.plist; do
			[[ -f "${plist}" ]] || continue
			grep -Fq "${INSTALL_DIR}/apps/cli/dist/cli.js" "${plist}" || continue
			label="$(basename "${plist}" .plist)"
			if "${launchctl}" print "gui/$(id -u)/${label}" >/dev/null 2>&1; then
				"${launchctl}" bootout "gui/$(id -u)/${label}" >/dev/null 2>&1 \
					|| fail "could not stop LaunchAgent ${label}; application files were not removed"
			fi
			rm -f "${plist}"
		done
		return
	fi
	if [[ "${platform}" == "Linux" ]]; then
		local systemctl="${BEEMAX_SYSTEMCTL:-systemctl}"
		local systemd_dir
		local -a scope_args=()
		if [[ "${SERVICE_SCOPE}" == "system" ]]; then
			[[ "$(id -u)" == "0" ]] || fail "Linux system service uninstall requires root"
			systemd_dir="${BEEMAX_SYSTEMD_SYSTEM_DIR:-/etc/systemd/system}"
		else
			systemd_dir="${BEEMAX_SYSTEMD_USER_DIR:-${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user}"
			scope_args=(--user)
		fi
		local unit="${systemd_dir}/beemax@.service"
		if [[ ! -f "${unit}" ]] || ! grep -Fq "${INSTALL_DIR}/apps/cli/dist/cli.js" "${unit}"; then return; fi
		command -v "${systemctl}" >/dev/null 2>&1 || fail "systemctl is required to remove a matching BeeMax systemd service"
		local active_units enabled_units service_unit known duplicate
		local -a service_units=("")
		active_units="$("${systemctl}" "${scope_args[@]}" list-units --all --plain --no-legend --no-pager 'beemax@*.service' 2>/dev/null)" \
			|| fail "could not inspect active BeeMax systemd services; application files were not removed"
		enabled_units="$("${systemctl}" "${scope_args[@]}" list-unit-files 'beemax@*.service' --no-legend --no-pager 2>/dev/null)" \
			|| fail "could not inspect enabled BeeMax systemd services; application files were not removed"
		while read -r service_unit _; do
			[[ "${service_unit}" =~ ^beemax@[a-z0-9][a-z0-9_-]{0,31}\.service$ ]] || continue
			duplicate=0
			for known in "${service_units[@]}"; do
				[[ -n "${known}" ]] || continue
				if [[ "${known}" == "${service_unit}" ]]; then duplicate=1; break; fi
			done
			if [[ "${duplicate}" == "0" ]]; then service_units+=("${service_unit}"); fi
		done <<<"${active_units}"$'\n'"${enabled_units}"
		for service_unit in "${service_units[@]}"; do
			[[ -n "${service_unit}" ]] || continue
			"${systemctl}" "${scope_args[@]}" disable --now "${service_unit}" >/dev/null 2>&1 \
				|| fail "could not stop systemd service ${service_unit}; application files were not removed"
		done
		rm -f "${unit}"
		if [[ -f "${systemd_dir}/beemax.target" ]] && grep -Fq "BeeMax Agent profiles" "${systemd_dir}/beemax.target"; then
			rm -f "${systemd_dir}/beemax.target"
		fi
		"${systemctl}" "${scope_args[@]}" daemon-reload >/dev/null 2>&1 \
			|| fail "systemd daemon-reload failed after removing BeeMax unit files"
	fi
}

validate_purge_data_home() {
	[[ -n "${DATA_HOME}" && "${DATA_HOME}" == /* ]] || fail "refusing to purge a non-absolute BEEMAX_HOME"
	[[ -e "${DATA_HOME}" || -L "${DATA_HOME}" ]] || return
	[[ ! -L "${DATA_HOME}" ]] || fail "refusing to purge a symlinked BEEMAX_HOME: ${DATA_HOME}"
	local resolved_home resolved_data marker
	resolved_home="$(cd -P "${HOME}" && pwd)"
	resolved_data="$(cd -P "${DATA_HOME}" && pwd)"
	[[ "${resolved_data}" != "/" && "${resolved_data}" != "${resolved_home}" ]] || fail "refusing to purge an unsafe BEEMAX_HOME: ${DATA_HOME}"
	marker="${DATA_HOME}/.beemax-home"
	[[ -f "${marker}" ]] || fail "refusing to purge a BEEMAX_HOME without release provenance: ${DATA_HOME}"
	grep -Fxq "BeeMax Profile Home" "${marker}" || fail "invalid BeeMax Profile Home marker: ${marker}"
	grep -Fxq "install-root=${INSTALL_DIR}" "${marker}" \
		|| fail "BeeMax Profile Home marker does not match the requested install directory"
}

run_uninstall() {
	if [[ "${PURGE}" == "1" && "${CONFIRMED}" != "1" ]]; then
		fail "--purge permanently removes all Profiles and requires --yes"
	fi
	validate_release_install
	validate_data_home_separation
	if [[ "${PURGE}" == "1" ]]; then validate_purge_data_home; fi
	remove_services
	if [[ -f "${BIN_DIR}/beemax" ]]; then
		local quoted_install
		printf -v quoted_install '%q' "${INSTALL_DIR}"
		if grep -Fxq "export BEEMAX_ROOT=${quoted_install}" "${BIN_DIR}/beemax"; then
			rm -f "${BIN_DIR}/beemax"
		fi
	fi
	if [[ -f "${INSTALL_DIR}/package.json" ]] && grep -Fq '"name": "beemax-agent"' "${INSTALL_DIR}/package.json"; then
		rm -rf "${INSTALL_DIR}"
	fi
	if [[ "${PURGE}" == "1" ]]; then
		rm -rf "${DATA_HOME}"
		echo "BeeMax application files, services, Profiles, and data were removed."
	else
		echo "BeeMax application files and matching services removed. Profiles and data under ${DATA_HOME}/profiles were kept."
	fi
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--version) VERSION="${2:?--version requires a value}"; shift 2 ;;
		--dir) INSTALL_DIR="${2:?--dir requires a value}"; shift 2 ;;
		--quickstart) QUICKSTART=1; shift ;;
		--profile) PROFILE="${2:?--profile requires a value}"; shift 2 ;;
		--uninstall) UNINSTALL=1; shift ;;
		--purge) PURGE=1; shift ;;
		--yes) CONFIRMED=1; shift ;;
		--system) SERVICE_SCOPE="system"; shift ;;
		--help|-h) usage; exit 0 ;;
		*) fail "unknown option: $1" ;;
	esac
done

[[ "${INSTALL_DIR}" == /* ]] || fail "install directory must be absolute: ${INSTALL_DIR}"
[[ "${BIN_DIR}" == /* ]] || fail "command directory must be absolute: ${BIN_DIR}"
[[ "${DATA_HOME}" == /* ]] || fail "BEEMAX_HOME must be absolute: ${DATA_HOME}"
for path in "${INSTALL_DIR}" "${BIN_DIR}" "${DATA_HOME}"; do
	case "${path}" in
		*/../*|*/..|*/./*|*/.) fail "paths containing . or .. segments are not supported: ${path}" ;;
	esac
done
if [[ "${PURGE}" == "1" && "${UNINSTALL}" != "1" ]]; then fail "--purge is valid only with --uninstall"; fi
if [[ "${SERVICE_SCOPE}" == "system" && "${UNINSTALL}" != "1" ]]; then fail "--system is valid only with --uninstall"; fi
if [[ "${UNINSTALL}" == "1" ]]; then run_uninstall; exit 0; fi

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
[[ -f "${INSTALL_DIR}/.beemax-release-install" && -f "${DATA_HOME}/.beemax-home" ]] \
	|| fail "application setup did not preserve verified release provenance"
echo "BeeMax ${VERSION} installed from one verified release archive."
if [[ "${QUICKSTART}" == "1" ]]; then
	[[ -r /dev/tty ]] || fail "--quickstart requires an interactive terminal; rerun beemax quickstart --profile ${PROFILE}"
	"${BIN_DIR}/beemax" quickstart --profile "${PROFILE}" < /dev/tty
else
	echo "Next: beemax quickstart --profile ${PROFILE}"
fi
