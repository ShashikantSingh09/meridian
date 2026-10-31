//! Updating from inside the app. The releases are in a private repository, so they are read with
//! the GitHub command line the owner has signed in to, the same as typing `gh` by hand. No token
//! is read or kept here. A PC without it signed in cannot update, and the app says so. Nothing is
//! installed without a click, and an installer must match the checksums published beside it.

use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

const REPO: &str = "ShashikantSingh09/meridian";
const NO_WINDOW: u32 = 0x0800_0000;
const NOT_READY: &str = "Updating needs the GitHub command line, signed in. Run gh auth login once, then try again.";
/// Set from a click until the install fails or the app exits.
static INSTALLING: AtomicBool = AtomicBool::new(false);

#[derive(Deserialize)]
struct Published {
    tag_name: String,
    body: String,
    published_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    current: String,
    latest: Option<String>,
    available: bool,
    notes: String,
    published: Option<String>,
    message: String,
}

fn parts(version: &str) -> Option<(u32, u32, u32)> {
    let mut numbers = version.strip_prefix('v').unwrap_or(version).split('.').map(str::parse);
    let found = (numbers.next()?.ok()?, numbers.next()?.ok()?, numbers.next()?.ok()?);
    numbers.next().is_none().then_some(found)
}

/// True only for a plain version that is really newer, so an odd tag is never installed.
fn newer(latest: &str, current: &str) -> bool {
    matches!((parts(latest), parts(current)), (Some(latest), Some(current)) if latest > current)
}

/// The checksum published for a file, from a `SHA256SUMS.txt`.
fn checksum_of(sums: &str, file: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let (hash, name) = line.trim().split_once(char::is_whitespace)?;
        (name.trim() == file).then(|| hash.to_ascii_lowercase())
    })
}

fn gh(args: &[&str]) -> Result<Output, String> {
    let output = Command::new("gh").args(args).creation_flags(NO_WINDOW).stdin(Stdio::null()).output().map_err(|_| NOT_READY.to_string())?;
    if output.status.success() {
        return Ok(output);
    }
    let said = String::from_utf8_lossy(&output.stderr);
    Err(if said.contains("gh auth login") || said.contains("HTTP 401") || said.contains("Not Found") { NOT_READY.to_string() } else { said.trim().to_string() })
}

fn latest() -> Result<Published, String> {
    let output = gh(&["api", &format!("repos/{REPO}/releases/latest")])?;
    serde_json::from_slice(&output.stdout).map_err(|_| "GitHub sent something this version cannot read.".to_string())
}

fn sha256_of(path: &Path) -> Result<String, String> {
    let output = Command::new("certutil").args(["-hashfile"]).arg(path).arg("SHA256").creation_flags(NO_WINDOW).output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines().map(str::trim).find(|line| line.len() == 64 && line.chars().all(|c| c.is_ascii_hexdigit())).map(str::to_ascii_lowercase).ok_or_else(|| "Could not check the download.".to_string())
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> UpdateStatus {
    let current = app.package_info().version.to_string();
    let found = tauri::async_runtime::spawn_blocking(latest).await.map_err(|e| e.to_string()).and_then(|r| r);
    match found {
        Err(message) => UpdateStatus { current, latest: None, available: false, notes: String::new(), published: None, message },
        Ok(release) => {
            let available = newer(&release.tag_name, &current);
            let message = if available { format!("Version {} is ready to install.", release.tag_name.trim_start_matches('v')) } else { "You are on the latest version.".into() };
            UpdateStatus { current, latest: Some(release.tag_name), available, notes: release.body, published: Some(release.published_at), message }
        }
    }
}

fn fetch(version: &str, tag: &str) -> Result<PathBuf, String> {
    let folder = std::env::temp_dir().join("meridian-update");
    let _ = std::fs::remove_dir_all(&folder);
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let installer = format!("Meridian-{version}-setup.exe");
    let target = folder.to_string_lossy().into_owned();
    gh(&["release", "download", tag, "--repo", REPO, "--pattern", &installer, "--pattern", "SHA256SUMS.txt", "--dir", &target])?;
    let sums = std::fs::read_to_string(folder.join("SHA256SUMS.txt")).map_err(|_| "The release has no checksums, so it was not installed.".to_string())?;
    let expected = checksum_of(&sums, &installer).ok_or("The release has no checksum for its installer, so it was not installed.")?;
    let path = folder.join(&installer);
    if sha256_of(&path)? != expected {
        return Err("The download does not match its checksum, so it was not installed.".into());
    }
    Ok(path)
}

/// Only ever from a click. Installing restarts the app, which would end a running agent.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    // The panel can close and reopen during a download, and a second run would delete the first's.
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err("An update is already being installed.".to_string());
    }
    let outcome = install(&app).await;
    if outcome.is_err() {
        INSTALLING.store(false, Ordering::SeqCst);
    }
    outcome
}

async fn install(app: &AppHandle) -> Result<(), String> {
    let current = app.package_info().version.to_string();
    let installer = tauri::async_runtime::spawn_blocking(move || {
        let release = latest()?;
        if !newer(&release.tag_name, &current) {
            return Err("You are already on the latest version.".to_string());
        }
        fetch(release.tag_name.trim_start_matches('v'), &release.tag_name)
    })
    .await
    .map_err(|e| e.to_string())??;

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    // The app has to be gone before the installer can replace it, so a small script outlives it.
    // A pause, the quiet install, then the new version starts where the old one was.
    let script = format!("ping -n 3 127.0.0.1 >nul & \"{}\" /S & start \"\" \"{}\"", installer.display(), exe.display());
    // Not detached: ping would then open a console window of its own.
    Command::new("cmd").arg("/c").raw_arg(format!("\"{script}\"")).creation_flags(NO_WINDOW).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
    crate::quit(app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_plain_newer_version_counts() {
        assert!(newer("v0.4.0", "0.3.0"));
        assert!(newer("v0.10.0", "0.9.9"), "numbers, not text");
        assert!(newer("1.0.0", "0.99.99"));
        assert!(!newer("v0.3.0", "0.3.0"));
        assert!(!newer("v0.2.9", "0.3.0"));
        for odd in ["latest", "v1.0", "v1.0.0-beta", "v1.0.0.1", ""] {
            assert!(!newer(odd, "0.1.0"), "{odd}");
        }
    }

    #[test]
    fn a_checksum_is_found_by_exact_name() {
        let sums = "ABC123  Meridian-0.4.0-setup.exe\ndef456  Meridian-0.4.0.msi\n";
        assert_eq!(checksum_of(sums, "Meridian-0.4.0-setup.exe").as_deref(), Some("abc123"));
        assert_eq!(checksum_of(sums, "Meridian-0.4.0.msi").as_deref(), Some("def456"));
        assert_eq!(checksum_of(sums, "setup.exe"), None);
    }
}
