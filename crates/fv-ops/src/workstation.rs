//! Workstation release trust is anchored outside every uploaded generation.
use anyhow::{Context, Result, ensure};
use fv_config::Architecture;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::{BufReader, Read, Write},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
};

pub const SIGNERS: &str = "/etc/fv/release.allowed_signers";
const KINDS: [&str; 6] = [
    "app",
    "postgres",
    "rabbitmq",
    "hasura",
    "caddy",
    "cloudflared",
];
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Manifest {
    version: u8,
    distribution: String,
    pub revision: String,
    checkout_revision: String,
    source_kind: String,
    build_source_sha256: String,
    pub architecture: String,
    pub image: String,
    image_id: String,
    source_sha256: String,
    binary_sha256: String,
    image_archive_sha256: String,
    sbom_sha256: String,
    runtime_archive_sha256: String,
    files: Vec<Member>,
    runtime_files: Vec<Member>,
    pub images: BTreeMap<String, Image>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Member {
    path: String,
    sha256: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Image {
    #[serde(rename = "manifestId")]
    pub manifest_id: String,
    pub tag: String,
    pub id: String,
}

pub fn hex(s: &str, len: usize) -> bool {
    s.len() == len
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn regular(path: &Path) -> Result<File> {
    ensure!(
        path.symlink_metadata()?.file_type().is_file(),
        "expected a regular release file"
    );
    Ok(File::open(path)?)
}
fn sha(path: &Path) -> Result<String> {
    let mut hash = Sha256::new();
    std::io::copy(&mut BufReader::new(regular(path)?), &mut hash)?;
    Ok(format!("{:x}", hash.finalize()))
}
fn child(parent: &Path, cmd: &mut Command) -> Result<String> {
    let out = cmd.current_dir(parent).output()?;
    ensure!(
        out.status.success(),
        "release verification command failed: {:?}",
        cmd.get_program()
    );
    Ok(String::from_utf8(out.stdout)?)
}
fn verify_elf(path: &Path, arch: Architecture) -> Result<()> {
    let mut header = [0u8; 64];
    regular(path)?.read_exact(&mut header)?;
    let machine = if arch == Architecture::Arm64 { 183 } else { 62 };
    ensure!(
        &header[..6] == b"\x7fELF\x02\x01"
            && u16::from_le_bytes([header[18], header[19]]) == machine,
        "native release executable has wrong format or architecture"
    );
    Ok(())
}
fn tar_command() -> Command {
    let mut command = Command::new("/usr/bin/tar");
    command
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LC_ALL", "C.UTF-8");
    command
}
fn safe_path(name: &str) -> bool {
    !name.is_empty()
        && !name.chars().any(|c| c.is_control() || c == '\\')
        && name
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != "..")
        && Path::new(name)
            .components()
            .all(|p| matches!(p, Component::Normal(_)))
}
fn validate_inventory(files: &[Member], runtime: bool) -> Result<()> {
    let mut seen = BTreeSet::new();
    ensure!(!files.is_empty(), "empty signed inventory");
    for file in files {
        let top = file.path.split('/').next().unwrap_or("");
        ensure!(
            safe_path(&file.path) && hex(&file.sha256, 64) && seen.insert(&file.path),
            "invalid signed file inventory"
        );
        if runtime {
            ensure!(
                file.path == "node" || matches!(top, "dist" | "node_modules"),
                "unexpected host runtime path"
            );
        } else {
            ensure!(
                (matches!(
                    top,
                    "bin" | "config" | "database" | "hasura" | "infra" | "policies"
                ) || matches!(file.path.as_str(), "package.json" | "package-lock.json"))
                    && !file.path.ends_with(".private.json"),
                "protected host path in source"
            );
        }
    }
    Ok(())
}
impl Manifest {
    pub fn read(bundle: &Path, signers: &Path, arch: Architecture) -> Result<Self> {
        let raw = bundle.join("source-manifest.json");
        let sig = bundle.join("source-manifest.json.sig");
        let signer_meta = signers.symlink_metadata()?;
        ensure!(
            signer_meta.is_file(),
            "external release signer pin required"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            ensure!(
                signer_meta.mode() & 0o022 == 0,
                "release signer pin must be protected"
            );
            if signers == Path::new(SIGNERS) {
                ensure!(
                    signer_meta.uid() == 0,
                    "host release signer pin must be root-owned"
                );
            }
        }
        let pin = fs::read_to_string(signers)?;
        let fields: Vec<_> = pin.trim_end_matches('\n').split(' ').collect();
        ensure!(
            fields.len() == 4
                && fields[0] == "founder-village-release"
                && fields[1] == "namespaces=\"fv-release-v3\""
                && fields[2] == "ssh-ed25519"
                && !fields[3].is_empty()
                && fields[3]
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b)),
            "pin exactly one Founder release Ed25519 key"
        );
        regular(&sig)?;
        let mut bytes = Vec::new();
        regular(&raw)?
            .take((32 << 20) + 1)
            .read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() <= 32 << 20,
            "release inventory exceeds its size bound"
        );
        let mut verify = Command::new("/usr/bin/ssh-keygen")
            .args(["-Y", "verify", "-f"])
            .arg(signers)
            .args(["-I", "founder-village-release", "-n", "fv-release-v3", "-s"])
            .arg(&sig)
            .current_dir(bundle)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        let sent = verify
            .stdin
            .take()
            .context("signature verifier input required")?
            .write_all(&bytes);
        ensure!(
            verify.wait()?.success() && sent.is_ok(),
            "workstation release signature rejected"
        );
        let m: Self = serde_json::from_slice(&bytes)?;
        ensure!(
            m.version == 3
                && m.distribution == "workstation"
                && m.architecture == arch.oci()
                && hex(&m.revision, 40)
                && hex(&m.checkout_revision, 40)
                && hex(&m.build_source_sha256, 64)
                && (m.source_kind != "worktree" || m.build_source_sha256.starts_with(&m.revision))
                && matches!(m.source_kind.as_str(), "git-commit" | "worktree")
                && (m.source_kind != "git-commit" || m.checkout_revision == m.revision),
            "wrong signed release platform, revision or format"
        );
        for checksum in [
            &m.source_sha256,
            &m.binary_sha256,
            &m.image_archive_sha256,
            &m.sbom_sha256,
            &m.runtime_archive_sha256,
        ] {
            ensure!(hex(checksum, 64), "invalid artifact digest");
        }
        ensure!(
            KINDS.iter().all(|kind| m.images.contains_key(*kind))
                && m.images
                    .keys()
                    .all(|kind| KINDS.contains(&kind.as_str()) || kind == "vaultwarden"),
            "invalid signed image set"
        );
        for (kind, entry) in &m.images {
            let component = if kind == "app" {
                "runtime"
            } else {
                kind.as_str()
            };
            ensure!(
                entry.tag == format!("fv-{component}:local-{}", m.revision)
                    && [&entry.id, &entry.manifest_id]
                        .iter()
                        .all(|id| id.strip_prefix("sha256:").is_some_and(|h| hex(h, 64))),
                "invalid signed image binding"
            );
        }
        ensure!(
            m.image == m.images["app"].tag && m.image_id == m.images["app"].id,
            "conflicting application image"
        );
        validate_inventory(&m.files, false)?;
        validate_inventory(&m.runtime_files, true)?;
        ensure!(
            m.runtime_files.iter().any(|e| e.path == "node")
                && m.runtime_files
                    .iter()
                    .any(|e| e.path == "dist/packages/database/migrate.js"),
            "missing compiled host runtime"
        );
        Ok(m)
    }
    pub fn installed(root: &Path, arch: Architecture) -> Result<Self> {
        Self::read(&root.join(".fv-current/.bundle"), Path::new(SIGNERS), arch)
    }
    pub fn retained(root: &Path, rev: &str, arch: Architecture) -> Result<Self> {
        ensure!(hex(rev, 40), "invalid retained release revision");
        let m = Self::read(
            &root.join(".fv-releases").join(rev).join(".bundle"),
            Path::new(SIGNERS),
            arch,
        )?;
        ensure!(m.revision == rev, "retained release revision mismatch");
        Ok(m)
    }
    fn verify_tree(files: &[Member], root: &Path) -> Result<()> {
        for file in files {
            ensure!(
                sha(&root.join(&file.path))? == file.sha256,
                "installed release file drift"
            );
        }
        Ok(())
    }
    fn verify_installed_inventory(&self, generation: &Path) -> Result<()> {
        fn visit(base: &Path, dir: &Path, expected: &mut BTreeSet<String>) -> Result<()> {
            for entry in fs::read_dir(dir)? {
                let entry = entry?;
                let path = entry.path();
                let relative = path
                    .strip_prefix(base)?
                    .to_str()
                    .context("invalid installed file name")?;
                let ty = entry.file_type()?;
                if relative == ".bundle" {
                    ensure!(ty.is_dir(), "invalid bundle directory");
                    continue;
                }
                if ty.is_dir() {
                    visit(base, &path, expected)?;
                    continue;
                }
                if ty.is_symlink()
                    && let Some(name) = relative.strip_prefix("config/")
                    && !name.chars().any(|c| c.is_control() || c == '\\')
                    && ["staging.private.json", "production.private.json"].contains(&name)
                {
                    ensure!(
                        fs::read_link(&path)?
                            == Path::new("../../../.state/private-config").join(name),
                        "unexpected private config link"
                    );
                    continue;
                }
                ensure!(
                    ty.is_file() && expected.remove(relative),
                    "unexpected installed release member"
                );
            }
            Ok(())
        }
        let mut expected: BTreeSet<_> = self
            .files
            .iter()
            .chain(&self.runtime_files)
            .map(|e| e.path.clone())
            .collect();
        expected.insert("target/release/fv".into());
        visit(generation, generation, &mut expected)?;
        ensure!(expected.is_empty(), "missing installed release member");
        Ok(())
    }
    pub fn verify_archive(&self, generation: &Path) -> Result<()> {
        ensure!(
            sha(&generation.join(".bundle/image.tar"))? == self.image_archive_sha256,
            "retained offline archive drift"
        );
        Ok(())
    }
    pub fn verify_source(&self, generation: &Path) -> Result<()> {
        self.verify_installed_inventory(generation)?;
        ensure!(
            sha(&generation.join("target/release/fv"))? == self.binary_sha256,
            "installed native CLI drift"
        );
        ensure!(
            sha(&generation.join(".bundle/sbom.cdx.json"))? == self.sbom_sha256,
            "installed release SBOM drift"
        );
        Self::verify_tree(&self.files, generation)?;
        Self::verify_tree(&self.runtime_files, generation)
    }
    fn check_image(&self, root: &Path, kind: &str, docker: &Path) -> Result<()> {
        let entry = &self.images[kind];
        let fields = if kind == "app" {
            "{{.Id}} {{.Os}}/{{.Architecture}} {{index .Config.Labels \"org.opencontainers.image.revision\"}}"
        } else {
            "{{.Id}} {{.Os}}/{{.Architecture}}"
        };
        let platform = format!("linux/{}", self.architecture);
        let actual = child(
            root,
            docker_command(docker).args([
                "image",
                "inspect",
                "--platform",
                &platform,
                "--format",
                fields,
                &entry.tag,
            ]),
        )?;
        let fields: Vec<_> = actual.split_whitespace().collect();
        ensure!(
            fields.len() == if kind == "app" { 3 } else { 2 }
                && (fields[0] == entry.id || fields[0] == entry.manifest_id)
                && fields[1] == platform
                && (kind != "app" || fields[2] == self.revision),
            "local Docker image identity or platform mismatch"
        );
        Ok(())
    }
    pub fn verify_images(&self, root: &Path) -> Result<()> {
        self.verify_with(root, Path::new("/usr/bin/docker"))
    }
    fn verify_with(&self, root: &Path, docker: &Path) -> Result<()> {
        for kind in self.images.keys() {
            self.check_image(root, kind, docker)?;
        }
        Ok(())
    }
    pub fn load_images(&self, root: &Path) -> Result<()> {
        self.load_with(root, Path::new("/usr/bin/docker"))
    }
    fn load_with(&self, root: &Path, docker: &Path) -> Result<()> {
        if self.verify_with(root, docker).is_ok() {
            return Ok(());
        }
        let archive = root
            .join(".fv-releases")
            .join(&self.revision)
            .join(".bundle/image.tar");
        ensure!(
            sha(&archive)? == self.image_archive_sha256,
            "offline image archive digest mismatch"
        );
        let index = child(
            root,
            tar_command().arg("-xOf").arg(&archive).arg("manifest.json"),
        )?;
        #[derive(Deserialize)]
        #[serde(rename_all = "PascalCase")]
        struct ArchiveImage {
            repo_tags: Vec<String>,
            config: String,
        }
        let entries: Vec<ArchiveImage> = serde_json::from_str(&index)?;
        let mut expected: BTreeMap<_, _> = self
            .images
            .values()
            .map(|e| (e.tag.as_str(), &e.id[7..]))
            .collect();
        ensure!(
            entries.len() == expected.len(),
            "unexpected offline archive image count"
        );
        for e in entries {
            ensure!(e.repo_tags.len() == 1, "unexpected Docker archive tags");
            let id = expected
                .remove(e.repo_tags[0].as_str())
                .context("unexpected image in archive")?;
            ensure!(
                e.config == format!("blobs/sha256/{id}") || e.config == format!("{id}.json"),
                "wrong archive configuration digest"
            );
        }
        child(
            root,
            docker_command(docker)
                .args(["image", "load", "--input"])
                .arg(archive),
        )?;
        self.verify_with(root, docker)
    }
}

fn docker_command(binary: &Path) -> Command {
    let mut cmd = Command::new(binary);
    cmd.env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("DOCKER_HOST", "unix:///var/run/docker.sock");
    cmd
}

// Signed uncompressed posix tar from the workstation. Reject all link, device,
// and traversal entries before extracting even one member into an empty directory.
fn unpack(archive: &Path, dest: &Path, entries: &[Member]) -> Result<()> {
    let expected: BTreeSet<&str> = entries.iter().map(|x| x.path.as_str()).collect();
    let allowed_roots: BTreeSet<_> = expected
        .iter()
        .filter_map(|name| name.split_once('/').map(|(root, _)| root))
        .collect();
    let named = child(dest, tar_command().arg("-tf").arg(archive))?;
    let types = child(dest, tar_command().arg("-tvf").arg(archive))?;
    ensure!(
        named.lines().count() == types.lines().count(),
        "invalid archive entries"
    );
    let mut names = BTreeSet::new();
    for (raw, detail) in named.lines().zip(types.lines()) {
        let name = raw.strip_prefix("./").unwrap_or(raw);
        if detail.starts_with('d') {
            if name.is_empty() || name == "." {
                continue;
            }
            ensure!(
                safe_path(name.trim_end_matches('/'))
                    && allowed_roots.contains(name.split('/').next().unwrap_or_default()),
                "unsafe archive directory"
            );
        } else {
            ensure!(
                detail.starts_with('-')
                    && safe_path(name)
                    && expected.contains(name)
                    && names.insert(name),
                "unexpected archive member"
            );
        }
    }
    ensure!(names == expected, "incomplete signed archive");
    child(
        dest,
        tar_command().args(["--no-same-owner", "-xf"]).arg(archive),
    )?;
    Manifest::verify_tree(entries, dest)
}
pub fn extract(bundle: &Path, dest: &Path, arch: Architecture) -> Result<()> {
    extract_with_pin(bundle, dest, arch, Path::new(SIGNERS))
}
fn extract_with_pin(bundle: &Path, dest: &Path, arch: Architecture, signers: &Path) -> Result<()> {
    let m = Manifest::read(bundle, signers, arch)?;
    ensure!(
        dest.is_dir() && fs::read_dir(dest)?.next().is_none(),
        "empty staging directory required"
    );
    for (name, checksum) in [
        ("fv", &m.binary_sha256),
        ("source.tar", &m.source_sha256),
        ("image.tar", &m.image_archive_sha256),
        ("sbom.cdx.json", &m.sbom_sha256),
        ("runtime.tar", &m.runtime_archive_sha256),
    ] {
        ensure!(
            sha(&bundle.join(name))? == *checksum,
            "uploaded release artifact digest mismatch"
        );
    }
    unpack(&bundle.join("source.tar"), dest, &m.files)?;
    unpack(&bundle.join("runtime.tar"), dest, &m.runtime_files)?;
    verify_elf(&bundle.join("fv"), arch)?;
    verify_elf(&dest.join("node"), arch)?;
    fs::create_dir_all(dest.join("target/release"))?;
    fs::copy(bundle.join("fv"), dest.join("target/release/fv"))?;
    // Move the large archive on the same filesystem. A stale upload path
    // must never be able to alter an already installed rollback generation.
    let retained = dest.join(".bundle");
    fs::create_dir(&retained)?;
    for name in [
        "source-manifest.json",
        "source-manifest.json.sig",
        "sbom.cdx.json",
    ] {
        fs::copy(bundle.join(name), retained.join(name))?;
    }
    fs::rename(bundle.join("image.tar"), retained.join("image.tar"))?;
    Ok(())
}
pub fn select_generation(root: &Path, revision: &str) -> Result<()> {
    ensure!(hex(revision, 40), "invalid signed revision");
    let current = root.join(".fv-current");
    let next = root.join(".fv-current.next");
    let target = PathBuf::from(".fv-releases").join(revision);
    ensure!(
        root.join(&target).symlink_metadata()?.is_dir(),
        "retained generation is unavailable"
    );
    if fs::read_link(&current).ok().as_deref() == Some(target.as_path()) {
        return Ok(());
    }
    #[cfg(unix)]
    {
        if next.symlink_metadata().is_ok() {
            fs::remove_file(&next)?;
        }
        std::os::unix::fs::symlink(&target, &next)?;
        fs::rename(next, current)?;
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use fv_config::{digest, random_secret};
    use serde_json::{Value, json};
    use std::os::unix::fs::{PermissionsExt, symlink};

    struct Fixture {
        root: PathBuf,
        bundle: PathBuf,
        pin: PathBuf,
        key: PathBuf,
        json: Value,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    fn elf(marker: u8) -> Vec<u8> {
        let mut b = vec![0; 65];
        b[..6].copy_from_slice(b"\x7fELF\x02\x01");
        b[18] = 62;
        b[64] = marker;
        b
    }
    fn write(root: &Path, name: &str, data: &[u8]) {
        let dest = root.join(name);
        fs::create_dir_all(dest.parent().unwrap()).unwrap();
        fs::write(dest, data).unwrap();
    }
    fn archive(root: &Path, destination: &Path, paths: &[&str]) {
        child(
            root,
            Command::new("tar").arg("-cf").arg(destination).args(paths),
        )
        .unwrap();
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("fv-signed-release-{}", random_secret()));
            let bundle = root.join("bundle");
            fs::create_dir_all(&bundle).unwrap();
            let key = root.join("operator");
            let pin = root.join("allowed_signers");
            child(
                &root,
                Command::new("ssh-keygen")
                    .args(["-q", "-t", "ed25519", "-N", "", "-f"])
                    .arg(&key),
            )
            .unwrap();
            let public = fs::read_to_string(key.with_extension("pub")).unwrap();
            fs::write(
                &pin,
                format!(
                    "founder-village-release namespaces=\"fv-release-v3\" {}\n",
                    public
                        .split_whitespace()
                        .take(2)
                        .collect::<Vec<_>>()
                        .join(" ")
                ),
            )
            .unwrap();
            fs::set_permissions(&pin, fs::Permissions::from_mode(0o600)).unwrap();
            let revision = "a".repeat(40);
            let id = format!("sha256:{}", "b".repeat(64));
            let manifest_id = format!("sha256:{}", "d".repeat(64));
            let images:BTreeMap<_,_>=KINDS.iter().map(|k|{
                let base=if *k=="app" {"runtime"} else {*k};
                (*k,json!({"tag":format!("fv-{base}:local-{revision}"),"id":id,"manifestId":manifest_id}))
            }).collect();
            let source = root.join("source");
            let runtime = root.join("runtime");
            write(&source, "config/applications.json", b"{}");
            write(&source, "config/snow ☃.json", b"{}");
            write(&runtime, "node", &elf(1));
            write(&runtime, "dist/packages/database/migrate.js", b"migrate");
            archive(&source, &bundle.join("source.tar"), &["config"]);
            archive(&runtime, &bundle.join("runtime.tar"), &["node", "dist"]);
            write(&bundle, "fv", &elf(2));
            write(&bundle, "sbom.cdx.json", b"sbom");
            let image_index:Vec<_>=images.values().map(|v|json!({"RepoTags":[v["tag"]],"Config":format!("blobs/sha256/{}","b".repeat(64))})).collect();
            write(
                &root,
                "image/manifest.json",
                &serde_json::to_vec(&image_index).unwrap(),
            );
            archive(
                &root.join("image"),
                &bundle.join("image.tar"),
                &["manifest.json"],
            );
            let json = json!({"version":3,"distribution":"workstation","revision":revision,"checkoutRevision":revision,"sourceKind":"git-commit",
                "buildSourceSha256":"c".repeat(64),"architecture":"amd64","image":images["app"]["tag"],"imageId":id,"images":images,
                "sourceSha256":sha(&bundle.join("source.tar")).unwrap(),"binarySha256":digest(&elf(2)),"runtimeArchiveSha256":sha(&bundle.join("runtime.tar")).unwrap(),"imageArchiveSha256":sha(&bundle.join("image.tar")).unwrap(),"sbomSha256":digest(b"sbom"),
                "files":[{"path":"config/applications.json","sha256":digest(b"{}")},{"path":"config/snow ☃.json","sha256":digest(b"{}")}],
                "runtimeFiles":[{"path":"node","sha256":digest(&elf(1))},{"path":"dist/packages/database/migrate.js","sha256":digest(b"migrate")}]});
            let f = Self {
                root,
                bundle,
                pin,
                key,
                json,
            };
            f.sign(&f.json, "fv-release-v3");
            f
        }
        fn sign(&self, value: &Value, namespace: &str) {
            let manifest = self.bundle.join("source-manifest.json");
            fs::write(&manifest, serde_json::to_vec(value).unwrap()).unwrap();
            let _ = fs::remove_file(self.bundle.join("source-manifest.json.sig"));
            child(
                &self.bundle,
                Command::new("ssh-keygen")
                    .args(["-Y", "sign", "-f"])
                    .arg(&self.key)
                    .args(["-n", namespace])
                    .arg(manifest),
            )
            .unwrap();
        }
        fn read(&self) -> Result<Manifest> {
            Manifest::read(&self.bundle, &self.pin, Architecture::Amd64)
        }
        fn dest(&self, tag: &str) -> PathBuf {
            let d = self.root.join(tag);
            fs::create_dir_all(&d).unwrap();
            d
        }
    }
    #[test]
    fn signature_binds_namespace_platform_source_identity_and_exact_service_set() {
        let f = Fixture::new();
        assert!(f.read().is_ok());
        assert!(Manifest::read(&f.bundle, &f.pin, Architecture::Arm64).is_err());
        let wrong = Fixture::new();
        assert!(Manifest::read(&f.bundle, &wrong.pin, Architecture::Amd64).is_err());
        let mut changed = f.json.clone();
        changed["revision"] = json!("f".repeat(40));
        fs::write(
            f.bundle.join("source-manifest.json"),
            serde_json::to_vec(&changed).unwrap(),
        )
        .unwrap();
        assert!(f.read().is_err());
        f.sign(&f.json, "another-namespace");
        assert!(f.read().is_err());
        for (key, value) in [
            ("sourceKind", json!("worktree")),
            ("buildSourceSha256", json!("invalid")),
            ("image", json!("unreviewed:latest")),
        ] {
            let mut v = f.json.clone();
            v[key] = value;
            f.sign(&v, "fv-release-v3");
            assert!(f.read().is_err());
        }
        for (key, value) in [
            ("tag", json!("fv-postgres:latest")),
            ("id", json!("no-digest")),
            ("manifestId", json!("unbound")),
        ] {
            let mut v = f.json.clone();
            v["images"]["postgres"][key] = value;
            f.sign(&v, "fv-release-v3");
            assert!(f.read().is_err());
        }
        let mut missing = f.json.clone();
        missing["images"].as_object_mut().unwrap().remove("caddy");
        f.sign(&missing, "fv-release-v3");
        assert!(f.read().is_err());
        f.sign(&f.json, "fv-release-v3");
        fs::set_permissions(&f.pin, fs::Permissions::from_mode(0o666)).unwrap();
        assert!(f.read().is_err());
    }
    #[test]
    fn extraction_seals_one_offline_archive_and_detects_each_kind_of_drift() {
        use std::os::unix::fs::MetadataExt;
        let f = Fixture::new();
        let dest = f.dest("extracted");
        let original_inode = f.bundle.join("image.tar").metadata().unwrap().ino();
        extract_with_pin(&f.bundle, &dest, Architecture::Amd64, &f.pin).unwrap();
        f.read().unwrap().verify_source(&dest).unwrap();
        assert_eq!(
            dest.join(".bundle/image.tar").metadata().unwrap().ino(),
            original_inode
        );
        assert!(!f.bundle.join("image.tar").exists());
        fs::copy(dest.join(".bundle/image.tar"), f.bundle.join("image.tar")).unwrap();
        let signature = fs::read(f.bundle.join("source-manifest.json.sig")).unwrap();
        fs::write(
            f.bundle.join("source-manifest.json.sig"),
            b"tampered staging copy",
        )
        .unwrap();
        assert!(Manifest::read(&dest.join(".bundle"), &f.pin, Architecture::Amd64).is_ok());
        fs::write(f.bundle.join("source-manifest.json.sig"), signature).unwrap();
        assert!(extract_with_pin(&f.bundle, &dest, Architecture::Amd64, &f.pin).is_err());
        for path in [
            "fv",
            "source.tar",
            "runtime.tar",
            "image.tar",
            "sbom.cdx.json",
        ] {
            let file = f.bundle.join(path);
            let original = fs::read(&file).unwrap();
            fs::write(&file, b"modified").unwrap();
            assert!(
                extract_with_pin(&f.bundle, &f.dest("empty"), Architecture::Amd64, &f.pin).is_err()
            );
            fs::write(&file, original).unwrap();
        }
        for path in [
            "target/release/fv",
            "node",
            "dist/packages/database/migrate.js",
            "config/applications.json",
            ".bundle/sbom.cdx.json",
        ] {
            let file = dest.join(path);
            let original = fs::read(&file).unwrap();
            fs::write(&file, b"modified").unwrap();
            assert!(f.read().unwrap().verify_source(&dest).is_err());
            fs::write(&file, original).unwrap();
        }
    }
    #[test]
    fn trusted_archive_format_still_refuses_links_extra_files_and_protected_paths() {
        let f = Fixture::new();
        let src = f.root.join("source");
        let archive_path = f.bundle.join("source.tar");
        fs::remove_file(src.join("config/applications.json")).unwrap();
        symlink("/etc/passwd", src.join("config/applications.json")).unwrap();
        archive(&src, &archive_path, &["config"]);
        let mut v = f.json.clone();
        v["sourceSha256"] = json!(sha(&archive_path).unwrap());
        f.sign(&v, "fv-release-v3");
        assert!(
            extract_with_pin(&f.bundle, &f.dest("links"), Architecture::Amd64, &f.pin).is_err()
        );
        assert!(!f.root.join("links/config/applications.json").exists());
        fs::remove_file(src.join("config/applications.json")).unwrap();
        write(&src, "config/applications.json", b"{}");
        write(&src, "config/unlisted", b"bad");
        archive(&src, &archive_path, &["config"]);
        v["sourceSha256"] = json!(sha(&archive_path).unwrap());
        f.sign(&v, "fv-release-v3");
        assert!(
            extract_with_pin(&f.bundle, &f.dest("extras"), Architecture::Amd64, &f.pin).is_err()
        );
        for name in [
            "../escape",
            "config/../escape",
            "/etc/passwd",
            "secrets/bad",
            "config/live.private.json",
            "Cargo.toml",
        ] {
            let mut v = f.json.clone();
            v["files"][0]["path"] = json!(name);
            f.sign(&v, "fv-release-v3");
            assert!(f.read().is_err());
        }
    }
    #[test]
    fn offline_loader_recovers_a_missing_cache_and_refuses_incorrect_image_identity() {
        let f = Fixture::new();
        let m = f.read().unwrap();
        let dir = f.dest(&format!(".fv-releases/{}/.bundle", m.revision));
        fs::hard_link(f.bundle.join("image.tar"), dir.join("image.tar")).unwrap();
        let docker = f.root.join("fake-docker");
        let stub = format!(
            "#!/bin/sh\nset -eu\ncase \"$1:$2\" in\nimage:load) test \"$3\" = --input; test -f \"$4\"; touch loaded; echo load >> calls;;\nimage:inspect) test -f loaded; test \"$3\" = --platform; test \"$4\" = linux/amd64; case \"$7\" in fv-runtime:*) echo '{} linux/amd64 {}';; *) echo '{} linux/amd64';; esac;;\n*) exit 1;;\nesac\n",
            m.images["app"].manifest_id, m.revision, m.images["postgres"].id
        );
        write(&f.root, "fake-docker", stub.as_bytes());
        fs::set_permissions(&docker, fs::Permissions::from_mode(0o700)).unwrap();
        m.load_with(&f.root, &docker).unwrap();
        m.load_with(&f.root, &docker).unwrap();
        assert_eq!(fs::read_to_string(f.root.join("calls")).unwrap(), "load\n");
        write(
            &f.root,
            "fake-docker",
            stub.replace(
                &m.images["app"].manifest_id,
                &format!("sha256:{}", "e".repeat(64)),
            )
            .as_bytes(),
        );
        assert!(m.load_with(&f.root, &docker).is_err());
        fs::remove_file(f.root.join("loaded")).unwrap();
        write(&dir, "image.tar", b"wrong bytes");
        assert!(m.load_with(&f.root, &docker).is_err());
        assert!(!f.root.join("loaded").exists());
    }
}
