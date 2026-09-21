#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "VM host builds require macOS and Virtualization.framework." >&2
  exit 1
fi

SIGN="${SIGN:-1}" bash native/helm-vm-host/Scripts/build.sh
