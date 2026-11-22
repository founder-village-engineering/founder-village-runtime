#!/bin/bash
set -euo pipefail
umask 077
[[ $(id -u) == 0 ]]
[[ $# == 1 && $1 == 'ssh-ed25519 '* ]]
cloud-init status --wait >/dev/null
if ! id fv >/dev/null 2>&1; then
    useradd --create-home --home-dir /home/fv --shell /bin/bash fv
fi
[[ $(getent passwd fv | cut -d: -f6,7) == /home/fv:/bin/bash ]]
[[ ! -L /home/fv && ! -L /home/fv/.ssh && ! -L /home/fv/.ssh/authorized_keys ]]
install -d -o fv -g fv -m 0700 /home/fv/.ssh
keys=/home/fv/.ssh/authorized_keys
if [[ -s $keys ]]; then
    # Never replace a pre-existing operator's key or authorize a new one implicitly.
    [[ $(cut -d ' ' -f1,2 "$keys") == "$1" ]]
else
    install -o fv -g fv -m 0600 /dev/null "$keys"
    printf '%s\n' "$1" > "$keys"
fi
sudoers=$(mktemp)
trap 'rm -f -- "$sudoers"' EXIT
printf '%s\n' 'fv ALL=(ALL) NOPASSWD: ALL' > "$sudoers"
visudo -cf "$sudoers" >/dev/null
install -m 0440 "$sudoers" /etc/sudoers.d/90-fv-operator
