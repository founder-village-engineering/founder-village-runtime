use anyhow::{Result, ensure};
use fv_config::Config;
use std::{
    collections::BTreeMap,
    path::Path,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

// Each bounded operation owns a process group, so a timed-out shell cannot leave
// its children running with host credentials. Drop also covers polling errors.
struct OperationChild(Child);
impl Drop for OperationChild {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            let _ = Command::new("/bin/kill")
                .args(["-KILL", "--", &format!("-{}", self.0.id())])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

pub fn run(
    program: &str,
    args: &[&str],
    root: &Path,
    env: &BTreeMap<String, String>,
    timeout: u64,
) -> Result<()> {
    ensure!(timeout > 0, "positive operation timeout required");
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(root)
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = OperationChild(command.spawn()?);
    let start = Instant::now();
    loop {
        if let Some(status) = child.0.try_wait()? {
            ensure!(status.success(), "{program} operation failed");
            return Ok(());
        }
        if start.elapsed() > Duration::from_secs(timeout) {
            anyhow::bail!("{program} operation timed out")
        }
        thread::sleep(Duration::from_millis(100));
    }
}
pub fn cloud_init(c: &Config, ssh_keys: &[String]) -> Result<String> {
    ensure!(
        !ssh_keys.is_empty()
            && ssh_keys
                .iter()
                .all(|k| k.starts_with("ssh-ed25519 ") && !k.chars().any(char::is_control)),
        "valid operator public keys required"
    );
    let keys = ssh_keys
        .iter()
        .map(|k| serde_json::to_string(k).map(|quoted| format!("      - {quoted}\n")))
        .collect::<std::result::Result<String, _>>()?;
    Ok(format!(
        "#cloud-config\npackage_update: true\npackage_upgrade: true\npackages: [ca-certificates, curl, ufw, wireguard, age, jq, xz-utils, unattended-upgrades, openssh-server]\nusers:\n  - name: fv\n    groups: [sudo]\n    shell: /bin/bash\n    sudo: ['ALL=(ALL) NOPASSWD:ALL']\n    ssh_authorized_keys:\n{keys}ssh_pwauth: false\ndisable_root: true\nwrite_files:\n  - path: /etc/ssh/sshd_config.d/90-fv.conf\n    permissions: '0600'\n    content: |\n      PasswordAuthentication no\n      PermitRootLogin no\n      KbdInteractiveAuthentication no\n      X11Forwarding no\n      AllowUsers fv\nruncmd:\n  - [ufw, default, deny, incoming]\n  - [ufw, default, allow, outgoing]\n{}  - [ufw, allow, {}/udp]\n  - [ufw, --force, enable]\n  - [systemctl, enable, --now, systemd-timesyncd]\n  - [systemctl, restart, ssh]\n",
        c.ssh_cidrs
            .iter()
            .map(|ip| format!("  - [ufw, allow, from, '{ip}', to, any, port, '22', proto, tcp]\n"))
            .collect::<String>(),
        c.wireguard_port
    ))
}

pub fn install_tools(root: &Path) -> Result<()> {
    use std::io::Read;
    ensure!(std::env::consts::OS == "linux", "Linux host required");
    let lock: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("config/tools.lock.json"))?)?;
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        _ => anyhow::bail!("unsupported host architecture"),
    };
    let version = lock["node"]["version"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("missing Node version"))?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()?;
    let dir = root.join(".state/downloads");
    std::fs::create_dir_all(&dir)?;
    for (url, expected, file, executable) in [
        (
            format!("https://nodejs.org/dist/v{version}/node-v{version}-linux-{arch}.tar.xz"),
            lock["node"][format!("linux-{arch}")].as_str().unwrap_or(""),
            "node.tar.xz",
            false,
        ),
        (
            format!(
                "https://github.com/sigstore/cosign/releases/download/v{}/cosign-linux-{}",
                lock["cosign"]["version"].as_str().unwrap_or(""),
                if arch == "x64" { "amd64" } else { "arm64" }
            ),
            lock["cosign"][format!("linux-{}", if arch == "x64" { "amd64" } else { "arm64" })]
                .as_str()
                .unwrap_or(""),
            "cosign",
            true,
        ),
    ] {
        ensure!(expected.len() == 64, "tool digest required");
        let response = client.get(url).send()?;
        ensure!(response.status().is_success(), "tool download failed");
        let mut bytes = Vec::new();
        response.take(128 * 1024 * 1024).read_to_end(&mut bytes)?;
        ensure!(
            fv_config::digest(&bytes) == expected,
            "tool checksum mismatch"
        );
        let path = dir.join(file);
        fv_config::private_write(&path, &bytes)?;
        if executable {
            run(
                "install",
                &["-m", "755", path.to_str().unwrap(), "/usr/local/bin/cosign"],
                root,
                &BTreeMap::new(),
                30,
            )?;
        } else {
            run(
                "tar",
                &[
                    "-xJf",
                    path.to_str().unwrap(),
                    "--strip-components=1",
                    "-C",
                    "/usr/local",
                ],
                root,
                &BTreeMap::new(),
                60,
            )?;
        }
    }
    Ok(())
}

pub fn assert_owned_host(c: &Config) -> Result<()> {
    let id = Command::new("id").arg("-u").output()?;
    ensure!(
        id.status.success() && id.stdout == b"0\n",
        "host convergence requires root"
    );
    let marker = Path::new("/etc/fv-runtime-owner");
    if marker.exists() {
        ensure!(
            std::fs::read_to_string(marker)?.trim() == c.project,
            "host belongs to a different runtime project"
        );
    } else {
        for args in [vec!["ps", "-aq"], vec!["volume", "ls", "-q"]] {
            match Command::new("docker").args(args).output() {
                Ok(result) => {
                    ensure!(
                        result.status.success(),
                        "Docker inventory unavailable; host convergence refused"
                    );
                    ensure!(
                        result.stdout.is_empty(),
                        "unowned Docker workloads/data found; host convergence refused"
                    );
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    ensure!(
                        !Path::new("/var/lib/docker").exists(),
                        "unowned Docker data found; host convergence refused"
                    );
                }
                Err(_) => anyhow::bail!("Docker inventory unavailable; host convergence refused"),
            }
        }
        fv_config::private_write(marker, c.project.as_bytes())?;
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn cloud_init_keys_are_quoted_and_cannot_inject_lines() {
        let config: Config =
            serde_json::from_str(include_str!("../../../config/local.json")).unwrap();
        let key = "ssh-ed25519 AAAA comment: [unsafe-yaml]".to_string();
        let rendered = cloud_init(&config, std::slice::from_ref(&key)).unwrap();
        assert!(rendered.contains(&format!(
            "      - {}\n",
            serde_json::to_string(&key).unwrap()
        )));
        for injected in [
            "ssh-ed25519 AAAA\rruncmd: [injected]",
            "ssh-ed25519 AAAA\nruncmd: [injected]",
            "ssh-ed25519 AAAA\0",
        ] {
            assert!(cloud_init(&config, &[injected.to_string()]).is_err());
        }
    }

    #[test]
    fn timeout_stops_background_descendants() {
        let dir = std::env::temp_dir().join(format!(
            "fv-host-timeout-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&dir).unwrap();
        let marker = dir.join("surviving-child");
        let result = run(
            "/bin/sh",
            &[
                "-c",
                "(sleep 2; touch \"$1\") & wait",
                "operation-test",
                marker.to_str().unwrap(),
            ],
            &dir,
            &BTreeMap::new(),
            1,
        );
        assert!(result.unwrap_err().to_string().contains("timed out"));
        thread::sleep(Duration::from_millis(1400));
        assert!(
            !marker.exists(),
            "background child survived operation timeout"
        );
        std::fs::remove_dir(dir).unwrap();
    }

    #[test]
    fn finished_operation_stops_background_descendants() {
        let dir = std::env::temp_dir().join(format!(
            "fv-host-finished-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&dir).unwrap();
        let marker = dir.join("surviving-child");
        run(
            "/bin/sh",
            &[
                "-c",
                "(sleep 1; touch \"$1\") & exit 0",
                "operation-test",
                marker.to_str().unwrap(),
            ],
            &dir,
            &BTreeMap::new(),
            5,
        )
        .unwrap();
        thread::sleep(Duration::from_millis(1300));
        assert!(
            !marker.exists(),
            "background child outlived successful operation"
        );
        std::fs::remove_dir(dir).unwrap();
    }

    #[test]
    fn failed_operation_does_not_include_arguments_in_error() {
        let result = run(
            "/bin/sh",
            &["-c", "exit 1", "synthetic-secret-canary"],
            Path::new("."),
            &BTreeMap::new(),
            5,
        );
        let message = result.unwrap_err().to_string();
        assert!(message.contains("operation failed"));
        assert!(!message.contains("synthetic-secret-canary"));
    }
}
