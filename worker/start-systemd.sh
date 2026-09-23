#!/bin/sh
set -eu

if { [ "${WORKER_HEADED_ENABLED:-false}" = true ] || [ "${WORKER_HEADLESS:-true}" = false ]; } \
  && [ -z "${DISPLAY:-}" ]; then
  command -v xvfb-run >/dev/null 2>&1 || { echo "headed Chromium requires Xvfb" >&2; exit 1; }
  exec xvfb-run -a /usr/bin/node worker/server.js
fi
exec /usr/bin/node worker/server.js
