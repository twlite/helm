#!/usr/bin/env bash

set -u
set -o pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

with_vm="${HELM_START_VM:-0}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --with-vm) with_vm=1 ;;
    --without-vm) with_vm=0 ;;
    -h|--help)
      printf 'Usage: %s [--with-vm]\n' "$0"
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done

BUN_BIN="${BUN_BIN:-bun}"
if ! command -v "$BUN_BIN" >/dev/null 2>&1; then
  printf '%s\n' 'Helm requires Bun. Install Bun from https://bun.sh/ and try again.' >&2
  exit 127
fi

if [ ! -f "$ROOT_DIR/package.json" ]; then
  printf '%s\n' 'This does not appear to be the Helm repository.' >&2
  exit 1
fi

server_host="${HELM_HOST:-127.0.0.1}"
server_port="${HELM_PORT:-8787}"
export HELM_SERVER_URL="${HELM_SERVER_URL:-http://${server_host}:${server_port}}"

pids=()
groups=()
labels=()

start_child() {
  local label="$1"
  shift
  if command -v setsid >/dev/null 2>&1; then
    setsid "$@" &
    groups+=(1)
  else
    "$@" &
    groups+=(0)
  fi
  pids+=("$!")
  labels+=("$label")
  printf '[helm] started %s (pid %s)\n' "$label" "$!"
}

stop_child() {
  local index="$1"
  local pid="${pids[$index]}"
  if [ "${groups[$index]}" = 1 ]; then
    kill -TERM "-${pid}" 2>/dev/null || true
  else
    kill -TERM "$pid" 2>/dev/null || true
  fi
}

cleanup() {
  local status="${1:-0}"
  local index
  local pid
  local attempts

  trap - EXIT INT TERM HUP
  for index in "${!pids[@]}"; do
    stop_child "$index"
  done
  for index in "${!pids[@]}"; do
    pid="${pids[$index]}"
    attempts=0
    while kill -0 "$pid" 2>/dev/null && [ "$attempts" -lt 50 ]; do
      sleep 0.1
      attempts=$((attempts + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
      if [ "${groups[$index]}" = 1 ]; then
        kill -KILL "-${pid}" 2>/dev/null || true
      else
        kill -KILL "$pid" 2>/dev/null || true
      fi
    fi
    wait "$pid" 2>/dev/null || true
  done
  exit "$status"
}

trap 'cleanup "$?"' EXIT
trap 'cleanup 130' INT
trap 'cleanup 143' TERM
trap 'cleanup 129' HUP

start_child server "$BUN_BIN" run --cwd apps/server dev
start_child frontend "$BUN_BIN" run --cwd apps/web dev

if [ "$with_vm" = 1 ]; then
  printf '%s\n' '[helm] waiting for the backend before starting the VM'
  ready=0
  attempt=0
  while [ "$attempt" -lt 120 ]; do
    if HELM_PROBE_URL="${HELM_SERVER_URL%/}/api/health" "$BUN_BIN" -e \
      'fetch(process.env.HELM_PROBE_URL).then(response => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))' \
      >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 0.25
    attempt=$((attempt + 1))
  done
  if [ "$ready" -ne 1 ]; then
    printf '%s\n' '[helm] backend did not become healthy' >&2
    cleanup 1
  fi
  if ! "$BUN_BIN" run vm:start; then
    printf '%s\n' '[helm] VM startup failed' >&2
    cleanup 1
  fi
fi

while :; do
  for index in "${!pids[@]}"; do
    if ! kill -0 "${pids[$index]}" 2>/dev/null; then
      wait "${pids[$index]}"
      status=$?
      [ "$status" -eq 0 ] && status=1
      printf '[helm] %s exited with status %s\n' "${labels[$index]}" "$status" >&2
      cleanup "$status"
    fi
  done
  sleep 0.25
done
