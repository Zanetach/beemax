#!/usr/bin/env bash
# Install the local document-serving, OCR, and Linux CJK dependencies.
set -euo pipefail

MEDIA_DEPS_ENABLED="${THRUVERA_INSTALL_MEDIA_DEPS:-${BEEMAX_INSTALL_MEDIA_DEPS:-1}}"
TESSERACT_BIN="${THRUVERA_TESSERACT:-${BEEMAX_TESSERACT:-tesseract}}"
FC_LIST_BIN="${THRUVERA_FC_LIST:-${BEEMAX_FC_LIST:-fc-list}}"
CADDY_BIN="${THRUVERA_CADDY:-${BEEMAX_CADDY:-caddy}}"

case "${MEDIA_DEPS_ENABLED}" in
	0|false|FALSE|no|NO|off|OFF)
		echo "Thruvera media dependencies: automatic installation disabled."
		exit 0
		;;
esac

detect_platform() {
	if [[ -n "${THRUVERA_INSTALL_OS:-${BEEMAX_INSTALL_OS:-}}" ]]; then
		printf '%s\n' "${THRUVERA_INSTALL_OS:-${BEEMAX_INSTALL_OS}}"
		return
	fi

	case "$(uname -s)" in
		Darwin) printf '%s\n' "macos" ;;
		Linux)
			if [[ -r /etc/os-release ]]; then
				# shellcheck disable=SC1091
				. /etc/os-release
				case " ${ID:-} ${ID_LIKE:-} " in
					*ubuntu*|*debian*) printf '%s\n' "ubuntu" ;;
					*) printf '%s\n' "linux" ;;
				esac
			else
				printf '%s\n' "linux"
			fi
			;;
		*) printf '%s\n' "unsupported" ;;
	esac
}

tesseract_ready() {
	command -v "${TESSERACT_BIN}" >/dev/null 2>&1
}

caddy_ready() {
	command -v "${CADDY_BIN}" >/dev/null 2>&1
}

ubuntu_cjk_font_ready() {
	command -v "${FC_LIST_BIN}" >/dev/null 2>&1 || return 1
	local families
	families="$("${FC_LIST_BIN}" :lang=zh-cn family 2>/dev/null || true)"
	[[ -n "${families//[[:space:]]/}" ]]
}

print_ready() {
	echo "Thruvera document dependencies ready: $("${CADDY_BIN}" version 2>&1 | head -n 1); $("${TESSERACT_BIN}" --version 2>&1 | head -n 1)"
}

install_ubuntu() {
	local apt_get="${THRUVERA_APT_GET:-${BEEMAX_APT_GET:-apt-get}}"
	local effective_uid="${THRUVERA_INSTALL_EUID:-${BEEMAX_INSTALL_EUID:-$(id -u)}}"
	local -a packages=(caddy tesseract-ocr tesseract-ocr-eng tesseract-ocr-chi-sim fonts-noto-cjk)

	command -v "${apt_get}" >/dev/null 2>&1 || {
		echo "Thruvera could not install OCR and CJK report dependencies: apt-get is unavailable." >&2
		exit 1
	}

	echo "Thruvera is installing Caddy, local OCR, and CJK report fonts with apt-get..."
	if [[ "${effective_uid}" == "0" ]]; then
		env DEBIAN_FRONTEND=noninteractive "${apt_get}" update
		env DEBIAN_FRONTEND=noninteractive "${apt_get}" install -y --no-install-recommends "${packages[@]}"
	else
		command -v sudo >/dev/null 2>&1 || {
			echo "Thruvera needs sudo to install OCR and CJK report dependencies. Re-run the installer with sudo access, or preinstall them." >&2
			exit 1
		}
		sudo env DEBIAN_FRONTEND=noninteractive "${apt_get}" update
		sudo env DEBIAN_FRONTEND=noninteractive "${apt_get}" install -y --no-install-recommends "${packages[@]}"
	fi
}

install_macos() {
	local brew="${THRUVERA_BREW:-${BEEMAX_BREW:-brew}}"
	command -v "${brew}" >/dev/null 2>&1 || {
		echo "Thruvera could not install Tesseract: Homebrew is unavailable. Install Homebrew or set THRUVERA_INSTALL_MEDIA_DEPS=0." >&2
		exit 1
	}

	echo "Thruvera is installing Caddy, local OCR, and language data with Homebrew..."
	"${brew}" install caddy tesseract tesseract-lang
}

PLATFORM="$(detect_platform)"
case "${PLATFORM}" in
	ubuntu|debian)
		if caddy_ready && tesseract_ready && ubuntu_cjk_font_ready; then
			print_ready
			exit 0
		fi
		install_ubuntu
		;;
	macos)
		if caddy_ready && tesseract_ready; then
			print_ready
			exit 0
		fi
		install_macos
		;;
	*)
		if caddy_ready && tesseract_ready; then
			print_ready
			exit 0
		fi
		echo "Thruvera cannot automatically install Caddy and Tesseract on this operating system. Preinstall them or set THRUVERA_INSTALL_MEDIA_DEPS=0." >&2
		exit 1
		;;
esac

if ! tesseract_ready; then
	echo "Thruvera installed the OCR packages, but tesseract is not available on PATH." >&2
	exit 1
fi

if ! caddy_ready; then
	echo "Thruvera installed the document packages, but caddy is not available on PATH." >&2
	exit 1
fi

if [[ "${PLATFORM}" == "ubuntu" || "${PLATFORM}" == "debian" ]] && ! ubuntu_cjk_font_ready; then
	echo "Thruvera installed the media packages, but no Simplified Chinese font is visible through fontconfig." >&2
	exit 1
fi

echo "Thruvera document dependencies installed: $("${CADDY_BIN}" version 2>&1 | head -n 1); $("${TESSERACT_BIN}" --version 2>&1 | head -n 1)"
