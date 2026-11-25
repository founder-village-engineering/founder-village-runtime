use anyhow::{Result, ensure};
use fv_config::{Architecture, Config};
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
    command.args(args).current_dir(root).envs(env);
    run_command(&mut command, timeout)
}

pub fn run_command(command: &mut Command, timeout: u64) -> Result<()> {
    ensure!(timeout > 0, "positive operation timeout required");
    let mut signals = signal_hook::iterator::Signals::new([
        signal_hook::consts::SIGINT,
        signal_hook::consts::SIGTERM,
    ])?;
    let program = command.get_program().to_string_lossy().into_owned();
    command
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
        ensure!(
            signals.pending().next().is_none(),
            "{program} operation interrupted"
        );
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
    let wireguard_rule = if c.cloudflare.ssh_domain.is_none() {
        format!("  - [ufw, allow, {}/udp]\n", c.wireguard_port)
    } else {
        String::new()
    };
    Ok(format!(
        "#cloud-config\npackage_update: true\npackage_upgrade: true\npackages: [ca-certificates, curl, ufw, wireguard, age, jq, xz-utils, unattended-upgrades, openssh-server]\nusers:\n  - name: fv\n    groups: [sudo]\n    shell: /bin/bash\n    sudo: ['ALL=(ALL) NOPASSWD:ALL']\n    ssh_authorized_keys:\n{keys}ssh_pwauth: false\ndisable_root: true\nwrite_files:\n  - path: /etc/ssh/sshd_config.d/90-fv.conf\n    permissions: '0600'\n    content: |\n      PasswordAuthentication no\n      PermitRootLogin no\n      KbdInteractiveAuthentication no\n      X11Forwarding no\n      AllowUsers fv\nruncmd:\n  - [ufw, default, deny, incoming]\n  - [ufw, default, allow, outgoing]\n{}{wireguard_rule}  - [ufw, --force, enable]\n  - [systemctl, enable, --now, systemd-timesyncd]\n  - [systemctl, restart, ssh]\n",
        c.ssh_cidrs
            .iter()
            .map(|ip| format!("  - [ufw, allow, from, '{ip}', to, any, port, '22', proto, tcp]\n"))
            .collect::<String>()
    ))
}

pub fn assert_platform(c: &Config) -> Result<()> {
    ensure!(
        c.environment != "local",
        "host convergence requires a remote manifest"
    );
    ensure!(
        std::env::consts::OS == "linux",
        "remote runtime requires Linux"
    );
    ensure!(
        Architecture::from_machine(std::env::consts::ARCH)? == c.provider.architecture,
        "installed CLI architecture does not match the configured Linux platform"
    );
    let os = std::fs::read_to_string("/etc/os-release")?;
    ensure!(
        matches_ubuntu_release(&os, c.provider.ubuntu_version()?),
        "host OS does not match the configured Ubuntu LTS image"
    );
    let machine = Command::new("uname").arg("-m").output()?;
    ensure!(
        machine.status.success()
            && Architecture::from_machine(std::str::from_utf8(&machine.stdout)?.trim())?
                == c.provider.architecture,
        "host architecture does not match the configured Linux platform"
    );
    Ok(())
}

fn matches_ubuntu_release(os: &str, version: &str) -> bool {
    fn field<'a>(os: &'a str, name: &str) -> Option<&'a str> {
        os.lines().find_map(|line| {
            let (key, value) = line.split_once('=')?;
            (key == name).then(|| value.trim_matches(['\'', '"']))
        })
    }
    field(os, "ID") == Some("ubuntu") && field(os, "VERSION_ID") == Some(version)
}

pub fn verify_tunnel_ssh(
    root: &Path,
    host: &str,
    known_hosts: &Path,
    identity: Option<&Path>,
) -> Result<()> {
    ensure!(fv_config::domain(host), "invalid tunnel SSH hostname");
    let known_hosts = known_hosts.canonicalize()?;
    let file = known_hosts
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("invalid known_hosts path"))?;
    ensure!(
        known_hosts.is_file() && !file.chars().any(|ch| ch == '%' || ch.is_control()),
        "use a dedicated known_hosts file"
    );
    let file = file.replace('\\', "\\\\").replace('"', "\\\"");
    let mut command = Command::new("ssh");
    command.current_dir(root).args([
        "-F",
        "/dev/null",
        "-T",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        &format!("UserKnownHostsFile=\"{file}\""),
        "-o",
        "GlobalKnownHostsFile=none",
        "-o",
        "HostKeyAlgorithms=ssh-ed25519",
        "-o",
        "BatchMode=yes",
        "-o",
        "ClearAllForwardings=yes",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "ForwardAgent=no",
        "-o",
        "ConnectTimeout=15",
        "-o",
        "ProxyCommand=cloudflared access ssh --hostname %h",
    ]);
    if let Some(identity) = identity {
        command.arg("-i").arg(identity.canonicalize()?);
    }
    command.args(["-l", "fv", host, "sudo -n true"]);
    run_command(&mut command, 45).map_err(|_| {
        anyhow::anyhow!("Cloudflare SSH verification failed; firewall was not changed")
    })
}

pub fn docker_architecture() -> Result<Architecture> {
    let result = Command::new("docker")
        .args(["info", "--format", "{{.OSType}}/{{.Architecture}}"])
        .output()?;
    ensure!(result.status.success(), "Docker daemon unavailable");
    let platform = std::str::from_utf8(&result.stdout)?.trim();
    let machine = platform
        .strip_prefix("linux/")
        .ok_or_else(|| anyhow::anyhow!("Linux Docker daemon required"))?;
    Architecture::from_machine(machine)
}

pub fn install_tools(root: &Path) -> Result<()> {
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
        .timeout(Duration::from_secs(300))
        .build()?;
    if !Path::new("/usr/bin/xz").exists() {
        run("apt-get", &["update", "-qq"], root, &BTreeMap::new(), 120)?;
        run(
            "apt-get",
            &["install", "-y", "--no-install-recommends", "xz-utils"],
            root,
            &BTreeMap::new(),
            120,
        )?;
    }
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
        let path = dir.join(file);
        if !tool_matches(&path, expected)? {
            let response = client.get(url).send()?;
            ensure!(response.status().is_success(), "tool download failed");
            download_tool(response, &path, expected)?;
        }
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

fn tool_matches(path: &Path, expected: &str) -> Result<bool> {
    if !path.symlink_metadata().is_ok_and(|meta| meta.is_file()) {
        return Ok(false);
    }
    let checksum = Command::new("sha256sum").arg("--").arg(path).output()?;
    Ok(checksum.status.success()
        && std::str::from_utf8(&checksum.stdout)?
            .split_whitespace()
            .next()
            == Some(expected))
}

fn download_tool(response: reqwest::blocking::Response, path: &Path, expected: &str) -> Result<()> {
    use std::io::Read;
    // Current Cosign builds exceed 128 MiB. Stream to disk on small VPSes.
    const LIMIT: u64 = 256 * 1024 * 1024;
    let temporary = path.with_extension(format!("download-{}", fv_config::random_secret()));
    let result = (|| -> Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        let length = std::io::copy(&mut response.take(LIMIT + 1), &mut file)?;
        ensure!(length <= LIMIT, "tool download exceeds size limit");
        file.sync_all()?;
        ensure!(
            tool_matches(&temporary, expected)?,
            "tool checksum mismatch"
        );
        std::fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
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
    fn host_requires_the_ubuntu_version_selected_by_the_manifest() {
        for version in ["24.04", "26.04"] {
            assert!(matches_ubuntu_release(
                &format!("VERSION_ID=\"{version}\"\nID=ubuntu\n"),
                version
            ));
        }
        assert!(!matches_ubuntu_release(
            "ID=ubuntu\nVERSION_ID=\"24.04\"",
            "26.04"
        ));
        assert!(!matches_ubuntu_release(
            "ID=debian\nVERSION_ID=\"26.04\"",
            "26.04"
        ));
    }

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
