#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${FV_CONFIG:?manifest required}"
# Apply only the bootstrap rules owned by this runtime, after the operator
# has authenticated in a separate session. The WireGuard rules are independent.
install -d -m 0700 /etc/fv
jq -er '.ssh_cidrs | join("\n")' "$FV_CONFIG" > /etc/fv/ssh-cidrs.next
ufw default deny incoming
ufw default deny routed
ufw default allow outgoing
while IFS= read -r cidr; do
    [[ -z $cidr ]] || ufw allow from "$cidr" to any port 22 proto tcp comment fv-bootstrap-ssh
done < /etc/fv/ssh-cidrs.next
if [[ -f /etc/fv/ssh-cidrs ]]; then
    while IFS= read -r cidr; do
        if [[ -n $cidr ]] && ! grep -Fxq -- "$cidr" /etc/fv/ssh-cidrs.next; then
            ufw --force delete allow from "$cidr" to any port 22 proto tcp
        fi
    done < /etc/fv/ssh-cidrs
fi
mv -T /etc/fv/ssh-cidrs.next /etc/fv/ssh-cidrs
wireguard_port=$(jq -er .wireguard_port "$FV_CONFIG")
if [[ -n ${FV_TUNNEL_SSH_INTERFACE:-} ]]; then
    ufw allow in on "$FV_TUNNEL_SSH_INTERFACE" to "${FV_TUNNEL_SSH_GATEWAY:?tunnel SSH gateway required}" port 22 proto tcp comment fv-tunnel-ssh
    existing_rules=$(ufw show added)
    if grep -Eq "^ufw allow $wireguard_port/udp( |$)" <<< "$existing_rules"; then
        ufw --force delete allow "$wireguard_port/udp"
    fi
else
    ufw allow "$wireguard_port/udp" comment fv-wireguard
fi
ufw --force enable
