//! A crash leaves a note. The log stays on this PC, and is cleaned before it is
//! written, because a panic message can quote whatever the code was holding.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;

const FILE: &str = "meridian.log";
const HIDDEN: &str = "[hidden]";

/// Drops anything that looks like a credential, and the query of any URL.
fn redact(text: &str) -> String {
    let mut after_bearer = false;
    let words: Vec<String> = text
        .split(' ')
        .map(|word| {
            let lower = word.to_ascii_lowercase();
            let secret = after_bearer
                || word.starts_with("sk-")
                || word.starts_with("eyJ")
                || ["token=", "code=", "secret=", "key=", "password="].iter().any(|k| lower.contains(k));
            after_bearer = lower == "bearer";
            match word.split_once('?') {
                _ if secret => HIDDEN.to_string(),
                Some((path, _)) if word.starts_with("http") => format!("{path}?{HIDDEN}"),
                _ => word.to_string(),
            }
        })
        .collect();
    words.join(" ")
}

pub fn path(dir: PathBuf) -> PathBuf {
    dir.join(FILE)
}

/// Keeps the default hook too, which prints when run from a terminal.
pub fn on_panic(dir: PathBuf) {
    let print = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path(dir.clone())) {
            let _ = writeln!(file, "{} panic: {}", chrono::Local::now().to_rfc3339(), redact(&info.to_string()));
        }
        print(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_never_reach_the_log() {
        let cleaned = redact("failed with Bearer abc123 and sk-ant-xyz and eyJhbGci.x.y while token=9");
        for leak in ["abc123", "sk-ant", "eyJhbGci", "token=9"] {
            assert!(!cleaned.contains(leak), "{cleaned}");
        }
        assert!(cleaned.starts_with("failed with Bearer "));
    }

    #[test]
    fn a_url_keeps_its_path_and_loses_its_query() {
        assert_eq!(redact("GET https://x.dev/a?state=abc"), "GET https://x.dev/a?[hidden]");
    }

    #[test]
    fn ordinary_text_is_untouched() {
        assert_eq!(redact("index out of bounds at island.rs:12"), "index out of bounds at island.rs:12");
    }
}
