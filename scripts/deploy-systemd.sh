#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_root=/opt/job-application-system
api_state_root=/var/lib/job-application
worker_state_root=/var/lib/job-application-worker
config_root=/etc/job-application
environment_file="$config_root/env"
profiles_file="$api_state_root/profiles.json"
tokens_file="$api_state_root/tokens.json"
config_file="$config_root/config.json"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "deploy-systemd.sh must run as root" >&2
  exit 1
fi
if [[ ! -f "$environment_file" ]]; then
  echo "Create $environment_file from .env.example and add production secrets first." >&2
  exit 1
fi
if [[ ! -f "$profiles_file" ]]; then
  echo "Create the private $profiles_file from config/profiles.example.json first." >&2
  exit 1
fi
if [[ ! -f "$tokens_file" ]]; then
  echo "Create the private $tokens_file with at least one profile-bound token first." >&2
  exit 1
fi
if [[ ! -f "$config_file" ]]; then
  echo "Create the private $config_file from config/production.example.json first." >&2
  exit 1
fi

systemctl stop job-application-server.service job-application-worker.service 2>/dev/null || true
getent group jobapply >/dev/null || groupadd --system jobapply

if id jobapp-api >/dev/null 2>&1; then
  usermod --gid jobapply --home "$api_state_root" --shell /usr/sbin/nologin jobapp-api
else
  useradd --system --gid jobapply --home-dir "$api_state_root" --no-create-home --shell /usr/sbin/nologin jobapp-api
fi
if id jobapply-worker >/dev/null 2>&1; then
  usermod --gid jobapply --home "$worker_state_root" --shell /usr/sbin/nologin jobapply-worker
else
  useradd --system --gid jobapply --home-dir "$worker_state_root" --no-create-home --shell /usr/sbin/nologin jobapply-worker
fi

install -d -o jobapp-api -g jobapply -m 0750 "$api_state_root" "$api_state_root/vaults"
install -d -o root -g jobapply -m 0750 "$worker_state_root"
install -d -o root -g jobapply -m 2770 "$worker_state_root/documents"
install -d -o jobapply-worker -g jobapply -m 0750 \
  "$worker_state_root/artifacts" "$worker_state_root/receipts" "$worker_state_root/browsers"
install -d -o root -g root -m 0755 "$runtime_root"

rsync --archive --delete --chown=root:root \
  --exclude=.git --exclude=node_modules --exclude=data --exclude=.env \
  --exclude=config/local.json --exclude=config/profiles.json \
  "$repository_root/" "$runtime_root/"
npm ci --omit=dev --prefix "$runtime_root"
chown -R root:root "$runtime_root"

runuser -u jobapply-worker -- env \
  HOME="$worker_state_root" PLAYWRIGHT_BROWSERS_PATH="$worker_state_root/browsers" \
  "$runtime_root/node_modules/.bin/playwright" install chromium

node "$runtime_root/scripts/update-production-env.js" "$environment_file"
chown jobapp-api:jobapply "$profiles_file" "$tokens_file" "$config_file"
chmod 0600 "$profiles_file" "$tokens_file" "$config_file"
runuser -u jobapp-api -- node "$runtime_root/scripts/migrate-profile-settings.js" "$profiles_file"
node "$runtime_root/scripts/init-vault-keys.js" "$profiles_file" "$config_root/vault-keys.json"
node "$runtime_root/scripts/split-production-env.js" "$environment_file" \
  "$config_root/server.env" "$config_root/worker.env"

chmod 0600 "$profiles_file" "$config_root/env" "$config_root/server.env" \
  "$config_root/worker.env" "$config_root/vault-keys.json"
install -o root -g root -m 0644 "$runtime_root/deploy/systemd/job-application-server.service" /etc/systemd/system/
install -o root -g root -m 0644 "$runtime_root/deploy/systemd/job-application-worker.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable job-application-worker.service job-application-server.service
systemctl start job-application-worker.service
systemctl start job-application-server.service

echo "Deployment complete. Install applicant skills separately with scripts/bootstrap-openclaw.js."
