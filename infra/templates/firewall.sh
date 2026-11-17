#!/bin/sh
set -eu
FV_INTERFACE=$(ip -j route get 1.1.1.1 | jq -er '.[0].dev')
case "$FV_INTERFACE" in *[!a-zA-Z0-9_.-]*|'') exit 1;; esac
iptables -C DOCKER-USER -i "$FV_INTERFACE" -m conntrack --ctstate NEW -j DROP 2>/dev/null || iptables -I DOCKER-USER 1 -i "$FV_INTERFACE" -m conntrack --ctstate NEW -j DROP
ip6tables -C FORWARD -i "$FV_INTERFACE" -m conntrack --ctstate NEW -j DROP 2>/dev/null || ip6tables -I FORWARD 1 -i "$FV_INTERFACE" -m conntrack --ctstate NEW -j DROP
