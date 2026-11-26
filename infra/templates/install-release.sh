#!/bin/bash
# Called over the operator's pinned SSH session after hashing the complete upload.
set -euo pipefail
umask 077
[[ $(id -u) == 0 && $# == 4 ]]
[[ $1 == staging || $1 == production ]]
[[ $2 =~ ^[a-z0-9][a-z0-9-]{0,62}$ && ($3 == amd64 || $3 == arm64) && $4 =~ ^[0-9a-f]{40}$ ]]
env_name=$1 project=$2 arch=$3 revision=$4
root=/opt/founder-village
owner=/etc/fv-runtime-owner
signers=/etc/fv/release.allowed_signers
generation=$root/.fv-releases/$revision
[[ ! -L $root && ! -L /etc/fv && ! -L $owner && ! -L $signers ]]
exec 8>/opt/.fv-release.install.lock
flock -n 8
if [[ -e $owner ]]; then
    [[ $(stat -c %u "$owner") == 0 && $(cat "$owner") == "$project" ]]
else
    [[ ! -e $root ]]
    if command -v docker >/dev/null; then
        containers=$(docker ps -aq) && volumes=$(docker volume ls -q) || exit 1
        [[ -z $containers && -z $volumes ]]
    else
        [[ ! -e /var/lib/docker ]]
    fi
fi
if [[ -e $root ]]; then
    [[ -d $root && $(stat -c %u:%g "$root") == 0:0 ]]
fi
# The trust anchor arrives independently over pinned SSH. A package cannot
# introduce or rotate it. All future uploads must match the existing root pin.
ssh-keygen -Y verify -f signers -I founder-village-release -n fv-release-v3 \
    -s source-manifest.json.sig <source-manifest.json >/dev/null
if [[ -e $signers ]]; then
    [[ -f $signers && $(stat -c %u "$signers") == 0 ]]
    cmp -s signers "$signers"
else
    install -d -m 0700 /etc/fv
    install -m 0600 signers "$signers.next"
    ln "$signers.next" "$signers"
    rm "$signers.next"
fi
ssh-keygen -Y verify -f "$signers" -I founder-village-release -n fv-release-v3 \
    -s source-manifest.json.sig <source-manifest.json >/dev/null
# Authenticate the bootstrap verifier itself before its first execution. Ubuntu
# cloud-init supplies Python's JSON parser even before jq/Docker are installed.
binary_digest=$(/usr/bin/python3 -I -c '
import json, re, sys
with open("source-manifest.json", "rb") as f:
    m = json.load(f)
if not (m.get("version") == 3 and m.get("distribution") == "workstation" and
        m.get("architecture") == sys.argv[1] and m.get("revision") == sys.argv[2] and
        re.fullmatch(r"[0-9a-f]{64}", m.get("binarySha256", ""))):
    sys.exit(1)
print(m["binarySha256"])
' "$arch" "$revision")
printf '%s  fv\n' "$binary_digest" | sha256sum --check --status
if [[ ! -e $owner ]]; then
    printf '%s' "$project" > "$owner.next"
    ln "$owner.next" "$owner"
    rm "$owner.next"
fi
install -d -m 0755 "$root"
for name in .state .fv-releases secrets .fv-legacy; do [[ ! -L $root/$name ]]; done
install -d -m 0700 "$root/.state" "$root/secrets" "$root/.fv-legacy" "$root/.state/private-config"
install -d -m 0755 "$root/.fv-releases"
exec 9>"$root/.state/$env_name.lock"
flock -n 9
[[ ! -L $generation ]]
chmod 0755 fv
if [[ -d $generation ]]; then
    # The revision is an immutable name, including on interrupted/retried uploads.
    cmp -s source-manifest.json "$generation/.bundle/source-manifest.json"
    ./fv bundle-check "$generation" "$arch"
else
    mkdir tree
    ./fv bundle-extract "$PWD" "$PWD/tree" "$arch"
    chmod 0755 tree/target/release/fv tree/node
    find tree -type d -exec chmod 0755 {} +
    find tree -type f -exec chmod a+r,go-w,a-s {} +
    find tree -type f -perm /111 -exec chmod a+x {} +
    chmod 0700 tree/.bundle
    chmod 0600 tree/.bundle/*
    tree/target/release/fv --root tree --config "$PWD/runtime.json" validate >/dev/null
    mv -T tree "$generation"
fi
# Active v3 installations stage the candidate under its immutable revision. The
# authorized promotion updates the current symlink and private config together.
staged=0
if [[ -L $root/.fv-current && -f $root/.state/$env_name/current-release ]]; then
    staged=1
fi
# Config/secrets, volumes, audit and backup state keep the same stable paths.
# Preserve the complete legacy checkout when adopting a previously owned host.
if [[ -d $root/config && ! -L $root/config ]]; then
    for cfg in "$root"/config/*.private.json; do
        [[ -e $cfg ]] || continue
        [[ -f $cfg && ! -L $cfg ]]
        if [[ ! -e $root/.state/private-config/${cfg##*/} ]]; then
            install -m 0600 "$cfg" "$root/.state/private-config/${cfg##*/}"
        fi
    done
fi
install -m 0600 runtime.json "$generation/.bundle/$env_name.config.next"
mv -T "$generation/.bundle/$env_name.config.next" "$generation/.bundle/$env_name.config"
if (( staged )); then
    pending=$root/.state/$env_name/pending-config
    [[ ! -L $pending ]]
    install -d -m 0700 "$pending"
    install -m 0600 runtime.json "$pending/$revision.next"
    mv -T "$pending/$revision.next" "$pending/$revision.json"
else
    install -m 0600 runtime.json "$root/.state/private-config/$env_name.private.json.next"
    mv -T "$root/.state/private-config/$env_name.private.json.next" "$root/.state/private-config/$env_name.private.json"
fi
for cfg in "$root"/.state/private-config/*.private.json; do
    name=${cfg##*/}
    target="../../../.state/private-config/$name"
    if [[ -L $generation/config/$name ]]; then
        [[ $(readlink "$generation/config/$name") == "$target" ]]
    else
        [[ ! -e $generation/config/$name ]]
        ln -s "$target" "$generation/config/$name"
    fi
done
# Initial adoption selects a complete generation before publishing stable
# entrypoints. Already serving v3 machines retain their original selection.
if [[ ! -L $root/.fv-current ]]; then
    [[ ! -e $root/.fv-current ]]
    ln -s ".fv-releases/$revision" "$root/.fv-current"
fi
for entry in "$generation"/*; do
    name=${entry##*/}
    dest=$root/$name
    expected=.fv-current/$name
    if [[ -L $dest ]]; then
        [[ $(readlink "$dest") == "$expected" ]]
    elif [[ -e $dest ]]; then
        # Linux atomically exchanges the legacy directory with its new link.
        # No process can observe a missing path if migration is interrupted.
        legacy=$root/.fv-legacy/$name
        if [[ -L $legacy ]]; then
            [[ $(readlink "$legacy") == "$expected" ]]
        else
            [[ ! -e $legacy ]]
            ln -s "$expected" "$legacy"
        fi
        /usr/bin/python3 -I -c '
import ctypes, os, sys
swap = ctypes.CDLL(None, use_errno=True).renameat2
if swap(-100, os.fsencode(sys.argv[1]), -100, os.fsencode(sys.argv[2]), 2):
    raise OSError(ctypes.get_errno(), "could not exchange legacy runtime paths")
' "$dest" "$legacy"
    else
        ln -s "$expected" "$dest"
    fi
done
if (( staged )); then exit 0; fi
[[ ! -e $root/.fv-current || -L $root/.fv-current ]]
ln -s ".fv-releases/$revision" "$PWD/next-generation"
mv -Tf "$PWD/next-generation" "$root/.fv-current"
