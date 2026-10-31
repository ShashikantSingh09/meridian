//! What runs speech on this PC. None of it ships with the app: the engine and each model download
//! only when asked for, from the engine's own releases, and must match a checksum pinned here.
//! A release changing under us therefore fails loudly instead of running something unseen.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::VoiceError;

const RELEASES: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download";

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pack {
    pub id: &'static str,
    pub name: &'static str,
    pub bytes: u64,
    #[serde(skip)]
    pub path: &'static str,
    #[serde(skip)]
    pub sha256: &'static str,
}

include!("pack_list.rs");

pub fn find(id: &str) -> Option<&'static Pack> {
    PACKS.iter().find(|pack| pack.id == id)
}

/// The folder a pack lives in. It exists only once the pack is complete and verified.
pub fn folder(root: &Path, pack: &Pack) -> PathBuf {
    root.join(pack.id)
}

/// The folder its archive unpacks to, named after the archive and so after its version.
fn build(pack: &Pack) -> &str {
    pack.path.rsplit('/').next().unwrap_or_default().trim_end_matches(".tar.bz2")
}

/// Whether the build pinned here is on this PC. An earlier version's does not count: the structs
/// in `local.rs` fit only the pinned engine.
pub fn installed(root: &Path, pack: &Pack) -> bool {
    folder(root, pack).join(build(pack)).is_dir()
}

/// Takes away what an earlier version of a pack left behind.
pub fn clear_old(root: &Path) {
    for pack in &PACKS {
        if folder(root, pack).is_dir() && !installed(root, pack) {
            let _ = remove(root, pack);
        }
    }
}

/// Fetches, verifies and unpacks a pack. `progress` is told how many bytes have arrived.
pub async fn download(root: &Path, pack: &Pack, mut progress: impl FnMut(u64)) -> Result<(), VoiceError> {
    if installed(root, pack) {
        return Ok(());
    }
    fs::create_dir_all(root)?;
    let archive = root.join(format!("{}.download", pack.id));
    let response = reqwest::get(format!("{RELEASES}/{}", pack.path)).await?.error_for_status()?;
    let mut body = response.bytes_stream();
    let mut file = tokio::fs::File::create(&archive).await?;
    let mut hash = Sha256::new();
    let mut received = 0;
    while let Some(part) = body.next().await {
        let part = part?;
        hash.update(&part);
        file.write_all(&part).await?;
        received += part.len() as u64;
        progress(received);
    }
    file.flush().await?;
    drop(file);

    let actual: String = hash.finalize().iter().map(|byte| format!("{byte:02x}")).collect();
    if actual != pack.sha256 {
        let _ = fs::remove_file(&archive);
        return Err(VoiceError::Engine(format!("{} did not match its checksum, so it was thrown away.", pack.name)));
    }
    let result = unpack(root, pack, &archive).await;
    let _ = fs::remove_file(&archive);
    result
}

async fn unpack(root: &Path, pack: &Pack, archive: &Path) -> Result<(), VoiceError> {
    let (root, archive, target) = (root.to_path_buf(), archive.to_path_buf(), folder(root, pack));
    tokio::task::spawn_blocking(move || {
        // Unpacked to one side first, so a half-finished pack never looks installed.
        let working = root.join(format!("{}.unpacking", target.file_name().unwrap_or_default().to_string_lossy()));
        let _ = fs::remove_dir_all(&working);
        fs::create_dir_all(&working)?;
        // Windows has shipped tar since 2018, and it reads this format.
        let done = Command::new("tar").arg("-xjf").arg(&archive).arg("-C").arg(&working).status()?;
        if !done.success() {
            let _ = fs::remove_dir_all(&working);
            return Err(VoiceError::Engine("The download could not be unpacked.".into()));
        }
        // An earlier version may still be here, if it could not be cleared at startup.
        let _ = fs::remove_dir_all(&target);
        fs::rename(&working, &target)?;
        Ok(())
    })
    .await
    .map_err(|err| VoiceError::Engine(err.to_string()))?
}

/// Takes a pack back off the PC.
pub fn remove(root: &Path, pack: &Pack) -> Result<(), VoiceError> {
    match fs::remove_dir_all(folder(root, pack)) {
        Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(err.into()),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_pack_is_pinned() {
        for pack in PACKS {
            assert_eq!(pack.sha256.len(), 64, "{}", pack.id);
            assert!(pack.sha256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()), "{}", pack.id);
            assert!(pack.bytes > 0);
            assert!(pack.path.ends_with(".tar.bz2"), "{}", pack.id);
        }
        assert!(find("engine").is_some());
        assert!(find("nothing").is_none());
    }

    #[test]
    fn an_old_engine_does_not_count_and_is_cleared() {
        let root = std::env::temp_dir().join(format!("meridian-packs-{}", std::process::id()));
        let (engine, hearing) = (find("engine").unwrap(), find("hearing").unwrap());
        fs::create_dir_all(folder(&root, engine).join("sherpa-onnx-v2.0.1-win-x64-shared-MT-Release-lib")).unwrap();
        fs::create_dir_all(folder(&root, hearing).join(build(hearing))).unwrap();
        assert!(!installed(&root, engine));
        assert!(installed(&root, hearing));

        clear_old(&root);
        assert!(!folder(&root, engine).exists());
        assert!(installed(&root, hearing), "a pack that still fits stays");

        fs::create_dir_all(folder(&root, engine).join(build(engine))).unwrap();
        assert!(installed(&root, engine));
        let _ = fs::remove_dir_all(&root);
    }
}
