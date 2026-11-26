#!/usr/bin/env bash
# Inside a disposable Linux container, use --network=none, no Docker socket,
# and /input/{fv,example.json,bin-fv,install.sh} mounted read-only.
set -euo pipefail
[[ -f /.dockerenv && ! -e /var/run/docker.sock && ! -e /opt/founder-village ]]
[[ -f /input/fv ]]
findmnt -n -o OPTIONS --target /input/fv | tr ',' '\n' | grep -qx ro
umask 077
mode=fresh
if (( $# )); then mode=$1; fi
mkdir -p /opt/.fixture/trust
cd /opt/.fixture/trust
ssh-keygen -q -t ed25519 -N '' -f operator
awk '{print "founder-village-release namespaces=\"fv-release-v3\"",$1,$2}' operator.pub > signers
root=/opt/founder-village
make_bundle() {
    local name=$1
    mkdir "/opt/.fixture/$name"
    cd "/opt/.fixture/$name"
    cp /input/fv fv
    cp ../trust/signers signers
    mkdir -p source/{bin,config} runtime/dist/packages/database
    cp /input/bin-fv source/bin/fv
    printf '{"fixture":"test@sha256:%064d"}\n' 0 >source/config/images.lock.json
    cp /bin/true runtime/node
    printf '/* synthetic migration */\n' >runtime/dist/packages/database/migrate.js
    printf '{}\n' >sbom.cdx.json
    printf 'synthetic image archive' >image.tar
    tar -C source -cf source.tar bin config
    tar -C runtime -cf runtime.tar node dist
    python3 - "$name" <<'PY'
import json, hashlib, sys, pathlib
revision = sys.argv[1] * 40
config = json.load(open('/input/example.json'))
config['project'] = 'fv-fixture'
config['provider']['architecture'] = 'amd64'
config['provider']['server_type'] = 'cpx22'
config['cloudflare'].update(account_id='1'*32,zone_id='2'*32,cf_sha256='a'*64,access_team='fixture')
config['auth'].update(client_id='fixture',jwks_url='https://identity.example.com/jwks',authorization_endpoint='https://identity.example.com/auth',token_endpoint='https://identity.example.com/token')
config['backup'].update(s3_endpoint='https://storage.example.com',bucket='fixture',immutable_copy_confirmed=True)
pathlib.Path('runtime.json').write_text(json.dumps(config))
sha = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def inventory(root):
    return [dict(path=str(p.relative_to(root)),sha256=sha(p)) for p in sorted(pathlib.Path(root).rglob('*')) if p.is_file()]
images = {k:dict(tag='fv-'+('runtime' if k=='app' else k)+':local-'+revision,id='sha256:'+'b'*64,manifestId='sha256:'+'c'*64) for k in ('app','postgres','rabbitmq','caddy','cloudflared','hasura')}
manifest = dict(version=3,distribution='workstation',revision=revision,checkoutRevision=revision,sourceKind='git-commit',architecture='amd64',buildSourceSha256='a'*64,image=images['app']['tag'],imageId=images['app']['id'],images=images,sourceSha256=sha('source.tar'),binarySha256=sha('fv'),runtimeArchiveSha256=sha('runtime.tar'),imageArchiveSha256=sha('image.tar'),sbomSha256=sha('sbom.cdx.json'),files=inventory('source'),runtimeFiles=inventory('runtime'))
pathlib.Path('source-manifest.json').write_text(json.dumps(manifest))
PY
    ssh-keygen -Y sign -f ../trust/operator -n fv-release-v3 source-manifest.json >/dev/null 2>&1
}
install_one() {
    local revision
    revision=$(printf '%s' "$1" | awk '{for(i=0;i<40;i++)printf "%s",$1}')
    bash /input/install.sh staging fv-fixture amd64 "$revision"
}
make_bundle a
first=$(printf 'a%.0s' {1..40})
second=$(printf 'b%.0s' {1..40})
if [[ $mode == legacy ]]; then
    mkdir -p "$root/config" "$root/bin" "$root/.state" "$root/secrets"
    touch "$root/bin/original"
    cp runtime.json "$root/config/staging.private.json"
    printf 'fv-fixture' >/etc/fv-runtime-owner
fi
install_one a
test "$(readlink "$root/.fv-current")" = ".fv-releases/$first"
test "$(stat -c %a /etc/fv/release.allowed_signers)" = 600
test "$(stat -c %a "$root/.state/private-config/staging.private.json")" = 600
"$root/bin/fv" --config config/staging.private.json validate >/dev/null
"$root/bin/fv" bundle-check "$root/.fv-current" amd64
if [[ $mode == legacy ]]; then test -f "$root/.fv-legacy/bin/original"; fi
mkdir -p "$root/.state/staging"
printf promoted >"$root/.state/staging/current-release"
printf retained >"$root/secrets/fixture"
cd /opt/.fixture
make_bundle b
install_one b
test "$(readlink "$root/.fv-current")" = ".fv-releases/$first"
"$root/bin/fv" bundle-check "$root/.fv-releases/$second" amd64
test "$(cat "$root/secrets/fixture")" = retained
# A bad bootstrap executable is rejected before any of its code can run.
cp fv genuine
printf '#!/bin/sh\ntouch /opt/unsigned-executed\n' >fv
chmod 755 fv
if install_one b; then exit 1; fi
test ! -e /opt/unsigned-executed
mv genuine fv
cp source-manifest.json.sig genuine.sig
printf invalid > source-manifest.json.sig
if install_one b; then exit 1; fi
mv genuine.sig source-manifest.json.sig
install_one b
test "$(readlink "$root/.fv-current")" = ".fv-releases/$first"
printf 'Isolated Linux %s install, signed retry, staging and tamper refusal passed.\n' "$mode"
