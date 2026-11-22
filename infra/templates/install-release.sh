#!/bin/bash
set -euo pipefail
umask 077
[[ $(id -u) == 0 ]]
[[ $# == 2 && ($1 == staging || $1 == production) && $2 =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]]
root=/opt/founder-village
config="config/$1.private.json"
[[ ! -L $root ]]
[[ $(df -Pk /opt | awk 'NR==2 {print $4}') -ge 8388608 ]]
# The fixed root can only be used on a clean host or a previously bound runtime.
if [[ -e $root ]]; then
    [[ $(stat -c '%u:%g' "$root") == 0:0 ]]
    [[ -f /etc/fv-runtime-owner && $(cat /etc/fv-runtime-owner) == "$2" ]] ||
        cmp -s source-manifest.json "$root/.state/source-manifest.json"
    [[ -f "$root/$config" ]]
fi
mkdir tree
tar --no-same-owner -xf source.tar -C tree
install -D -m 0755 fv tree/target/release/fv
install -m 0600 runtime.json "tree/$config"
tree/target/release/fv --root tree --config "$config" validate >/dev/null
mkdir -m 0700 tree/.state
install -m 0600 source-manifest.json tree/.state/source-manifest.json
chmod 0755 tree
if [[ ! -e $root ]]; then
    mkdir -m 0700 tree/secrets
    mv -T tree "$root"
else
    # Run under the same environment lock as deploy, backup, and runtime up.
    exec 9>"$root/.state/$1.lock"
    flock -n 9
    [[ ! -L "$root/.state" && ! -L "$root/secrets" && ! -L "$root/target" ]]
    if ! cmp -s source-manifest.json "$root/.state/source-manifest.json"; then
        rsync -rltp --delay-updates --delete-delay \
            --exclude '/.state/' --exclude '/secrets/' --exclude '/node_modules/' \
            --exclude '/target/' --exclude '/config/*.private.json' tree/ "$root/"
    fi
    install -m 0755 tree/target/release/fv "$root/target/release/fv.next"
    mv -T "$root/target/release/fv.next" "$root/target/release/fv"
    install -m 0600 runtime.json "$root/$config.next"
    mv -T "$root/$config.next" "$root/$config"
    install -m 0600 source-manifest.json "$root/.state/source-manifest.json.next"
    mv -T "$root/.state/source-manifest.json.next" "$root/.state/source-manifest.json"
fi
