#!/bin/sh
set -eu

mkdir -p /app/artifacts
chown pwuser:pwuser /app/artifacts
exec gosu pwuser "$@"
