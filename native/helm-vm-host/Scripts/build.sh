#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
package_directory="$(cd -- "${script_directory}/.." && pwd)"
configuration="${CONFIGURATION:-release}"

cd "${package_directory}"
swift build --configuration "${configuration}"

binary_path="${package_directory}/.build/${configuration}/helm-vm-host"
if [[ "${SIGN:-0}" == "1" ]]; then
  codesign --force --sign "${CODE_SIGN_IDENTITY:--}" \
    --entitlements "${package_directory}/Entitlements/helm-vm-host.entitlements" \
    --timestamp=none "${binary_path}"
fi

printf 'Built %s\n' "${binary_path}"
if [[ "${SIGN:-0}" == "1" ]]; then
  printf 'Signed with virtualization entitlement\n'
else
  printf 'Not signed; run SIGN=1 %s before starting a VM\n' "${script_directory}/build.sh"
fi
