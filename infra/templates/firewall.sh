#!/bin/sh
set -eu
ipv4=$(ip -j route get 1.1.1.1 | jq -er '.[0].dev')
ipv6=$(ip -6 -j route show default | jq -r '.[0].dev // empty')
for interface in "$ipv4" "${ipv6:-$ipv4}"; do
    case "$interface" in *[!a-zA-Z0-9_.-]*|'') exit 1;; esac
done
iptables -w -C DOCKER-USER -i "$ipv4" -m conntrack --ctstate NEW -j DROP 2>/dev/null || iptables -w -I DOCKER-USER 1 -i "$ipv4" -m conntrack --ctstate NEW -j DROP
ip6tables -w -C FORWARD -i "${ipv6:-$ipv4}" -m conntrack --ctstate NEW -j DROP 2>/dev/null || ip6tables -w -I FORWARD 1 -i "${ipv6:-$ipv4}" -m conntrack --ctstate NEW -j DROP
