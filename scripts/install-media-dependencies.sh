#!/usr/bin/env bash
# Install the local OCR runtime used by BeeMax when no vision model is available.
set -euo pipefail

MEDIA_DEPS_ENABLED="${BEEMAX_INSTALL_MEDIA_DEPS:-1}"

case "${MEDIA_DEPS_ENABLED}" in
	0|false|FALSE|no|NO|off|OFF)
		echo "BeeMax media dependencies: automatic installation disabled."
		exit 0
		;;
esac

if command -v tesseract >/dev/null 2>&1; then
	echo "BeeMax media dependency ready: $(tesseract --version 2>&1 | head -n 1)"
	exit 0
fi

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

install_ubuntu() {
	local apt_get="${BEEMAX_APT_GET:-apt-get}"
	local effective_uid="${BEEMAX_INSTALL_EUID:-$(id -u)}"
	local -a packages=(tesseract-ocr tesseract-ocr-eng tesseract-ocr-chi-sim)

	command -v "${apt_get}" >/dev/null 2>&1 || {
		echo "BeeMax could not install Tesseract: apt-get is unavailable." >&2
		exit 1
	}

	echo "BeeMax is installing local OCR (English and Simplified Chinese) with apt-get..."
	if [[ "${effective_uid}" == "0" ]]; then
		env DEBIAN_FRONTEND=noninteractive "${apt_get}" update
		env DEBIAN_FRONTEND=noninteractive "${apt_get}" install -y --no-install-recommends "${packages[@]}"
	else
		command -v sudo >/dev/null 2>&1 || {
			echo "BeeMax needs sudo to install Tesseract. Re-run the installer with sudo access, or preinstall Tesseract." >&2
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

case "$(detect_platform)" in
	ubuntu|debian) install_ubuntu ;;
	macos) install_macos ;;
	*)
		echo "BeeMax cannot automatically install Tesseract on this operating system. Preinstall it or set BEEMAX_INSTALL_MEDIA_DEPS=0." >&2
		exit 1
		;;
esac

if ! command -v tesseract >/dev/null 2>&1; then
	echo "BeeMax installed the OCR packages, but tesseract is not available on PATH." >&2
	exit 1
fi

echo "BeeMax media dependency installed: $(tesseract --version 2>&1 | head -n 1)"
