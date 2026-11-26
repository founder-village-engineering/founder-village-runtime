use anyhow::{Context, Result, ensure};
use fv_config::{Config, private_write, random_secret};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Descriptor {
    version: u8,
    backup: String,
    sha256: String,
    size: u64,
    signature: String,
}

const RECEIPT_NAMESPACE: &str = "fv-workstation-backup-receipt-v1";
fn message(backup: &str, sha256: &str, size: u64) -> String {
    format!("fv-workstation-backup-v1\n{backup}\n{sha256}\n{size}\n")
}
fn mac(key: &str, backup: &str, sha256: &str, size: u64) -> Result<Hmac<Sha256>> {
    let mut signer = Hmac::<Sha256>::new_from_slice(key.as_bytes())?;
    signer.update(message(backup, sha256, size).as_bytes());
    Ok(signer)
}

fn directory(root: &Path, c: &Config) -> Result<PathBuf> {
    ensure!(
        c.environment == "production" && c.backup.workstation(),
        "workstation backup mode required"
    );
    let dir = root.join(".state/production/workstation-snapshot");
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&dir)?;
    let m = dir.symlink_metadata()?;
    ensure!(
        m.is_dir() && m.uid() == 0 && m.mode() & 0o077 == 0,
        "unsafe backup export directory"
    );
    Ok(dir)
}

fn private_file(file: &Path) -> Result<File> {
    let m = file.symlink_metadata()?;
    ensure!(
        m.is_file() && m.uid() == 0 && m.mode() & 0o077 == 0,
        "unsafe backup archive"
    );
    Ok(File::open(file)?)
}

struct Temporary(PathBuf);
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
fn temporary(path: PathBuf) -> Result<(Temporary, File)> {
    let file = OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .mode(0o600)
        .open(&path)?;
    Ok((Temporary(path), file))
}

// CLI and ops both hold the host operation lock. A killed import or tar process
// can leave a large incomplete file; the next run reclaims only this staging name.
fn archive_stage(dir: &Path, name: &str) -> Result<(Temporary, File)> {
    let path = dir.join(name);
    match path.symlink_metadata() {
        Ok(m) => {
            ensure!(
                m.is_file() && m.uid() == 0 && m.mode() & 0o077 == 0,
                "unsafe interrupted archive"
            );
            fs::remove_file(&path)?;
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    temporary(path)
}

fn file_digest(file: File) -> Result<(String, u64)> {
    let mut hash = Sha256::new();
    let size = io::copy(&mut io::BufReader::new(file), &mut hash)?;
    Ok((format!("{:x}", hash.finalize()), size))
}

pub(super) fn pack(root: &Path, c: &Config, backup: &str) -> Result<()> {
    let dir = directory(root, c)?;
    let (partial, file) = archive_stage(&dir, ".capture.partial")?;
    let limit = fs2::available_space(&dir)?
        .checked_sub(1024 * 1024 * 1024)
        .context("insufficient disk headroom for backup export")?;
    ensure!(limit > 0, "insufficient disk headroom for backup export");
    let installed = crate::workstation::Manifest::installed(root, c.provider.architecture)?;
    let bundle = root.join(".state/production/recovery").join(backup);
    ensure!(
        bundle.symlink_metadata()?.is_dir(),
        "missing signed recovery directory"
    );
    // The archive builder sees only the encrypted repo and the completed recovery directory.
    // The host CLI lock serializes pgBackRest captures/expiry. Archive push may add later WAL.
    // The capture receipt's named recovery point is flushed and archived before this step.
    fv_host::run_command(
        fv_host::docker(root).args([
            "run",
            "--rm",
            "--pull",
            "never",
            "--network",
            "none",
            "--read-only",
            "--ulimit",
            &format!("fsize={limit}:{limit}"),
            "--mount",
            &format!(
                "type=volume,source={}_backups,target=/snapshot/repository,readonly",
                c.project
            ),
            "--mount",
            &format!(
                "type=bind,source={},target=/snapshot/recovery,readonly",
                bundle.display()
            ),
            "--mount",
            &format!("type=bind,source={},target=/out.tar", partial.0.display()),
            "--entrypoint",
            "tar",
            &installed.images["postgres"].id,
            "--format=posix",
            "--hard-dereference",
            "--exclude=*.tmp",
            "-C",
            "/snapshot",
            "-cf",
            "/out.tar",
            "repository",
            "recovery",
        ]),
        7200,
    )?;
    file.sync_all()?;
    let (sha256, size) = file_digest(file)?;
    ensure!(size > 0, "empty workstation export");
    let env = crate::env(root, c)?;
    let descriptor = Descriptor {
        version: 1,
        backup: backup.to_owned(),
        signature: format!(
            "{:x}",
            mac(&env["BACKUP_HMAC_KEY"], backup, &sha256, size)?
                .finalize()
                .into_bytes()
        ),
        sha256,
        size,
    };
    // Failure between renames fails closed: the earlier descriptor cannot authenticate the new bytes.
    fs::rename(&partial.0, dir.join("snapshot.tar"))?;
    private_write(
        &dir.join("descriptor.json"),
        &serde_json::to_vec(&descriptor)?,
    )?;
    File::open(&dir)?.sync_all()?;
    Ok(())
}

fn read_descriptor(root: &Path, c: &Config, backup: &str) -> Result<(PathBuf, Descriptor)> {
    let dir = directory(root, c)?;
    let d: Descriptor =
        serde_json::from_reader(private_file(&dir.join("descriptor.json"))?.take(4097))?;
    let hex = |s: &str| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    ensure!(
        d.version == 1 && d.backup == backup && hex(&d.sha256) && hex(&d.signature) && d.size > 0,
        "snapshot descriptor does not match the current backup"
    );
    let env = crate::env(root, c)?;
    let expected = format!(
        "{:x}",
        mac(&env["BACKUP_HMAC_KEY"], backup, &d.sha256, d.size)?
            .finalize()
            .into_bytes()
    );
    use subtle::ConstantTimeEq;
    ensure!(
        bool::from(expected.as_bytes().ct_eq(d.signature.as_bytes())),
        "snapshot descriptor authentication failed"
    );
    Ok((dir, d))
}

pub(super) fn local_archive(root: &Path, c: &Config, backup: &str) -> Result<PathBuf> {
    let (dir, d) = read_descriptor(root, c, backup)?;
    let file = dir.join("snapshot.tar");
    ensure!(
        file_digest(private_file(&file)?)? == (d.sha256, d.size),
        "host snapshot is incomplete"
    );
    Ok(file)
}

pub fn export_snapshot(root: &Path, c: &Config, stream: bool) -> Result<()> {
    let backup = super::verify_inventory(root, c)?;
    let (dir, d) = read_descriptor(root, c, &backup)?;
    let mut archive = private_file(&dir.join("snapshot.tar"))?;
    ensure!(
        archive.metadata()?.len() == d.size,
        "host snapshot length changed"
    );
    if stream {
        ensure!(
            io::copy(&mut archive, &mut io::stdout().lock())? == d.size,
            "incomplete snapshot export"
        );
    } else {
        // Also catches an interrupted publication between the archive and descriptor renames.
        ensure!(
            file_digest(archive)?.0 == d.sha256,
            "host snapshot checksum differs from its descriptor"
        );
        println!("{}", serde_json::to_string(&d)?);
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Returned {
    descriptor: Descriptor,
    workstation_signature: String,
}

fn operator_pin() -> Result<String> {
    // enroll-operator.sh and sshd already trust this independently installed key.
    let home = Path::new("/home/fv");
    let authorized = home.join(".ssh/authorized_keys");
    ensure!(
        authorized.canonicalize()? == authorized,
        "operator enrollment path is indirect"
    );
    let owner = home.metadata()?.uid();
    for path in [home, &home.join(".ssh"), authorized.as_path()] {
        let m = path.symlink_metadata()?;
        ensure!(
            (m.uid() == owner || m.uid() == 0) && m.mode() & 0o022 == 0,
            "unsafe operator enrollment"
        );
    }
    let file = File::open(&authorized)?;
    ensure!(
        file.metadata()?.is_file() && file.metadata()?.len() <= 8192,
        "invalid operator enrollment file"
    );
    let mut text = String::new();
    file.take(8193).read_to_string(&mut text)?;
    let mut lines = text
        .lines()
        .filter(|v| !v.trim().is_empty() && !v.trim_start().starts_with('#'));
    let mut parts = lines
        .next()
        .context("missing enrolled operator")?
        .split_whitespace();
    ensure!(
        parts.next() == Some("ssh-ed25519") && lines.next().is_none(),
        "expected the single enrolled Ed25519 operator"
    );
    let key = parts.next().context("invalid enrolled operator")?;
    ensure!(
        key.len() == 68
            && key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b)),
        "invalid operator public key"
    );
    Ok(format!(
        "fv-backup-operator namespaces=\"{RECEIPT_NAMESPACE}\" ssh-ed25519 {key}\n"
    ))
}

fn verify_operator(dir: &Path, pin: &str, d: &Descriptor, signature: &str) -> Result<()> {
    ensure!(
        !signature.is_empty() && signature.len() <= 4096,
        "invalid workstation signature length"
    );
    let (pin_path, mut pin_file) = temporary(dir.join(format!(".verify-{}", random_secret())))?;
    pin_file.write_all(pin.as_bytes())?;
    let (sig_path, mut sig_file) = temporary(dir.join(format!(".verify-{}", random_secret())))?;
    sig_file.write_all(signature.as_bytes())?;
    let mut verify = Command::new("/usr/bin/ssh-keygen")
        .env_clear()
        .args([
            "-Y",
            "verify",
            "-I",
            "fv-backup-operator",
            "-n",
            RECEIPT_NAMESPACE,
            "-f",
        ])
        .arg(&pin_path.0)
        .arg("-s")
        .arg(&sig_path.0)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    let sent = verify
        .stdin
        .take()
        .context("missing verifier input")?
        .write_all(message(&d.backup, &d.sha256, d.size).as_bytes());
    ensure!(
        verify.wait()?.success() && sent.is_ok(),
        "the enrolled workstation did not sign this archive receipt"
    );
    Ok(())
}

pub fn import_drill(root: &Path, c: &Config) -> Result<()> {
    let backup = super::verify_inventory(root, c)?;
    let (dir, d) = read_descriptor(root, c, &backup)?;
    let mut input = io::stdin().lock();
    let mut prefix = [0u8; 4];
    input.read_exact(&mut prefix)?;
    let length = u32::from_be_bytes(prefix);
    ensure!((1..=4096).contains(&length), "missing workstation receipt");
    let mut armored = vec![0u8; length as usize];
    input.read_exact(&mut armored)?;
    let workstation_signature =
        String::from_utf8(armored).context("invalid workstation receipt")?;
    verify_operator(&dir, &operator_pin()?, &d, &workstation_signature)?;
    let (copy, mut out) = archive_stage(&dir, ".import.partial")?;
    ensure!(
        fs2::available_space(&dir)? >= d.size.saturating_add(1024 * 1024 * 1024),
        "insufficient disk space for returned backup"
    );
    let length = io::copy(
        &mut input.take(d.size.checked_add(1).context("invalid size")?),
        &mut out,
    )?;
    ensure!(
        length == d.size,
        "returned backup length differs from the signed export"
    );
    out.sync_all()?;
    ensure!(
        file_digest(private_file(&copy.0)?)?.0 == d.sha256,
        "returned backup checksum differs from the signed export"
    );
    super::drill(root, c, Some((&copy.0, true)))?;
    let changed=crate::client(root,c)?.execute(
        "UPDATE control.backups SET offsite=true, restored=true WHERE manifest_hash=$1 AND verified",
        &[&backup],
    )?;
    ensure!(changed > 0, "no backup row for returned snapshot");
    private_write(
        &dir.join("verified-copy.json"),
        &serde_json::to_vec(&Returned {
            descriptor: d,
            workstation_signature,
        })?,
    )?;
    Ok(())
}

pub(super) fn verify_copy(root: &Path, c: &Config, backup: &str) -> Result<()> {
    let (dir, expected) = read_descriptor(root, c, backup)?;
    let returned: Returned = serde_json::from_reader(
        private_file(&dir.join("verified-copy.json"))
            .context("pull and restore the current snapshot from the workstation")?
            .take(8193),
    )?;
    ensure!(
        returned.descriptor == expected,
        "workstation has not returned and restored the current snapshot"
    );
    verify_operator(
        &dir,
        &operator_pin()?,
        &expected,
        &returned.workstation_signature,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_operator_receipt_for_the_exact_retained_bytes_verifies() -> Result<()> {
        let dir = std::env::temp_dir().join(format!("fv-returned-{}", random_secret()));
        fs::DirBuilder::new().mode(0o700).create(&dir)?;
        let result = (|| -> Result<()> {
            let key = dir.join("operator");
            ensure!(
                Command::new("/usr/bin/ssh-keygen")
                    .args(["-q", "-t", "ed25519", "-N", "", "-f"])
                    .arg(&key)
                    .status()?
                    .success(),
                "fixture key generation failed"
            );
            let public = fs::read_to_string(key.with_extension("pub"))?;
            let fields: Vec<_> = public.split_whitespace().take(2).collect();
            let pin = format!(
                "fv-backup-operator namespaces=\"{RECEIPT_NAMESPACE}\" {} {}\n",
                fields[0], fields[1]
            );
            let mut d = Descriptor {
                version: 1,
                backup: "a".repeat(64),
                sha256: "b".repeat(64),
                size: 513,
                signature: String::new(),
            };
            let data = dir.join("receipt");
            private_write(&data, message(&d.backup, &d.sha256, d.size).as_bytes())?;
            ensure!(
                Command::new("/usr/bin/ssh-keygen")
                    .args(["-Y", "sign", "-q", "-n", RECEIPT_NAMESPACE, "-f"])
                    .arg(&key)
                    .arg(&data)
                    .status()?
                    .success(),
                "fixture signing failed"
            );
            let signature = fs::read_to_string(data.with_extension("sig"))?;
            verify_operator(&dir, &pin, &d, &signature)?;
            d.size += 1;
            assert!(verify_operator(&dir, &pin, &d, &signature).is_err());
            assert!(verify_operator(&dir, &pin, &d, "").is_err());
            Ok(())
        })();
        fs::remove_dir_all(dir)?;
        result
    }
}
