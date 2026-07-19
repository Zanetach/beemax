#!/usr/bin/env bash
# Install local OCR and the Linux CJK font coverage used by report rendering.
set -euo pipefail

MEDIA_DEPS_ENABLED="${BEEMAX_INSTALL_MEDIA_DEPS:-1}"
TESSERACT_BIN="${BEEMAX_TESSERACT:-tesseract}"
FC_LIST_BIN="${BEEMAX_FC_LIST:-fc-list}"

case "${MEDIA_DEPS_ENABLED}" in
	0|false|FALSE|no|NO|off|OFF)
		echo "BeeMax media dependencies: automatic installation disabled."
		exit 0
		;;
esac

detect_platform() {
	if [[ -n "${BEEMAX_INSTALL_OS:-}" ]]; then
		printf '%s\n' "${BEEMAX_INSTALL_OS}"
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

ubuntu_cjk_font_ready() {
	command -v "${FC_LIST_BIN}" >/dev/null 2>&1 || return 1
	local families
	families="$("${FC_LIST_BIN}" :lang=zh-cn family 2>/dev/null || true)"
	[[ -n "${families//[[:space:]]/}" ]]
}

print_ready() {
	echo "BeeMax media dependencies ready: $("${TESSERACT_BIN}" --version 2>&1 | head -n 1)"
}

install_ubuntu() {
	local apt_get="${BEEMAX_APT_GET:-apt-get}"
	local effective_uid="${BEEMAX_INSTALL_EUID:-$(id -u)}"
	local -a packages=(tesseract-ocr tesseract-ocr-eng tesseract-ocr-chi-sim fonts-noto-cjk)

	command -v "${apt_get}" >/dev/null 2>&1 || {
		echo "BeeMax could not install OCR and CJK report dependencies: apt-get is unavailable." >&2
		exit 1
	}

	echo "BeeMax is installing local OCR and CJK report fonts with apt-get..."
	if [[ "${effective_uid}" == "0" ]]; then
		env DEBIAN_FRONTEND=noninteractive "${apt_get}" update
		env DEBIAN_FRONTEND=noninteractive "${apt_get}" install -y --no-install-recommends "${packages[@]}"
	else
		command -v sudo >/dev/null 2>&1 || {
			echo "BeeMax needs sudo to install OCR and CJK report dependencies. Re-run the installer with sudo access, or preinstall them." >&2
			exit 1
		}
		sudo env DEBIAN_FRONTEND=noninteractive "${apt_get}" update
		sudo env DEBIAN_FRONTEND=noninteractive "${apt_get}" install -y --no-install-recommends "${packages[@]}"
	fi
}

install_macos() {
	local brew="${BEEMAX_BREW:-brew}"
	command -v "${brew}" >/dev/null 2>&1 || {
		echo "BeeMax could not install Tesseract: Homebrew is unavailable. Install Homebrew or set BEEMAX_INSTALL_MEDIA_DEPS=0." >&2
		exit 1
	}

	echo "BeeMax is installing local OCR and language data with Homebrew..."
	"${brew}" install tesseract tesseract-lang
}

PLATFORM="$(detect_platform)"
case "${PLATFORM}" in
	ubuntu|debian)
		if tesseract_ready && ubuntu_cjk_font_ready; then
			print_ready
			exit 0
		fi
		install_ubuntu
		;;
	macos)
		if tesseract_ready; then
			print_ready
			exit 0
		fi
		install_macos
		;;
	*)
		if tesseract_ready; then
			print_ready
			exit 0
		fi
		echo "BeeMax cannot automatically install Tesseract on this operating system. Preinstall it or set BEEMAX_INSTALL_MEDIA_DEPS=0." >&2
		exit 1
		;;
esac

if ! tesseract_ready; then
	echo "BeeMax installed the OCR packages, but tesseract is not available on PATH." >&2
	exit 1
fi

if [[ "${PLATFORM}" == "ubuntu" || "${PLATFORM}" == "debian" ]] && ! ubuntu_cjk_font_ready; then
	echo "BeeMax installed the media packages, but no Simplified Chinese font is visible through fontconfig." >&2
	exit 1
fi

echo "BeeMax media dependency installed: $("${TESSERACT_BIN}" --version 2>&1 | head -n 1)"
