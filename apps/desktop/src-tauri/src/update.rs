//! Updating from inside the app. Releases are read from GitHub: straight from its public pages while
//! the repository is public, and through the GitHub command line the owner signed in to if it is ever
//! private again. No token is read or kept here. Nothing is installed without a click, only the release
//! the user was shown is installed, and an installer must match the checksums published beside it
//! before it is written to disk.

use std::ffi::OsString;
use std::io::{Read, Write};
use std::os::windows::ffi::OsStringExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::commands::Core;
use crate::links::refuse_if_local;

const REPO: &str = "ShashikantSingh09/meridian";
const NO_WINDOW: u32 = 0x0800_0000;
const NOT_READY: &str = "Updating needs the GitHub command line, signed in. Run gh auth login once, then try again.";
const OFFLINE: &str = "Could not reach GitHub. Check the connection and try again.";
const UNREADABLE: &str = "GitHub sent something this version cannot read.";
const CHECKSUMS: &str = "SHA256SUMS.txt";
/// The release on GitHub is no longer the one the user was shown.
const MOVED: &str = "A newer version appeared. Check again.";
/// This copy was not installed, so it has no installer to update it. The page opens the release instead.
const PORTABLE: &str = "portable";
const NO_INSTALLER: &str = "The release has no installer, so nothing was installed.";
const NO_SUMS: &str = "The release has no checksums, so it was not installed.";
const NO_CHECKSUM: &str = "The release has no checksum for its installer, so it was not installed.";
const MISMATCH: &str = "The download does not match its checksum, so it was not installed.";
const TOO_BIG: &str = "The download is larger than an installer can be, so it was not installed.";
const MAX_INSTALLER: usize = 200 * 1024 * 1024;
const MAX_SUMS: usize = 64 * 1024;
/// Downloads left by an update that failed or already ran.
const KEEP_FOR: Duration = Duration::from_secs(24 * 60 * 60);
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
    /// The release notes, for What's new.
    notes: String,
    published: Option<String>,
    pub(crate) message: String,
}

/// How this copy got onto the PC, which decides what can update it.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum InstallKind {
    /// The per-user setup exe: `%LOCALAPPDATA%\Meridian`, with its `uninstall.exe`.
    Setup,
    /// The MSI, under Program Files.
    Msi,
    /// Anything else, such as the portable exe. It updates by hand.
    Portable,
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

/// Only the release the user saw is installed, never one published while they read it.
fn still_latest(seen: &str, latest: &str) -> Result<(), String> {
    if seen == latest { Ok(()) } else { Err(MOVED.to_string()) }
}

/// Windows paths ignore case. An empty root holds nothing, so an unset variable matches no path.
fn under(path: &Path, root: &Path) -> bool {
    let lower = |path: &Path| PathBuf::from(path.to_string_lossy().to_lowercase());
    !root.as_os_str().is_empty() && lower(path).starts_with(lower(root))
}

/// The NSIS template installs a per-user copy to `$LOCALAPPDATA\${PRODUCTNAME}` and writes
/// `$INSTDIR\uninstall.exe` beside it. The WiX template installs under Program Files.
pub fn install_kind(exe: &Path, local_app_data: &Path, program_files: &[PathBuf]) -> InstallKind {
    let beside_uninstaller = exe.parent().is_some_and(|dir| dir.join("uninstall.exe").is_file());
    if under(exe, local_app_data) && beside_uninstaller {
        InstallKind::Setup
    } else if program_files.iter().any(|root| under(exe, root)) {
        InstallKind::Msi
    } else {
        InstallKind::Portable
    }
}

fn kind_of(app: &AppHandle) -> InstallKind {
    let (Ok(exe), Ok(local)) = (std::env::current_exe(), app.path().local_data_dir()) else {
        return InstallKind::Portable;
    };
    let program_files: Vec<PathBuf> = ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"].iter().filter_map(|name| std::env::var_os(name)).map(PathBuf::from).collect();
    install_kind(&exe, &local, &program_files)
}

/// The release's file for this kind of install, by the names the release workflow gives them.
fn asset_name(tag: &str, kind: InstallKind) -> String {
    let version = tag.trim_start_matches('v');
    match kind {
        InstallKind::Msi => format!("Meridian-{version}.msi"),
        _ => format!("Meridian-{version}-setup.exe"),
    }
}

/// The checksum published for a file, from a `SHA256SUMS.txt`.
fn checksum_of(sums: &str, file: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let (hash, name) = line.trim().split_once(char::is_whitespace)?;
        (name.trim() == file).then(|| hash.to_ascii_lowercase())
    })
}

/// The bytes in hand are the bytes checked, so nothing can swap the file between check and run.
fn verify(bytes: &[u8], sums: &str, file: &str) -> Result<(), String> {
    let expected = checksum_of(sums, file).ok_or(NO_CHECKSUM)?;
    if format!("{:x}", Sha256::digest(bytes)) != expected {
        return Err(MISMATCH.to_string());
    }
    Ok(())
}

/// Adds a piece of a download, refusing one that grows past the cap before it is all in memory.
fn append(into: &mut Vec<u8>, chunk: &[u8], cap: usize) -> Result<(), String> {
    if into.len() + chunk.len() > cap {
        return Err(TOO_BIG.to_string());
    }
    into.extend_from_slice(chunk);
    Ok(())
}

/// A file `gh` downloaded, read no further than the cap.
fn read_capped(path: &Path, cap: usize, missing: &str) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    std::fs::File::open(path).and_then(|file| file.take(cap as u64 + 1).read_to_end(&mut bytes)).map_err(|_| missing.to_string())?;
    if bytes.len() > cap {
        return Err(TOO_BIG.to_string());
    }
    Ok(bytes)
}

/// A new folder of this download's own, under the app's per-user data. `create_dir` fails if the
/// name is already there, so nothing left in place beforehand is ever reused.
fn fresh_folder(root: &Path, name: &str) -> Result<PathBuf, String> {
    std::fs::create_dir_all(root).map_err(|err| err.to_string())?;
    for entry in std::fs::read_dir(root).map_err(|err| err.to_string())?.flatten() {
        let stale = entry.metadata().and_then(|meta| meta.modified()).ok().and_then(|at| at.elapsed().ok()).is_some_and(|age| age > KEEP_FOR);
        if stale {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
    let folder = root.join(name);
    std::fs::create_dir(&folder).map_err(|err| err.to_string())?;
    Ok(folder)
}

/// Windows' own System32, from Windows itself rather than from a name looked up on the PATH.
fn system_dir() -> Result<PathBuf, String> {
    let mut buffer = [0u16; 260];
    // SAFETY: the buffer is valid for its whole length, which the binding passes alongside it.
    let length = unsafe { windows::Win32::System::SystemInformation::GetSystemDirectoryW(Some(&mut buffer)) } as usize;
    if length == 0 || length >= buffer.len() {
        return Err("Could not find the Windows system folder.".to_string());
    }
    Ok(PathBuf::from(OsString::from_wide(&buffer[..length])))
}

/// What runs once the app has quit: a pause so it is gone, then the installer, which starts the new
/// version itself. `/S` is silent, `/UPDATE` installs over the old copy and keeps its shortcuts, and
/// `/R` runs `$INSTDIR\meridian.exe` when it succeeds. The MSI's `AUTOLAUNCHAPP` does the same.
fn script(kind: InstallKind, installer: &Path, system: &Path) -> String {
    let run = match kind {
        InstallKind::Msi => format!("\"{}\" /i \"{}\" /passive /promptrestart AUTOLAUNCHAPP=True", system.join("msiexec.exe").display(), installer.display()),
        _ => format!("\"{}\" /S /UPDATE /R", installer.display()),
    };
    format!("\"{}\" -n 3 127.0.0.1 >nul & {run}", system.join("PING.EXE").display())
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
        .https_only(true)
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

#[tauri::command]
pub async fn update_check(app: AppHandle) -> UpdateStatus {
    let current = app.package_info().version.to_string();
    let allowed = refuse_if_local(&app.state::<Core>());
    let found = match allowed {
        Ok(()) => latest().await,
        Err(why) => Err(why),
    };
    match found {
        Err(message) => UpdateStatus { current, latest: None, available: false, notes: String::new(), published: None, message },
        Ok((release, _)) => {
            let available = newer(&release.tag_name, &current);
            let message = if available { format!("Version {} is ready to install.", release.tag_name.trim_start_matches('v')) } else { "You are on the latest version.".into() };
            UpdateStatus { current, latest: Some(release.tag_name), available, notes: release.body.unwrap_or_default(), published: Some(release.published_at), message }
        }
    }
}

/// How this copy was installed, so the page can open the release instead for a portable one.
#[tauri::command]
pub fn update_kind(app: AppHandle) -> InstallKind {
    kind_of(&app)
}

async fn download(client: &reqwest::Client, url: &str, cap: usize) -> Result<Vec<u8>, String> {
    let mut response = client.get(url).send().await.and_then(reqwest::Response::error_for_status).map_err(|_| OFFLINE.to_string())?;
    if response.content_length().is_some_and(|length| length > cap as u64) {
        return Err(TOO_BIG.to_string());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| OFFLINE.to_string())? {
        append(&mut bytes, &chunk, cap)?;
    }
    Ok(bytes)
}

/// The installer and the checksums, both in memory.
async fn gather(release: &Published, source: Source, name: &str, folder: &Path) -> Result<(Vec<u8>, Vec<u8>), String> {
    match source {
        Source::Web => {
            let client = web()?;
            let installer = link_of(&release.assets, name).ok_or(NO_INSTALLER)?;
            let sums = link_of(&release.assets, CHECKSUMS).ok_or(NO_SUMS)?;
            Ok((download(&client, installer, MAX_INSTALLER).await?, download(&client, sums, MAX_SUMS).await?))
        }
        Source::Gh => {
            // gh only writes to disk, so it gets a folder of its own, which is read back and removed.
            let staging = folder.join("gh");
            let (tag, pattern, target) = (release.tag_name.clone(), name.to_string(), staging.to_string_lossy().into_owned());
            tauri::async_runtime::spawn_blocking(move || gh(&["release", "download", &tag, "--repo", REPO, "--pattern", &pattern, "--pattern", CHECKSUMS, "--dir", &target]))
                .await
                .map_err(|e| e.to_string())??;
            let read = (read_capped(&staging.join(name), MAX_INSTALLER, NO_INSTALLER), read_capped(&staging.join(CHECKSUMS), MAX_SUMS, NO_SUMS));
            let _ = std::fs::remove_dir_all(&staging);
            Ok((read.0?, read.1?))
        }
    }
}

async fn fetch(release: &Published, source: Source, kind: InstallKind, root: &Path) -> Result<PathBuf, String> {
    let name = asset_name(&release.tag_name, kind);
    let folder = fresh_folder(root, &uuid::Uuid::new_v4().to_string())?;
    let saved = async {
        let (installer, sums) = gather(release, source, &name, &folder).await?;
        verify(&installer, &String::from_utf8_lossy(&sums), &name)?;
        let path = folder.join(&name);
        std::fs::File::create_new(&path).and_then(|mut file| file.write_all(&installer)).map_err(|err| err.to_string())?;
        Ok::<_, String>(path)
    }
    .await;
    if saved.is_err() {
        let _ = std::fs::remove_dir_all(&folder);
    }
    saved
}

/// Where a release's file can be downloaded, by its exact name.
fn link_of<'a>(assets: &'a [Asset], name: &str) -> Option<&'a str> {
    assets.iter().find(|asset| asset.name == name).map(|asset| asset.browser_download_url.as_str())
}

/// Only ever from a click, with the tag the page showed. Installing restarts the app, which would
/// end a running agent.
#[tauri::command]
pub async fn update_install(app: AppHandle, tag: String) -> Result<(), String> {
    // The panel can close and reopen during a download, and a second run would delete the first's.
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err("An update is already being installed.".to_string());
    }
    let outcome = install(&app, &tag).await;
    if outcome.is_err() {
        INSTALLING.store(false, Ordering::SeqCst);
    }
    outcome
}

async fn install(app: &AppHandle, seen: &str) -> Result<(), String> {
    refuse_if_local(&app.state::<Core>())?;
    let kind = kind_of(app);
    if kind == InstallKind::Portable {
        return Err(PORTABLE.to_string());
    }
    let current = app.package_info().version.to_string();
    let (release, source) = latest().await?;
    still_latest(seen, &release.tag_name)?;
    if !newer(&release.tag_name, &current) {
        return Err("You are already on the latest version.".to_string());
    }
    let root = app.path().app_local_data_dir().map_err(|err| err.to_string())?.join("updates");
    let installer = fetch(&release, source, kind, &root).await?;

    // The app has to be gone before the installer can replace it, so a small script outlives it.
    let system = system_dir()?;
    let script = script(kind, &installer, &system);
    // Not detached: ping would then open a console window of its own.
    Command::new(system.join("cmd.exe"))
        .arg("/c")
        .raw_arg(format!("\"{script}\""))
        .current_dir(&system)
        .creation_flags(NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    crate::quit(app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A folder of the test's own under the temp folder, removed by the test.
    fn scratch() -> PathBuf {
        std::env::temp_dir().join(format!("meridian-update-test-{}", uuid::Uuid::new_v4()))
    }

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
    fn only_the_release_that_was_shown_installs() {
        assert!(still_latest("v0.5.2", "v0.5.2").is_ok());
        assert_eq!(still_latest("v0.5.2", "v0.5.3").unwrap_err(), MOVED);
        assert_eq!(still_latest("", "v0.5.3").unwrap_err(), MOVED);
    }

    #[test]
    fn a_checksum_is_found_by_exact_name() {
        let sums = "ABC123  Meridian-0.4.0-setup.exe\ndef456  Meridian-0.4.0.msi\n";
        assert_eq!(checksum_of(sums, "Meridian-0.4.0-setup.exe").as_deref(), Some("abc123"));
        assert_eq!(checksum_of(sums, "Meridian-0.4.0.msi").as_deref(), Some("def456"));
        assert_eq!(checksum_of(sums, "setup.exe"), None);
    }

    #[test]
    fn the_bytes_in_memory_are_checked() {
        // SHA-256 of "abc", from FIPS 180-2.
        let abc = "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD";
        let sums = format!("{abc}  Meridian-0.6.0-setup.exe\n");
        assert_eq!(verify(b"abc", &sums, "Meridian-0.6.0-setup.exe"), Ok(()));
        assert_eq!(verify(b"abd", &sums, "Meridian-0.6.0-setup.exe").unwrap_err(), MISMATCH);
        assert_eq!(verify(b"abc", &sums, "Meridian-0.6.0.msi").unwrap_err(), NO_CHECKSUM);
        assert_eq!(verify(b"abc", "", "Meridian-0.6.0-setup.exe").unwrap_err(), NO_CHECKSUM);
    }

    #[test]
    fn a_download_past_the_cap_is_refused() {
        let mut bytes = Vec::new();
        assert!(append(&mut bytes, b"12345", 8).is_ok());
        assert!(append(&mut bytes, b"678", 8).is_ok(), "exactly the cap fits");
        assert_eq!(append(&mut bytes, b"9", 8).unwrap_err(), TOO_BIG);
        assert_eq!(bytes, b"12345678");
        assert_eq!(MAX_INSTALLER, 200 * 1024 * 1024);

        let root = scratch();
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("setup.exe");
        std::fs::write(&file, b"123456789").unwrap();
        assert_eq!(read_capped(&file, 9, NO_INSTALLER).unwrap(), b"123456789");
        assert_eq!(read_capped(&file, 8, NO_INSTALLER).unwrap_err(), TOO_BIG);
        assert_eq!(read_capped(&root.join("missing.exe"), 8, NO_INSTALLER).unwrap_err(), NO_INSTALLER);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_download_folder_is_never_reused() {
        let root = scratch();
        let folder = fresh_folder(&root, "one").unwrap();
        assert!(folder.is_dir());
        assert!(fresh_folder(&root, "one").is_err(), "the folder was already there");
        assert!(fresh_folder(&root, "two").is_ok());
        assert!(folder.is_dir(), "a folder from today is kept");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_install_kind_follows_where_the_app_runs() {
        let root = scratch();
        let local = root.join("AppData").join("Local");
        let installed = local.join("Meridian");
        std::fs::create_dir_all(&installed).unwrap();
        let program_files = vec![PathBuf::from(r"C:\Program Files"), PathBuf::from(r"C:\Program Files (x86)"), PathBuf::new()];

        // Before the uninstaller is there, a copy in local data is just a copy.
        assert_eq!(install_kind(&installed.join("meridian.exe"), &local, &program_files), InstallKind::Portable);
        std::fs::write(installed.join("uninstall.exe"), b"").unwrap();
        assert_eq!(install_kind(&installed.join("meridian.exe"), &local, &program_files), InstallKind::Setup);
        let shouted = PathBuf::from(installed.to_string_lossy().to_uppercase()).join("MERIDIAN.EXE");
        assert_eq!(install_kind(&shouted, &local, &program_files), InstallKind::Setup, "case is ignored");

        assert_eq!(install_kind(Path::new(r"C:\Program Files\Meridian\meridian.exe"), &local, &program_files), InstallKind::Msi);
        assert_eq!(install_kind(Path::new(r"c:\program files\Meridian\meridian.exe"), &local, &program_files), InstallKind::Msi);
        assert_eq!(install_kind(Path::new(r"D:\Tools\Meridian-0.5.1-portable.exe"), &local, &program_files), InstallKind::Portable);
        assert_eq!(install_kind(Path::new(r"C:\Program Files Extra\meridian.exe"), &local, &program_files), InstallKind::Portable, "whole folder names only");
        assert_eq!(serde_json::to_string(&InstallKind::Portable).unwrap(), "\"portable\"");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_installer_runs_from_windows_folders_and_starts_the_new_version() {
        let system = Path::new(r"C:\Windows\system32");
        let setup = script(InstallKind::Setup, Path::new(r"C:\Users\u\AppData\Local\dev.meridian.companion\updates\x\Meridian-0.6.0-setup.exe"), system);
        assert!(setup.starts_with(r#""C:\Windows\system32\PING.EXE" -n 3 127.0.0.1 >nul & "#), "{setup}");
        assert!(setup.ends_with(r#"\Meridian-0.6.0-setup.exe" /S /UPDATE /R"#), "{setup}");
        let msi = script(InstallKind::Msi, Path::new(r"C:\u\Meridian-0.6.0.msi"), system);
        assert!(msi.contains(r#""C:\Windows\system32\msiexec.exe" /i "C:\u\Meridian-0.6.0.msi" /passive"#), "{msi}");
        assert!(msi.ends_with("AUTOLAUNCHAPP=True"), "{msi}");
        assert_eq!(asset_name("v0.6.0", InstallKind::Setup), "Meridian-0.6.0-setup.exe");
        assert_eq!(asset_name("v0.6.0", InstallKind::Msi), "Meridian-0.6.0.msi");
        assert!(system_dir().unwrap().join("cmd.exe").is_file());
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
        let installer = asset_name(&release.tag_name, InstallKind::Setup);
        assert!(link_of(&release.assets, &installer).is_some(), "{installer}");
        assert!(link_of(&release.assets, CHECKSUMS).is_some());
    }

    /// Downloads the real installer the public way and checks it. Nothing is run.
    #[tokio::test]
    #[ignore = "downloads the installer from GitHub"]
    async fn the_published_installer_downloads_and_matches_its_checksum() {
        let release = from_web().await.ok().expect("a public release");
        let root = scratch();
        let path = fetch(&release, Source::Web, InstallKind::Setup, &root).await.unwrap();
        assert!(std::fs::metadata(&path).unwrap().len() > 1_000_000);
        let _ = std::fs::remove_dir_all(&root);
    }
}
