#!/bin/sh
set -eu

mkdir -p /app/data/artifacts /app/data/receipts
chown pwuser:pwuser /app/data/artifacts /app/data/receipts
exec gosu pwuser "$@"
