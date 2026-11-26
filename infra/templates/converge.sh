#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ $(id -u) == 0 ]] || { echo 'Run host convergence as root.' >&2; exit 1; }
: "${FV_ROOT:?runtime root required}" "${FV_CONFIG:?manifest required}" "${FV_ARCH:?architecture required}" "${FV_HOST_IMAGE:?OS image required}"
[[ $FV_ROOT =~ ^/[a-zA-Z0-9._/-]+$ && $FV_CONFIG =~ ^/[a-zA-Z0-9._/-]+$ ]]
[[ -x "$FV_ROOT/target/release/fv" ]]
[[ $(dpkg --print-architecture) == "$FV_ARCH" ]]
# shellcheck source=/dev/null
. /etc/os-release
[[ "$ID" == ubuntu && "ubuntu-$VERSION_ID" == "$FV_HOST_IMAGE" ]]
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends ca-certificates curl gnupg ufw wireguard age jq rsync unattended-upgrades openssh-server xz-utils

bash "$FV_ROOT/infra/templates/ssh-firewall.sh"
cat >/etc/ssh/sshd_config.d/00-fv-runtime.conf <<'SSH'
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AllowUsers fv
DisableForwarding yes
SSH
/usr/sbin/sshd -t
effective=$(/usr/sbin/sshd -T)
grep -Fxq 'permitrootlogin no' <<< "$effective"
grep -Fxq 'passwordauthentication no' <<< "$effective"
grep -Fxq 'kbdinteractiveauthentication no' <<< "$effective"
systemctl reload ssh
systemctl enable --now apt-daily.timer apt-daily-upgrade.timer systemd-timesyncd

install -m 0755 -d /etc/apt/keyrings
key=$(mktemp)
trap 'rm -f -- "$key"' EXIT
curl --fail --silent --show-error --proto '=https' https://download.docker.com/linux/ubuntu/gpg -o "$key"
# Require the exact primary key before adding it to a scoped apt keyring.
fingerprint=$(gpg --show-keys --with-colons "$key" | awk -F: '$1=="pub"{primary=1;next} primary&&$1=="fpr"{print $10;primary=0}')
[[ $fingerprint == 9DC858229FC7DD38854AE2D88D81803C0EBFCD88 ]]
install -m 0644 "$key" /etc/apt/keyrings/docker.asc
printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' "$FV_ARCH" "$VERSION_CODENAME" >/etc/apt/sources.list.d/docker.list
chmod 0644 /etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
install -d -m 0700 /etc/docker
install -d -m 0755 /etc/systemd/system/docker.service.d
cat > /etc/systemd/system/docker.service.d/fv-firewall.conf <<SYSTEMD
[Service]
ExecStartPost=$FV_ROOT/infra/templates/firewall.sh
SYSTEMD
cat > /etc/docker/fv-daemon.next <<'JSON'
{"log-driver":"local","log-opts":{"max-size":"10m","max-file":"3"},"live-restore":true,"userland-proxy":false,"no-new-privileges":true}
JSON
systemctl daemon-reload
if ! cmp -s /etc/docker/fv-daemon.next /etc/docker/daemon.json; then
    mv -T /etc/docker/fv-daemon.next /etc/docker/daemon.json
    systemctl restart docker
else
    rm -f /etc/docker/fv-daemon.next
fi
systemctl enable --now docker
bash "$FV_ROOT/infra/templates/firewall.sh"

cd "$FV_ROOT"
# Node, compiled host entrypoints, the native CLI and runtime dependencies were
# checked against the independently signed, platform-specific release.
[[ -x "$FV_ROOT/.fv-current/node" && -d "$FV_ROOT/.fv-current/dist" ]]
cf_launcher=$(jq -er .cloudflare.cf_binary "$FV_CONFIG")
cf_sha=$(jq -er .cloudflare.cf_sha256 "$FV_CONFIG")
for launcher in "$cf_launcher" node_modules/cf/bin/cf; do
    [[ $(sha256sum -- "$launcher" | cut -d' ' -f1) == "$cf_sha" ]]
done
umask 077
chmod 0700 "$FV_ROOT/.state"
for name in fv-runtime.service fv-ingress.service fv-ops.service fv-domain-worker.service fv-backup.service fv-backup.timer fv-restore.service fv-restore.timer fv-audit.service fv-audit.timer fv-monitor.service fv-wireguard.service fv-wireguard.timer; do
    sed -e "s|@ROOT@|$FV_ROOT|g" -e "s|@CONFIG@|$FV_CONFIG|g" "$FV_ROOT/infra/systemd/$name" >"/etc/systemd/system/$name"
    chmod 0644 "/etc/systemd/system/$name"
done
id fv-domain >/dev/null 2>&1 || useradd --system --home-dir /var/lib/fv-domain --create-home --shell /usr/sbin/nologin fv-domain
id fv-monitor >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin fv-monitor
install -d -m 0700 -o fv-domain -g fv-domain /var/lib/fv-domain
environment=$(jq -er .environment "$FV_CONFIG")
if [[ -f "$FV_ROOT/.state/$environment.env" ]]; then
    "$FV_ROOT/.fv-current/node" "$(realpath "$FV_ROOT/dist/scripts/materialize-service-env.js")" "$environment"
fi
systemctl daemon-reload
