#!/bin/sh
set -eu

mkdir -p /app/data/artifacts /app/data/receipts
chown pwuser:pwuser /app/data/artifacts /app/data/receipts
if { [ "${WORKER_HEADED_ENABLED:-false}" = true ] || [ "${WORKER_HEADLESS:-true}" = false ]; } \
  && [ -z "${DISPLAY:-}" ]; then
  command -v xvfb-run >/dev/null 2>&1 || { echo "headed Chromium requires Xvfb" >&2; exit 1; }
  exec gosu pwuser xvfb-run -a "$@"
fi
exec gosu pwuser "$@"
