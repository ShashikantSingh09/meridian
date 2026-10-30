//! Providers reached over MCP: the app's end of `crates/mcp`. What each service
//! returned is held by the interface and never written to disk. Tokens go to
//! Windows Credential Manager, and only a record that a link exists goes in a file.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use activity::{exchange_for_key, LoopbackFlow, OAuthConfig};
use keyring::Entry;
use mcp::{Access, Client, Digest, Link};
use serde::Serialize;
use tauri::{Manager, State};
use tokio::net::TcpListener;

use crate::commands::Core;
use crate::life::{open_in_browser, Keychain, SERVICE};
use crate::secrets;

const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);
const OPENROUTER_AUTHORIZE: &str = "https://openrouter.ai/auth";
const OPENROUTER_KEYS: &str = "https://openrouter.ai/api/v1/auth/keys";

/// Services that accept only registered apps. The publisher registers once, sets these
/// when building a release, and every customer then just clicks Connect.
fn built_in_client(id: &str) -> Option<Client> {
    let (client, secret) = match id {
        "github" => (option_env!("MERIDIAN_CLIENT_GITHUB"), option_env!("MERIDIAN_SECRET_GITHUB")),
        "slack" => (option_env!("MERIDIAN_CLIENT_SLACK"), option_env!("MERIDIAN_SECRET_SLACK")),
        "asana" => (option_env!("MERIDIAN_CLIENT_ASANA"), option_env!("MERIDIAN_SECRET_ASANA")),
        "hubspot" => (option_env!("MERIDIAN_CLIENT_HUBSPOT"), option_env!("MERIDIAN_SECRET_HUBSPOT")),
        "box" => (option_env!("MERIDIAN_CLIENT_BOX"), option_env!("MERIDIAN_SECRET_BOX")),
        "drive" => (option_env!("MERIDIAN_GOOGLE_CLIENT_ID"), option_env!("MERIDIAN_GOOGLE_CLIENT_SECRET")),
        _ => return None,
    };
    client.map(|id| Client { id: id.to_string(), secret: secret.map(str::to_string) })
}

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
    ready: bool,
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
            ready: matches!(s.access, Access::Open) || built_in_client(s.id).is_some(),
        })
        .collect()
}

fn refuse_if_local(core: &Core) -> Result<(), String> {
    if core.settings.lock().unwrap().local_only {
        return Err("Local-only mode is on, so cloud services are not contacted.".into());
    }
    Ok(())
}

/// One click: the service's own page opens in the browser. The app never sees a password.
#[tauri::command]
pub async fn integration_connect(core: State<'_, Core>, links: State<'_, Links>, id: String) -> Result<(), String> {
    refuse_if_local(&core)?;
    let service = mcp::find(&id).ok_or("That service is not known.")?;
    let signed_in = mcp::sign_in(service, built_in_client(&id), &Keychain, &token_account(&id), open_in_browser, SIGN_IN_TIMEOUT).await.map_err(stringify)?;
    if let Some(secret) = signed_in.client_secret {
        secret_entry(&id)?.set_password(&secret).map_err(stringify)?;
    }
    links.insert(&id, signed_in.link)
}

/// OpenRouter's browser sign-in. It needs no registration: the proof of who asked is the
/// PKCE challenge, and a key comes back to be stored like any other.
#[tauri::command]
pub async fn ai_sign_in(core: State<'_, Core>, id: String) -> Result<(), String> {
    refuse_if_local(&core)?;
    if id != "openrouter" {
        return Err("That provider has no browser sign-in.".into());
    }
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(stringify)?;
    let port = listener.local_addr().map_err(stringify)?.port();
    let config = OAuthConfig {
        authorize_url: OPENROUTER_AUTHORIZE.to_string(),
        token_url: OPENROUTER_KEYS.to_string(),
        client_id: "meridian".to_string(),
        client_secret: None,
        scopes: Vec::new(),
        extra_authorize_params: vec![("callback_url".to_string(), format!("http://localhost:{port}/")), ("key_label".to_string(), "Meridian".to_string())],
        extra_token_params: Vec::new(),
        redirect_host: "localhost",
    };
    let flow = LoopbackFlow::start_on(listener, &config).map_err(stringify)?;
    open_in_browser(flow.authorize_url())?;
    let code = flow.wait_for_code(SIGN_IN_TIMEOUT).await.map_err(stringify)?;
    let key = exchange_for_key(OPENROUTER_KEYS, &code).await.map_err(stringify)?;
    secrets::set(&id, &key)
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
