#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "The AF_VSOCK bridge must be built inside the prepared Linux guest image." >&2
  exit 1
fi

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
output="${script_directory}/vsock-tcp-bridge"

cc -O2 -Wall -Wextra -Wpedantic -std=c11 \
  "${script_directory}/vsock-tcp-bridge.c" \
  -o "${output}"

printf 'Built %s\n' "${output}"
