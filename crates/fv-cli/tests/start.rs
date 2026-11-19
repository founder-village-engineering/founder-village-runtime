use std::{
    fs,
    net::TcpListener,
    path::PathBuf,
    process::{Command, Stdio},
};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("fv-start-{}", fv_config::random_secret()));
        fs::create_dir(&dir).unwrap();
        Self(dir)
    }
    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_fv"));
        command.arg("--root").arg(&self.0).stdin(Stdio::null());
        command
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn listing_and_noninteractive_start_do_not_initialize_or_run_anything() {
    let fixture = Fixture::new();
    for args in [vec!["start"], vec!["start", "--list"]] {
        let output = fixture.command().args(args).output().unwrap();
        assert!(output.status.success(), "{output:?}");
        let text = String::from_utf8(output.stdout).unwrap();
        assert!(text.contains("Start local servers"));
        assert!(text.contains("release-deploy"));
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 0);
    }
    for args in [vec!["start", "unknown"], vec!["start", "local", "--list"]] {
        assert!(
            !fixture
                .command()
                .args(args)
                .output()
                .unwrap()
                .status
                .success()
        );
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 0);
    }
}

#[test]
fn occupied_application_port_fails_before_build_or_catalog_changes() {
    let fixture = Fixture::new();
    fs::create_dir_all(fixture.0.join("node_modules/tsx")).unwrap();
    let config = fixture.0.join("local.json");
    fs::write(&config, include_str!("../../../config/local.json")).unwrap();
    // If a real service already occupies this port, the same refusal applies.
    let _listener = TcpListener::bind(("127.0.0.1", 43801)).ok();
    let output = fixture
        .command()
        .args(["start", "local", "--config"])
        .arg(config)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        String::from_utf8(output.stderr)
            .unwrap()
            .contains("port 43801 is already in use")
    );
    assert!(!fixture.0.join(".state/local.env").exists());
    assert!(!fixture.0.join(".state/local/start").exists());
    assert!(!fixture.0.join("dist").exists());
}
