#!/bin/sh
set -eu

mkdir -p /app/data
chown node:node /app/data
for runtime_file in /app/data/state.json /app/data/tokens.json /app/data/profiles.json; do
  if [ -e "$runtime_file" ]; then
    chown node:node "$runtime_file"
  fi
done

exec su-exec node "$@"
