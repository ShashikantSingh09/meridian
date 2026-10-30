//! Child processes for adapters: one line-oriented JSON pipe per agent.

use std::ffi::OsStr;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

const STDERR_TAIL: usize = 2_000;

pub fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    #[cfg(not(windows))]
    let _ = cmd;
}

/// An npm install is a shim that needs its own folder on PATH to find node.
pub fn path_with_parent(cmd: &mut Command, exe: &Path) {
    let Some(dir) = exe.parent() else { return };
    let mut dirs = vec![dir.to_path_buf()];
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    if let Ok(joined) = std::env::join_paths(dirs) {
        cmd.env("PATH", joined);
    }
}

pub struct Agent {
    child: Child,
    pub stdin: ChildStdin,
    pub lines: Lines<BufReader<ChildStdout>>,
    stderr: Arc<Mutex<String>>,
}

pub fn spawn<S: AsRef<OsStr>>(exe: &Path, args: &[S], cwd: &str) -> std::io::Result<Agent> {
    let mut cmd = Command::new(exe);
    cmd.args(args)
        .current_dir(cwd)
        // Set inside a Claude Code session, and a nested run would refuse to start.
        .env_remove("CLAUDECODE")
        // Lets the watcher tell this app's own runs from the user's.
        .env(crate::watch::OWN_RUN_ENV, "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    hide_console(&mut cmd);
    path_with_parent(&mut cmd, exe);

    let mut child = cmd.spawn()?;
    let stdin = child.stdin.take().expect("stdin was piped");
    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr_pipe = child.stderr.take().expect("stderr was piped");

    let stderr = Arc::new(Mutex::new(String::new()));
    let tail = stderr.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr_pipe).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let mut text = tail.lock().unwrap();
            text.push_str(&line);
            text.push('\n');
            let excess = text.len().saturating_sub(STDERR_TAIL);
            if excess > 0 {
                let cut = text.ceil_char_boundary(excess);
                text.drain(..cut);
            }
        }
    });

    Ok(Agent { child, stdin, lines: BufReader::new(stdout).lines(), stderr })
}

impl Agent {
    pub async fn write_line(&mut self, line: &str) -> std::io::Result<()> {
        self.stdin.write_all(line.as_bytes()).await?;
        self.stdin.write_all(b"\n").await?;
        self.stdin.flush().await
    }

    /// The last thing the agent said on stderr, for a failure message.
    pub fn stderr_tail(&self) -> String {
        let text = self.stderr.lock().unwrap();
        text.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").chars().take(300).collect()
    }

    pub async fn exit_code(&mut self) -> Option<i32> {
        self.child.wait().await.ok()?.code()
    }

    /// Ends the agent and everything it started. On Windows killing the direct
    /// child would leave a shim's node process, or a running build, behind.
    pub async fn kill_tree(&mut self) {
        if let Some(pid) = self.child.id() {
            #[cfg(windows)]
            {
                let mut cmd = Command::new("taskkill");
                cmd.args(["/PID", &pid.to_string(), "/T", "/F"]).stdout(Stdio::null()).stderr(Stdio::null());
                hide_console(&mut cmd);
                let _ = cmd.status().await;
            }
            #[cfg(not(windows))]
            let _ = pid;
        }
        let _ = self.child.kill().await;
    }
}
