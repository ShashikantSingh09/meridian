//! API keys live in Windows Credential Manager. No command returns a key to the
//! webview: it can set one, clear one and ask whether one exists.

use keyring::Entry;

const SERVICE: &str = "dev.meridian.companion";

fn entry(provider: &str) -> Result<Entry, String> {
    if ai_core::find(provider).is_none() {
        return Err(format!("Unknown provider {provider}"));
    }
    Entry::new(SERVICE, provider).map_err(|e| e.to_string())
}

pub fn get(provider: &str) -> Option<String> {
    entry(provider).ok()?.get_password().ok().filter(|k| !k.is_empty())
}

pub fn set(provider: &str, key: &str) -> Result<(), String> {
    entry(provider)?.set_password(key).map_err(|e| e.to_string())
}

pub fn clear(provider: &str) -> Result<(), String> {
    match entry(provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_anything_outside_the_catalog() {
        assert!(set("not-a-provider", "x").is_err());
        assert!(get("not-a-provider").is_none());
    }
}
