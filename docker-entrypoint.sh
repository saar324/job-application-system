#!/bin/sh
set -eu

mkdir -p /app/data /app/data/documents /app/data/vaults
chown node:node /app/data /app/data/documents /app/data/vaults
for runtime_file in /app/data/state.json /app/data/tokens.json /app/data/profiles.json /app/data/vault-keys.json; do
  if [ -e "$runtime_file" ]; then
    chown node:node "$runtime_file"
  fi
done

exec su-exec node "$@"
