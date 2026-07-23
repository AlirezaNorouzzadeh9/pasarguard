#!/usr/bin/env bash

check_running_as_root() {
    if [ "$(id -u)" != "0" ]; then
        die "This command must be run as root."
    fi
}

detect_os() {
    if [ -f /etc/lsb-release ] && command -v lsb_release >/dev/null 2>&1; then
        OS=$(lsb_release -si)
    elif [ -f /etc/os-release ]; then
        OS=$(awk -F= '/^NAME/{print $2}' /etc/os-release | tr -d '"')
    elif [ -f /etc/redhat-release ]; then
        OS=$(awk '{print $1}' /etc/redhat-release)
    elif [ -f /etc/arch-release ]; then
        OS="Arch Linux"
    else
        die "Unsupported operating system"
    fi
}

is_redhat_family_os() {
    [[ "${OS:-}" == "CentOS"* ]] ||
        [[ "${OS:-}" == "AlmaLinux"* ]] ||
        [[ "${OS:-}" == "Rocky"* ]] ||
        [[ "${OS:-}" == "Red Hat"* ]] ||
        [[ "${OS:-}" == "Oracle Linux"* ]] ||
        [[ "${OS:-}" == "Amazon Linux"* ]]
}

select_redhat_package_manager() {
    if command -v dnf >/dev/null 2>&1; then
        PKG_MANAGER="dnf"
    elif command -v yum >/dev/null 2>&1; then
        PKG_MANAGER="yum"
    else
        die "Neither yum nor dnf was found. Please install packages manually."
    fi
}

enable_epel_if_available() {
    if $PKG_MANAGER install -y -q epel-release >/dev/null 2>&1; then
        return
    fi

    colorized_echo yellow "Could not enable EPEL automatically; continuing with configured repositories."
}

warn_package_metadata_refresh_failed() {
    colorized_echo yellow "Could not refresh package metadata; continuing with configured repositories."
}

detect_and_update_package_manager() {
    if [ -z "${OS:-}" ]; then
        detect_os
    fi

    colorized_echo blue "Updating package manager"

    if [[ "$OS" == "Ubuntu"* ]] || [[ "$OS" == "Debian"* ]]; then
        PKG_MANAGER="apt-get"
        wait_for_apt_lock
        $PKG_MANAGER update -qq >/dev/null 2>&1 || warn_package_metadata_refresh_failed
    elif is_redhat_family_os; then
        select_redhat_package_manager
        $PKG_MANAGER -y -q makecache >/dev/null 2>&1 || warn_package_metadata_refresh_failed
        enable_epel_if_available
    elif [[ "$OS" == "Fedora"* ]]; then
        PKG_MANAGER="dnf"
        $PKG_MANAGER -q -y makecache >/dev/null 2>&1 || warn_package_metadata_refresh_failed
    elif [[ "$OS" == "Arch Linux" ]] || [[ "$OS" == "Arch"* ]]; then
        PKG_MANAGER="pacman"
        $PKG_MANAGER -Sy --noconfirm --quiet >/dev/null 2>&1 || warn_package_metadata_refresh_failed
    elif [[ "$OS" == "openSUSE"* ]]; then
        PKG_MANAGER="zypper"
        $PKG_MANAGER refresh --quiet >/dev/null 2>&1 || warn_package_metadata_refresh_failed
    else
        die "Unsupported operating system"
    fi
}

# Attempt to install a package, returning non-zero on failure instead of
# aborting. Use this when the caller wants to handle a failed install itself
# (e.g. fall back to an alternative package name); most callers want
# install_package, which aborts on failure.

# On a brand new VPS unattended-upgrades usually holds the apt/dpkg lock for
# several minutes; apt calls below would fail instantly. Wait it out (quietly
# returns at once when the lock is free or the distro is not debian-family).
#
# Only look at who actually HOLDS the dpkg/apt lock files. Do NOT match the
# unattended-upgrades process by name: Ubuntu always runs a permanent
# 'unattended-upgrade-shutdown' monitor that holds no lock, and matching it
# would make this wait forever.
apt_lock_busy() {
    if command -v fuser >/dev/null 2>&1; then
        fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock \
              /var/lib/apt/lists/lock /var/cache/apt/archives/lock >/dev/null 2>&1
        return $?
    fi
    # no fuser on this box - fall back to spotting an active apt/dpkg run
    pgrep -x apt >/dev/null 2>&1 || pgrep -x apt-get >/dev/null 2>&1 || pgrep -x dpkg >/dev/null 2>&1
}

# Best-effort name+pid of whoever holds an apt/dpkg lock, so the wait below
# never looks like a black box.
apt_lock_holder() {
    local pid=""
    command -v fuser >/dev/null 2>&1 || { echo "unknown"; return; }
    pid=$(fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock \
                /var/lib/apt/lists/lock /var/cache/apt/archives/lock 2>/dev/null \
          | tr -s ' \n' ' ' | awk '{print $1}')
    if [ -n "$pid" ]; then
        printf '%s (pid %s)\n' "$(ps -o comm= -p "$pid" 2>/dev/null || echo process)" "$pid"
    else
        echo "unknown"
    fi
}

wait_for_apt_lock() {
    command -v apt-get >/dev/null 2>&1 || return 0
    local waited=0 max="${APT_LOCK_TIMEOUT:-900}"
    while apt_lock_busy; do
        if [ "$waited" -eq 0 ]; then
            colorized_echo yellow "apt/dpkg is busy - held by: $(apt_lock_holder). Waiting for it to finish..."
            colorized_echo yellow "  (usually the initial unattended-upgrades run on a fresh server; to skip the wait: systemctl stop unattended-upgrades)"
        fi
        if [ "$waited" -ge "$max" ]; then
            die "apt is still locked after $((max / 60))m (holder: $(apt_lock_holder)). Wait for it (or: systemctl stop unattended-upgrades) and re-run."
        fi
        sleep 3; waited=$((waited + 3))
        [ $((waited % 30)) -eq 0 ] && colorized_echo yellow "  still waiting... ${waited}s (holder: $(apt_lock_holder))"
    done
    [ "$waited" -gt 0 ] && colorized_echo green "apt lock released (waited ${waited}s)"
    return 0
}

try_install_package() {
    local package="$1"

    if [ -z "${OS:-}" ]; then
        detect_os
    fi

    if [ -z "${PKG_MANAGER:-}" ]; then
        detect_and_update_package_manager
    fi

    colorized_echo blue "Installing $package"
    if [[ "$OS" == "Ubuntu"* ]] || [[ "$OS" == "Debian"* ]]; then
        wait_for_apt_lock
        $PKG_MANAGER -y -qq install "$package" >/dev/null 2>&1
    elif is_redhat_family_os; then
        $PKG_MANAGER install -y -q "$package" >/dev/null 2>&1
    elif [[ "$OS" == "Fedora"* ]]; then
        $PKG_MANAGER install -y -q "$package" >/dev/null 2>&1
    elif [[ "$OS" == "Arch Linux" ]] || [[ "$OS" == "Arch"* ]]; then
        $PKG_MANAGER -S --noconfirm --quiet "$package" >/dev/null 2>&1
    elif [[ "$OS" == "openSUSE"* ]]; then
        $PKG_MANAGER --quiet install -y "$package" >/dev/null 2>&1
    else
        die "Unsupported operating system"
    fi
}

install_package() {
    try_install_package "$1" || die "Failed to install $1 with ${PKG_MANAGER:-the package manager}. Check your package repositories and try again."
}

check_editor() {
    if [ -z "${EDITOR:-}" ]; then
        if command -v nano >/dev/null 2>&1; then
            EDITOR="nano"
        elif command -v vi >/dev/null 2>&1; then
            EDITOR="vi"
        else
            detect_os
            install_package nano
            EDITOR="nano"
        fi
    fi
}

identify_the_operating_system_and_architecture() {
    if [[ "$(uname)" != "Linux" ]]; then
        die "error: This operating system is not supported."
    fi

    case "$(uname -m)" in
    i386 | i686)
        ARCH='32'
        ;;
    amd64 | x86_64)
        ARCH='64'
        ;;
    armv5tel)
        ARCH='arm32-v5'
        ;;
    armv6l)
        ARCH='arm32-v6'
        grep Features /proc/cpuinfo | grep -qw 'vfp' || ARCH='arm32-v5'
        ;;
    armv7 | armv7l)
        ARCH='arm32-v7a'
        grep Features /proc/cpuinfo | grep -qw 'vfp' || ARCH='arm32-v5'
        ;;
    armv8 | aarch64)
        ARCH='arm64-v8a'
        ;;
    mips)
        ARCH='mips32'
        ;;
    mipsle)
        ARCH='mips32le'
        ;;
    mips64)
        ARCH='mips64'
        lscpu | grep -q "Little Endian" && ARCH='mips64le'
        ;;
    mips64le)
        ARCH='mips64le'
        ;;
    ppc64)
        ARCH='ppc64'
        ;;
    ppc64le)
        ARCH='ppc64le'
        ;;
    riscv64)
        ARCH='riscv64'
        ;;
    s390x)
        ARCH='s390x'
        ;;
    *)
        die "error: The architecture is not supported."
        ;;
    esac
}

install_yq() {
    local base_url="https://github.com/mikefarah/yq/releases/latest/download"
    local yq_binary=""
    local yq_url=""
    local binary_tmp=""

    if command -v yq >/dev/null 2>&1; then
        colorized_echo green "yq is already installed."
        return
    fi

    identify_the_operating_system_and_architecture

    case "$ARCH" in
    64 | x86_64)
        yq_binary="yq_linux_amd64"
        ;;
    arm32-v7a | arm32-v6 | arm32-v5 | armv7l)
        yq_binary="yq_linux_arm"
        ;;
    arm64-v8a | aarch64)
        yq_binary="yq_linux_arm64"
        ;;
    32 | i386 | i686)
        yq_binary="yq_linux_386"
        ;;
    *)
        die "Unsupported architecture: $ARCH"
        ;;
    esac

    yq_url="${base_url}/${yq_binary}"
    colorized_echo blue "Downloading yq from ${yq_url}..."

    if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
        colorized_echo yellow "Neither curl nor wget is installed. Attempting to install curl."
        install_package curl || die "Failed to install curl. Please install curl or wget manually."
    fi

    binary_tmp=$(create_temp_file "yq" ".bin")

    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$yq_url" -o "$binary_tmp" || die "Failed to download yq using curl. Please check your internet connection."
    elif command -v wget >/dev/null 2>&1; then
        wget -q -O "$binary_tmp" "$yq_url" || die "Failed to download yq using wget. Please check your internet connection."
    fi

    install -m 755 "$binary_tmp" /usr/local/bin/yq
    colorized_echo green "yq installed successfully!"

    if ! echo "$PATH" | grep -q "/usr/local/bin"; then
        export PATH="/usr/local/bin:$PATH"
    fi

    rm -f "$binary_tmp"
}
