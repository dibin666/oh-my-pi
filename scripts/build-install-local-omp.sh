#!/usr/bin/env bash
set -euo pipefail

INSTALL_PATH="${OMP_INSTALL_PATH:-/home/dibin/.local/bin/omp}"
SUDO_CMD="${SUDO_CMD-sudo}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
BUILD_OUTPUT="$REPO_ROOT/packages/coding-agent/dist/omp"

section() {
	printf '\n=== %s ===\n' "$1"
}

run() {
	printf '+ '
	printf '%q ' "$@"
	printf '\n'
	"$@"
}

run_privileged() {
	if [ -n "$SUDO_CMD" ]; then
		run "$SUDO_CMD" "$@"
	else
		run "$@"
	fi
}

require_command() {
	if ! command -v "$1" >/dev/null 2>&1; then
		echo "Missing required command: $1" >&2
		exit 1
	fi
}

section "Checking prerequisites"
require_command bun
require_command install
if [ -n "$SUDO_CMD" ]; then
	require_command "$SUDO_CMD"
fi

section "Building native addon"
run bun --cwd="$REPO_ROOT/packages/natives" run build

section "Building omp binary"
run bun --cwd="$REPO_ROOT/packages/coding-agent" run build

if [ ! -x "$BUILD_OUTPUT" ]; then
	echo "Build did not produce executable binary: $BUILD_OUTPUT" >&2
	exit 1
fi

section "Built binary"
run "$BUILD_OUTPUT" --version

INSTALL_DIR="$(dirname -- "$INSTALL_PATH")"
if [ -e "$INSTALL_PATH" ]; then
	OWNER_GROUP="$(stat -c '%u:%g' "$INSTALL_PATH")"
else
	OWNER_GROUP="$(id -u):$(id -g)"
fi
OWNER="${OWNER_GROUP%%:*}"
GROUP="${OWNER_GROUP#*:}"

section "Installing to $INSTALL_PATH"
if [ ! -d "$INSTALL_DIR" ]; then
	run_privileged install -d -m 0755 -o "$OWNER" -g "$GROUP" "$INSTALL_DIR"
fi
run_privileged install -m 0755 -o "$OWNER" -g "$GROUP" "$BUILD_OUTPUT" "$INSTALL_PATH"

section "Installed binary"
run "$INSTALL_PATH" --version

echo "Installed omp to $INSTALL_PATH"
