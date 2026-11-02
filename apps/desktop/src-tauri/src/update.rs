//! Updating from inside the app. Releases are read from GitHub: straight from its public pages while
//! the repository is public, and through the GitHub command line the owner signed in to if it is ever
//! private again. No token is read or kept here. Nothing is installed without a click, and an
//! installer must match the checksums published beside it.

use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

const REPO: &str = "ShashikantSingh09/meridian";
const NO_WINDOW: u32 = 0x0800_0000;
const NOT_READY: &str = "Updating needs the GitHub command line, signed in. Run gh auth login once, then try again.";
const OFFLINE: &str = "Could not reach GitHub. Check the connection and try again.";
const UNREADABLE: &str = "GitHub sent something this version cannot read.";
const CHECKSUMS: &str = "SHA256SUMS.txt";
/// Set from a click until the install fails or the app exits.
static INSTALLING: AtomicBool = AtomicBool::new(false);

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}

#[derive(Deserialize)]
struct Published {
    tag_name: String,
    /// GitHub sends null for a release with no notes.
    body: Option<String>,
    published_at: String,
    #[serde(default)]
    assets: Vec<Asset>,
}

/// Where a release was read from, which is where its files come from too.
enum Source {
    Web,
    Gh,
}

/// Why the public pages had no release.
enum Unseen {
    /// The repository is private, so only a signed-in command line can see it.
    Hidden,
    Failed(String),
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

/// Where a release's file can be downloaded, by its exact name.
fn link_of<'a>(assets: &'a [Asset], name: &str) -> Option<&'a str> {
    assets.iter().find(|asset| asset.name == name).map(|asset| asset.browser_download_url.as_str())
}

fn gh(args: &[&str]) -> Result<Output, String> {
    let output = Command::new("gh").args(args).creation_flags(NO_WINDOW).stdin(Stdio::null()).output().map_err(|_| NOT_READY.to_string())?;
    if output.status.success() {
        return Ok(output);
    }
    let said = String::from_utf8_lossy(&output.stderr);
    Err(if said.contains("gh auth login") || said.contains("HTTP 401") || said.contains("Not Found") { NOT_READY.to_string() } else { said.trim().to_string() })
}

fn web() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("Meridian/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|err| err.to_string())
}

async fn from_web() -> Result<Published, Unseen> {
    let response = web()
        .map_err(Unseen::Failed)?
        .get(format!("https://api.github.com/repos/{REPO}/releases/latest"))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|_| Unseen::Failed(OFFLINE.to_string()))?;
    match response.status().as_u16() {
        200 => response.json().await.map_err(|_| Unseen::Failed(UNREADABLE.to_string())),
        404 => Err(Unseen::Hidden),
        403 | 429 => Err(Unseen::Failed("GitHub asked to wait. Try again in an hour.".to_string())),
        code => Err(Unseen::Failed(format!("GitHub could not answer just now ({code}). Try again later."))),
    }
}

fn from_gh() -> Result<Published, String> {
    let output = gh(&["api", &format!("repos/{REPO}/releases/latest")])?;
    serde_json::from_slice(&output.stdout).map_err(|_| UNREADABLE.to_string())
}

/// The public pages first, so no PC needs anything signed in, and the command line if they say
/// there is nothing to see. A public repository that cannot be reached says why, not that `gh` is missing.
async fn latest() -> Result<(Published, Source), String> {
    let unseen = match from_web().await {
        Ok(release) => return Ok((release, Source::Web)),
        Err(unseen) => unseen,
    };
    match (tauri::async_runtime::spawn_blocking(from_gh).await.map_err(|err| err.to_string())?, unseen) {
        (Ok(release), _) => Ok((release, Source::Gh)),
        (Err(why), Unseen::Hidden) => Err(why),
        (Err(_), Unseen::Failed(why)) => Err(why),
    }
}

fn sha256_of(path: &Path) -> Result<String, String> {
    let output = Command::new("certutil").args(["-hashfile"]).arg(path).arg("SHA256").creation_flags(NO_WINDOW).output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines().map(str::trim).find(|line| line.len() == 64 && line.chars().all(|c| c.is_ascii_hexdigit())).map(str::to_ascii_lowercase).ok_or_else(|| "Could not check the download.".to_string())
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> UpdateStatus {
    let current = app.package_info().version.to_string();
    match latest().await {
        Err(message) => UpdateStatus { current, latest: None, available: false, notes: String::new(), published: None, message },
        Ok((release, _)) => {
            let available = newer(&release.tag_name, &current);
            let message = if available { format!("Version {} is ready to install.", release.tag_name.trim_start_matches('v')) } else { "You are on the latest version.".into() };
            UpdateStatus { current, latest: Some(release.tag_name), available, notes: release.body.unwrap_or_default(), published: Some(release.published_at), message }
        }
    }
}

async fn download(client: &reqwest::Client, url: &str, to: &Path) -> Result<(), String> {
    let response = client.get(url).send().await.and_then(reqwest::Response::error_for_status).map_err(|_| OFFLINE.to_string())?;
    let bytes = response.bytes().await.map_err(|_| OFFLINE.to_string())?;
    std::fs::write(to, &bytes).map_err(|err| err.to_string())
}

async fn fetch(release: &Published, source: Source) -> Result<PathBuf, String> {
    let folder = std::env::temp_dir().join("meridian-update");
    let _ = std::fs::remove_dir_all(&folder);
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let installer = format!("Meridian-{}-setup.exe", release.tag_name.trim_start_matches('v'));
    match source {
        Source::Web => {
            let client = web()?;
            let link = link_of(&release.assets, &installer).ok_or("The release has no installer, so nothing was installed.")?;
            download(&client, link, &folder.join(&installer)).await?;
            if let Some(link) = link_of(&release.assets, CHECKSUMS) {
                download(&client, link, &folder.join(CHECKSUMS)).await?;
            }
        }
        Source::Gh => {
            let (tag, pattern, target) = (release.tag_name.clone(), installer.clone(), folder.to_string_lossy().into_owned());
            tauri::async_runtime::spawn_blocking(move || gh(&["release", "download", &tag, "--repo", REPO, "--pattern", &pattern, "--pattern", CHECKSUMS, "--dir", &target]))
                .await
                .map_err(|e| e.to_string())??;
        }
    }
    let sums = std::fs::read_to_string(folder.join(CHECKSUMS)).map_err(|_| "The release has no checksums, so it was not installed.".to_string())?;
    let expected = checksum_of(&sums, &installer).ok_or("The release has no checksum for its installer, so it was not installed.")?;
    let path = folder.join(&installer);
    let checked = path.clone();
    let found = tauri::async_runtime::spawn_blocking(move || sha256_of(&checked)).await.map_err(|e| e.to_string())??;
    if found != expected {
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
    let (release, source) = latest().await?;
    if !newer(&release.tag_name, &current) {
        return Err("You are already on the latest version.".to_string());
    }
    let installer = fetch(&release, source).await?;

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

    /// The shape GitHub's public API sends, with the notes left empty as it can.
    #[test]
    fn a_public_release_is_read_with_its_download_links() {
        let sent = r#"{"tag_name":"v0.5.1","body":null,"published_at":"2026-11-02T12:00:00Z","draft":false,
            "assets":[{"name":"Meridian-0.5.1-setup.exe","browser_download_url":"https://github.com/o/r/releases/download/v0.5.1/Meridian-0.5.1-setup.exe","size":1},
                      {"name":"SHA256SUMS.txt","browser_download_url":"https://github.com/o/r/releases/download/v0.5.1/SHA256SUMS.txt","size":1}]}"#;
        let release: Published = serde_json::from_str(sent).unwrap();
        assert_eq!(release.body, None);
        assert!(link_of(&release.assets, "Meridian-0.5.1-setup.exe").unwrap().ends_with("/v0.5.1/Meridian-0.5.1-setup.exe"));
        assert!(link_of(&release.assets, CHECKSUMS).is_some());
        assert_eq!(link_of(&release.assets, "Meridian-0.5.1.msi"), None);
        // What `gh api` prints has no assets the app needs, and still reads.
        assert!(serde_json::from_str::<Published>(r#"{"tag_name":"v1.0.0","body":"Notes","published_at":"x"}"#).is_ok());
    }

    /// Reads the real public release, the way an installed copy with no `gh` would.
    #[tokio::test]
    #[ignore = "reaches GitHub"]
    async fn the_published_release_is_found_without_the_command_line() {
        let release = from_web().await.map_err(|unseen| match unseen {
            Unseen::Hidden => "the repository is private".to_string(),
            Unseen::Failed(why) => why,
        });
        let release = release.unwrap();
        let installer = format!("Meridian-{}-setup.exe", release.tag_name.trim_start_matches('v'));
        assert!(link_of(&release.assets, &installer).is_some(), "{installer}");
        assert!(link_of(&release.assets, CHECKSUMS).is_some());
    }

    /// Downloads the real installer the public way and checks it. Nothing is run.
    #[tokio::test]
    #[ignore = "downloads the installer from GitHub"]
    async fn the_published_installer_downloads_and_matches_its_checksum() {
        let release = from_web().await.ok().expect("a public release");
        let path = fetch(&release, Source::Web).await.unwrap();
        assert!(std::fs::metadata(&path).unwrap().len() > 1_000_000);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
