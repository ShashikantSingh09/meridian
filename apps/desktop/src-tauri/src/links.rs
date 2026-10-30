//! Providers reached over MCP: the app's end of `crates/mcp`. What each service
//! returned is held by the interface and never written to disk. Tokens go to
//! Windows Credential Manager, and only a record that a link exists goes in a file.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use keyring::Entry;
use mcp::{Access, Client, Digest, Link};
use serde::Serialize;
use tauri::{Manager, State};

use crate::commands::Core;
use crate::life::{open_in_browser, Keychain, SERVICE};

const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);

fn stringify(err: impl std::fmt::Display) -> String {
    err.to_string()
}

fn token_account(id: &str) -> String {
    format!("mcp/{id}")
}

/// Some registrations come with a secret, which is kept with the other credentials.
fn secret_entry(id: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, &format!("mcp-client/{id}")).map_err(stringify)
}

fn load_secret(id: &str) -> Option<String> {
    secret_entry(id).ok()?.get_password().ok()
}

pub struct Links {
    path: PathBuf,
    links: Mutex<HashMap<String, Link>>,
}

impl Links {
    fn save(&self) -> Result<(), String> {
        let links = self.links.lock().unwrap();
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(stringify)?;
        }
        let temporary = self.path.with_extension("json.tmp");
        std::fs::write(&temporary, serde_json::to_vec_pretty(&*links).map_err(stringify)?).map_err(stringify)?;
        std::fs::rename(temporary, &self.path).map_err(stringify)
    }

    fn insert(&self, id: &str, link: Link) -> Result<(), String> {
        self.links.lock().unwrap().insert(id.to_string(), link);
        self.save()
    }
}

/// A broken file loses the list of links, not the app, and each can be reconnected.
pub fn state(app: &tauri::App) -> Result<Links, Box<dyn std::error::Error>> {
    let path = app.path().app_config_dir()?.join("integrations.json");
    let links = std::fs::read(&path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
    Ok(Links { path, links: Mutex::new(links) })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationInfo {
    id: &'static str,
    name: &'static str,
    group: &'static str,
    blurb: &'static str,
    access: Access,
    connected: bool,
    account: Option<String>,
}

#[tauri::command]
pub fn integrations_list(links: State<'_, Links>) -> Vec<IntegrationInfo> {
    let linked = links.links.lock().unwrap();
    mcp::catalog()
        .iter()
        .map(|s| IntegrationInfo {
            id: s.id,
            name: s.name,
            group: s.group,
            blurb: s.blurb,
            access: s.access,
            connected: linked.contains_key(s.id),
            account: None,
        })
        .collect()
}

fn refuse_if_local(core: &Core) -> Result<(), String> {
    if core.settings.lock().unwrap().local_only {
        return Err("Local-only mode is on, so cloud services are not contacted.".into());
    }
    Ok(())
}

/// A pasted token, or a sign-in in the user's own browser. The app never sees a password.
#[tauri::command]
pub async fn integration_connect(
    core: State<'_, Core>,
    links: State<'_, Links>,
    id: String,
    client_id: Option<String>,
    secret: Option<String>,
    token: Option<String>,
) -> Result<(), String> {
    refuse_if_local(&core)?;
    let service = mcp::find(&id).ok_or("That service is not known.")?;
    let store = Keychain;
    let account = token_account(&id);
    if let Some(token) = token.filter(|t| !t.is_empty()) {
        let link = mcp::use_token(service, token, &store, &account).await.map_err(stringify)?;
        return links.insert(&id, link);
    }
    let client = client_id.filter(|c| !c.is_empty()).map(|id| Client { id, secret: secret.filter(|s| !s.is_empty()) });
    let signed_in = mcp::sign_in(service, client, &store, &account, open_in_browser, SIGN_IN_TIMEOUT).await.map_err(stringify)?;
    if let Some(secret) = signed_in.client_secret {
        secret_entry(&id)?.set_password(&secret).map_err(stringify)?;
    }
    links.insert(&id, signed_in.link)
}

#[tauri::command]
pub fn integration_disconnect(links: State<'_, Links>, id: String) -> Result<(), String> {
    use activity::TokenStore;
    Keychain.delete(&token_account(&id)).map_err(stringify)?;
    if let Ok(entry) = secret_entry(&id) {
        let _ = entry.delete_credential();
    }
    links.links.lock().unwrap().remove(&id);
    links.save()
}

/// Runs one read-only tool. `crates/mcp` refuses any other kind, whatever is asked for here.
#[tauri::command]
pub async fn integration_fetch(core: State<'_, Core>, links: State<'_, Links>, id: String, tool: Option<String>) -> Result<Digest, String> {
    refuse_if_local(&core)?;
    let link = links.links.lock().unwrap().get(&id).cloned().ok_or("That service is not connected.")?;
    mcp::digest(&link, load_secret(&id), &Keychain, &token_account(&id), tool.as_deref()).await.map_err(stringify)
}
