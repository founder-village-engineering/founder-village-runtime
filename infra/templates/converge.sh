#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run host convergence as root.' >&2; exit 1; }
: "${FV_ROOT:?runtime root required}" "${FV_CONFIG:?manifest required}"
[[ -x "$FV_ROOT/target/release/fv" ]] || { echo 'Install the verified runtime binary first.' >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends ca-certificates curl gnupg ufw wireguard age jq ripgrep unattended-upgrades
install -m 0755 -d /etc/apt/keyrings
curl --fail --silent --show-error --proto '=https' https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
# Trust the Docker signing identity, not merely a successful HTTPS download.
gpg --show-keys --with-colons /etc/apt/keyrings/docker.asc | awk -F: '$1=="fpr" {print $10}' | rg -q '^9DC858229FC7DD38854AE2D88D81803C0EBFCD88$'
# shellcheck source=/dev/null
. /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_CODENAME" == noble ]] || { echo 'This host adapter supports Ubuntu 24.04 only.' >&2; exit 1; }
printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' "$(dpkg --print-architecture)" "$VERSION_CODENAME" >/etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
install -d -m 0700 /etc/docker
cat >/etc/docker/daemon.json <<'JSON'
{"log-driver":"local","log-opts":{"max-size":"10m","max-file":"3"},"live-restore":true,"userland-proxy":false,"no-new-privileges":true}
JSON
systemctl enable --now docker
# Containers expose only loopback binds. Explicitly reject internet forwarded ingress,
# including Docker's forwarding chain, without changing established traffic.
bash "$FV_ROOT/infra/templates/firewall.sh"
cd "$FV_ROOT"
npm ci
npm run build
chmod 0700 "$FV_ROOT/.state"
for name in fv-runtime.service fv-ops.service fv-domain-worker.service fv-backup.service fv-backup.timer fv-restore.service fv-restore.timer fv-audit.service fv-audit.timer fv-monitor.service fv-wireguard.service fv-wireguard.timer; do
 sed -e "s|@ROOT@|$FV_ROOT|g" -e "s|@CONFIG@|$FV_CONFIG|g" "$FV_ROOT/infra/systemd/$name" >"/etc/systemd/system/$name"
done
id fv-domain >/dev/null 2>&1 || useradd --system --home-dir /var/lib/fv-domain --create-home --shell /usr/sbin/nologin fv-domain
id fv-monitor >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin fv-monitor
install -d -m 0700 -o fv-domain -g fv-domain /var/lib/fv-domain
if [ -f "$FV_ROOT/.state/$(jq -r .environment "$FV_ROOT/$FV_CONFIG").env" ]; then
 node --import tsx "$FV_ROOT/scripts/materialize-service-env.ts" "$(jq -r .environment "$FV_ROOT/$FV_CONFIG")"
fi
systemctl daemon-reload
systemctl enable fv-runtime.service fv-ops.service fv-backup.timer fv-restore.timer fv-audit.timer
# Starting a workload is a separate runtime lifecycle action after configuration checks.
