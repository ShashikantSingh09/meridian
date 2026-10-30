//! Sign-in and digests against a local fake vendor: discovery, registration,
//! the loopback flow, Streamable HTTP, and every refusal the crate promises.

mod fake;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use activity::{TokenStore, Tokens};
use chrono::{TimeDelta, Utc};
use fake::{Fake, Reply, METADATA_PATH, PRM_PATH, PRM_ROOT};
use mcp::{digest, sign_in, use_token, Client, Digest, Error, Link, SignedIn};
use reqwest::Url;
use serde_json::{json, Value};

const ACCOUNT: &str = "alex@example.test";

#[derive(Default)]
struct MemoryTokens(Mutex<HashMap<String, Tokens>>);

impl TokenStore for MemoryTokens {
    fn load(&self, account: &str) -> Result<Option<Tokens>, activity::Error> {
        Ok(self.0.lock().unwrap().get(account).cloned())
    }
    fn save(&self, account: &str, tokens: &Tokens) -> Result<(), activity::Error> {
        self.0.lock().unwrap().insert(account.to_string(), tokens.clone());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), activity::Error> {
        self.0.lock().unwrap().remove(account);
        Ok(())
    }
}

fn store_with(access: &str, expires_in: TimeDelta) -> MemoryTokens {
    let store = MemoryTokens::default();
    let tokens = Tokens {
        access_token: access.to_string(),
        refresh_token: Some("refresh-1".to_string()),
        expires_at: Some(Utc::now() + expires_in),
    };
    store.save(ACCOUNT, &tokens).unwrap();
    store
}

fn valid_store() -> MemoryTokens {
    store_with("access-1", TimeDelta::hours(1))
}

fn query(url: &str) -> HashMap<String, String> {
    Url::parse(url).unwrap().query_pairs().into_owned().collect()
}

type Opened = Arc<Mutex<Option<String>>>;

/// Plays the browser: remembers the URL it was given and follows the redirect
/// with a code, over HTTP, as a real one would.
fn browser() -> (Opened, impl FnOnce(&str) -> Result<(), String> + Send) {
    let opened = Opened::default();
    let remembered = opened.clone();
    let open = move |url: &str| {
        *remembered.lock().unwrap() = Some(url.to_string());
        let params = query(url);
        let target = format!("{}/?code=the-code&state={}", params["redirect_uri"], params["state"]);
        tokio::spawn(async move { reqwest::get(target).await.unwrap() });
        Ok(())
    };
    (opened, open)
}

/// Runs a sign-in and returns its result with the URL the browser was sent to.
async fn connect(fake: &Fake, client: Option<Client>, store: &MemoryTokens) -> (Result<SignedIn, Error>, Option<String>) {
    let (opened, open) = browser();
    let result = sign_in(&fake.service(), client, store, ACCOUNT, open, Duration::from_secs(5)).await;
    let url = opened.lock().unwrap().clone();
    (result, url)
}

fn link(fake: &Fake, service: &str) -> Link {
    Link {
        service: service.to_string(),
        url: format!("{}/mcp", fake.base),
        token_url: format!("{}/token", fake.base),
        client_id: "client-1".to_string(),
        scopes: Vec::new(),
        resource: format!("{}/mcp", fake.base),
        static_token: false,
        connected_at: Utc::now(),
    }
}

async fn read(fake: &Fake, tool: Option<&str>) -> Result<Digest, Error> {
    digest(&link(fake, "fake"), None, &valid_store(), ACCOUNT, tool).await
}

fn hinted(name: &str) -> Value {
    json!({ "name": name, "annotations": { "readOnlyHint": true } })
}

// Sign-in

#[tokio::test]
async fn full_sign_in_registers_a_client_and_binds_the_token_to_the_resource() {
    let fake = Fake::start().await;
    let store = MemoryTokens::default();
    let (result, url) = connect(&fake, None, &store).await;
    let signed_in = result.unwrap();
    let authorize = query(url.as_deref().unwrap());
    let resource = format!("{}/mcp", fake.base);

    // Discovery starts with an anonymous initialize.
    let first = &fake.hits("/mcp")[0];
    assert_eq!(first.json()["method"], "initialize");
    assert_eq!(first.header("authorization"), None);

    let registered = fake.hits("/register")[0].json();
    assert_eq!(registered["client_name"], "Meridian");
    assert_eq!(registered["redirect_uris"][0], authorize["redirect_uri"]);
    assert!(authorize["redirect_uri"].starts_with("http://127.0.0.1:"));
    assert_eq!(registered["grant_types"], json!(["authorization_code", "refresh_token"]));
    assert_eq!(registered["response_types"], json!(["code"]));
    assert_eq!(registered["token_endpoint_auth_method"], "none");

    assert!(url.unwrap().starts_with(&format!("{}/authorize?", fake.base)));
    assert_eq!(authorize["client_id"], "registered-1");
    assert_eq!(authorize["resource"], resource);
    assert_eq!(authorize["code_challenge_method"], "S256");
    assert_eq!(authorize["scope"], "from-challenge");

    let exchange = fake.hits("/token")[0].form();
    assert_eq!(exchange["grant_type"], "authorization_code");
    assert_eq!(exchange["code"], "the-code");
    assert_eq!(exchange["resource"], resource);
    assert_eq!(exchange["client_id"], "registered-1");
    assert_eq!(exchange["redirect_uri"], authorize["redirect_uri"]);
    assert!(exchange["code_verifier"].len() >= 43);
    assert!(!exchange.contains_key("client_secret"));

    let tokens = store.load(ACCOUNT).unwrap().unwrap();
    assert_eq!(tokens.access_token, "access-1");
    assert_eq!(tokens.refresh_token.as_deref(), Some("refresh-1"));

    let link = signed_in.link;
    assert_eq!(link.service, "fake");
    assert_eq!(link.url, resource);
    assert_eq!(link.resource, resource);
    assert_eq!(link.token_url, format!("{}/token", fake.base));
    assert_eq!(link.client_id, "registered-1");
    assert_eq!(link.scopes, ["from-challenge"]);
    assert!(!link.static_token);
    assert!(signed_in.client_secret.is_none());
}

#[tokio::test]
async fn a_signed_in_link_works_for_a_digest() {
    let fake = Fake::start().await;
    let store = MemoryTokens::default();
    let signed_in = connect(&fake, None, &store).await.0.unwrap();
    let found = digest(&signed_in.link, signed_in.client_secret, &store, ACCOUNT, None).await.unwrap();
    assert_eq!(found.items[0].title, "First thing");
}

#[tokio::test]
async fn a_secret_returned_by_registration_is_kept_and_used() {
    let fake = Fake::start().await;
    let reply = Reply::json(201, json!({ "client_id": "registered-2", "client_secret": "sekrit" }));
    fake.world().pages.insert("/register".to_string(), reply);
    let store = MemoryTokens::default();
    let signed_in = connect(&fake, None, &store).await.0.unwrap();
    assert_eq!(signed_in.client_secret.as_deref(), Some("sekrit"));
    assert_eq!(signed_in.link.client_id, "registered-2");
    assert_eq!(fake.hits("/token")[0].form()["client_secret"], "sekrit");
}

#[tokio::test]
async fn a_supplied_client_skips_registration() {
    let fake = Fake::start().await;
    let store = MemoryTokens::default();
    let client = Client { id: "mine".to_string(), secret: Some("my-secret".to_string()) };
    let (result, url) = connect(&fake, Some(client), &store).await;
    let signed_in = result.unwrap();
    assert!(fake.hits("/register").is_empty());
    assert_eq!(query(&url.unwrap())["client_id"], "mine");
    assert_eq!(fake.hits("/token")[0].form()["client_secret"], "my-secret");
    assert_eq!(signed_in.link.client_id, "mine");
    assert_eq!(signed_in.client_secret.as_deref(), Some("my-secret"));
}

#[tokio::test]
async fn a_supplied_client_works_without_a_registration_endpoint() {
    let fake = Fake::start().await;
    fake.edit_page(METADATA_PATH, |document| {
        document.as_object_mut().unwrap().remove("registration_endpoint");
    });
    let client = Client { id: "mine".to_string(), secret: None };
    assert!(connect(&fake, Some(client), &MemoryTokens::default()).await.0.is_ok());
}

#[tokio::test]
async fn no_registration_endpoint_asks_for_a_registered_app() {
    let fake = Fake::start().await;
    fake.edit_page(METADATA_PATH, |document| {
        document.as_object_mut().unwrap().remove("registration_endpoint");
    });
    let (result, url) = connect(&fake, None, &MemoryTokens::default()).await;
    let error = result.err().unwrap();
    assert!(matches!(&error, Error::NeedsRegisteredApp(name) if name == "Fake"));
    assert!(error.to_string().contains("registered app"));
    assert!(url.is_none());
}

#[tokio::test]
async fn a_refused_registration_asks_for_a_registered_app() {
    let fake = Fake::start().await;
    fake.world().pages.insert("/register".to_string(), Reply::json(403, json!({ "error": "no" })));
    let (result, url) = connect(&fake, None, &MemoryTokens::default()).await;
    assert!(matches!(result, Err(Error::NeedsRegisteredApp(_))));
    assert!(url.is_none());
}

#[tokio::test]
async fn a_broken_registration_endpoint_is_reported_as_broken() {
    let fake = Fake::start().await;
    fake.world().pages.insert("/register".to_string(), Reply::empty(503));
    assert!(matches!(connect(&fake, None, &MemoryTokens::default()).await.0, Err(Error::Http(503))));
}

#[tokio::test]
async fn sign_in_refuses_a_server_without_s256() {
    for methods in [json!(["plain"]), Value::Null] {
        let fake = Fake::start().await;
        fake.edit_page(METADATA_PATH, |document| document["code_challenge_methods_supported"] = methods.clone());
        let (result, url) = connect(&fake, None, &MemoryTokens::default()).await;
        assert!(matches!(result, Err(Error::PkceUnsupported)), "{methods}");
        assert!(url.is_none());
        assert!(fake.hits("/register").is_empty());
    }
}

#[tokio::test]
async fn sign_in_refuses_metadata_from_another_issuer() {
    for issuer in [json!("https://elsewhere.example"), Value::Null] {
        let fake = Fake::start().await;
        fake.edit_page(METADATA_PATH, |document| document["issuer"] = issuer.clone());
        let (result, url) = connect(&fake, None, &MemoryTokens::default()).await;
        assert!(matches!(result, Err(Error::IssuerMismatch)), "{issuer}");
        assert!(url.is_none());
        assert!(fake.hits("/token").is_empty());
    }
}

#[tokio::test]
async fn an_issuer_may_differ_by_one_trailing_slash() {
    let fake = Fake::start().await;
    let issuer = format!("{}/", fake.base);
    fake.edit_page(METADATA_PATH, |document| document["issuer"] = json!(issuer));
    assert!(connect(&fake, None, &MemoryTokens::default()).await.0.is_ok());
}

#[tokio::test]
async fn every_address_a_server_hands_over_goes_through_the_guard() {
    let cases = [
        ("token_endpoint", "http://10.0.0.1/token"),
        ("token_endpoint", "https://169.254.169.254/token"),
        ("authorization_endpoint", "http://auth.example.com/authorize"),
        ("authorization_endpoint", "https://192.168.1.1/authorize"),
        ("registration_endpoint", "https://172.16.0.1/register"),
    ];
    for (field, address) in cases {
        let fake = Fake::start().await;
        fake.edit_page(METADATA_PATH, |document| document[field] = json!(address));
        let (result, url) = connect(&fake, None, &MemoryTokens::default()).await;
        assert!(matches!(result, Err(Error::UnsafeUrl)), "{field}");
        assert!(url.is_none(), "{field}");
        assert!(fake.hits("/register").is_empty(), "{field}");
    }
}

#[tokio::test]
async fn an_internal_authorization_server_is_refused_before_it_is_fetched() {
    let fake = Fake::start().await;
    fake.edit_page(PRM_PATH, |document| document["authorization_servers"] = json!(["https://10.0.0.1"]));
    let (result, _) = connect(&fake, None, &MemoryTokens::default()).await;
    assert!(matches!(result, Err(Error::UnsafeUrl)));
    assert!(fake.hits(METADATA_PATH).is_empty());
}

#[tokio::test]
async fn an_internal_resource_metadata_address_is_refused() {
    let fake = Fake::start().await;
    fake.world().challenge = Some(r#"Bearer resource_metadata="https://169.254.169.254/latest""#.to_string());
    let (result, _) = connect(&fake, None, &MemoryTokens::default()).await;
    assert!(matches!(result, Err(Error::UnsafeUrl)));
    assert!(fake.hits(PRM_PATH).is_empty());
}

#[tokio::test]
async fn a_redirect_from_a_server_is_not_followed() {
    let fake = Fake::start().await;
    let target = format!("{}/internal", fake.base);
    let redirect = Reply::empty(302).with_header("location", &target);
    fake.world().pages.insert(PRM_PATH.to_string(), redirect);
    fake.world().pages.insert("/internal".to_string(), Reply::json(200, json!({})));
    let _ = connect(&fake, None, &MemoryTokens::default()).await;
    assert!(fake.hits("/internal").is_empty());
}

#[tokio::test]
async fn discovery_without_a_challenge_tries_the_path_then_the_root() {
    let fake = Fake::start().await;
    let document = fake.world().pages.remove(PRM_PATH).unwrap();
    fake.world().pages.insert(PRM_ROOT.to_string(), document);
    fake.world().challenge = None;
    let signed_in = connect(&fake, None, &MemoryTokens::default()).await.0.unwrap();
    let paths = fake.paths();
    let specific = paths.iter().position(|path| path == PRM_PATH).unwrap();
    let root = paths.iter().position(|path| path == PRM_ROOT).unwrap();
    assert!(specific < root);
    assert_eq!(signed_in.link.scopes, ["from-document"]);
}

#[tokio::test]
async fn a_server_without_resource_metadata_falls_back_to_its_origin() {
    let fake = Fake::start().await;
    fake.world().pages.remove(PRM_PATH);
    fake.world().challenge = None;
    let (result, url) = connect(&fake, None, &MemoryTokens::default()).await;
    let signed_in = result.unwrap();
    let service_url = format!("{}/mcp", fake.base);
    assert_eq!(signed_in.link.resource, service_url);
    assert_eq!(query(&url.unwrap())["resource"], service_url);
    assert!(signed_in.link.scopes.is_empty());
}

#[tokio::test]
async fn no_scopes_anywhere_leaves_scope_off_the_authorize_url() {
    let fake = Fake::start().await;
    fake.world().pages.remove(PRM_PATH);
    fake.world().challenge = None;
    let (_, url) = connect(&fake, None, &MemoryTokens::default()).await;
    assert!(!query(&url.unwrap()).contains_key("scope"));
}

#[tokio::test]
async fn the_resource_comes_from_the_document_when_it_names_one() {
    let fake = Fake::start().await;
    let parent = fake.service().url.trim_end_matches("/mcp").to_string();
    let named = parent.clone();
    fake.edit_page(PRM_PATH, move |document| document["resource"] = json!(named));
    let (result, url) = connect(&fake, None, &MemoryTokens::default()).await;
    assert_eq!(result.unwrap().link.resource, parent);
    assert_eq!(query(&url.unwrap())["resource"], parent);
    assert_eq!(fake.hits("/token")[0].form()["resource"], parent);
}

#[tokio::test]
async fn a_document_naming_another_service_never_reaches_the_browser() {
    let fake = Fake::start().await;
    fake.edit_page(PRM_PATH, |document| document["resource"] = json!("https://mcp.linear.app/mcp"));
    let (result, url) = connect(&fake, None, &MemoryTokens::default()).await;
    assert!(matches!(result, Err(mcp::Error::ForeignResource)));
    assert!(url.is_none(), "the user was sent to sign in anyway");
}

#[tokio::test]
async fn catalog_scopes_beat_the_challenge() {
    let fake = Fake::start().await;
    let service = mcp::Service { read_scopes: &["read"], ..fake.service() };
    let (opened, open) = browser();
    let store = MemoryTokens::default();
    sign_in(&service, None, &store, ACCOUNT, open, Duration::from_secs(5)).await.unwrap();
    assert_eq!(query(opened.lock().unwrap().as_deref().unwrap())["scope"], "read");
}

#[tokio::test]
async fn a_path_issuer_is_found_at_its_third_address() {
    let fake = Fake::start().await;
    let issuer = format!("{}/tenant", fake.base);
    let mut metadata = fake.world().pages.remove(METADATA_PATH).unwrap();
    metadata.body = metadata.body.replace(&format!(r#""issuer":"{}""#, fake.base), &format!(r#""issuer":"{issuer}""#));
    fake.world().pages.insert("/tenant/.well-known/openid-configuration".to_string(), metadata);
    fake.edit_page(PRM_PATH, |document| document["authorization_servers"] = json!([issuer]));
    assert!(connect(&fake, None, &MemoryTokens::default()).await.0.is_ok());
    let tried: Vec<String> = fake.paths().into_iter().filter(|path| path.contains("tenant")).collect();
    assert_eq!(
        tried,
        [
            "/.well-known/oauth-authorization-server/tenant",
            "/.well-known/openid-configuration/tenant",
            "/tenant/.well-known/openid-configuration",
        ]
    );
}

#[tokio::test]
async fn no_metadata_anywhere_says_so() {
    let fake = Fake::start().await;
    fake.world().pages.remove(METADATA_PATH);
    assert!(matches!(connect(&fake, None, &MemoryTokens::default()).await.0, Err(Error::NoAuthorizationServer)));
}

#[tokio::test]
async fn a_browser_that_will_not_open_stops_the_sign_in() {
    let fake = Fake::start().await;
    let store = MemoryTokens::default();
    let result = sign_in(&fake.service(), None, &store, ACCOUNT, |_| Err("no browser".to_string()), Duration::from_secs(5)).await;
    assert!(matches!(result, Err(Error::Browser(reason)) if reason == "no browser"));
    assert!(store.load(ACCOUNT).unwrap().is_none());
}

#[tokio::test]
async fn nobody_coming_back_times_out_without_saving() {
    let fake = Fake::start().await;
    let store = MemoryTokens::default();
    let result = sign_in(&fake.service(), None, &store, ACCOUNT, |_| Ok(()), Duration::from_millis(50)).await;
    assert!(matches!(result, Err(Error::Account(activity::Error::AuthorizationTimedOut))));
    assert!(store.load(ACCOUNT).unwrap().is_none());
}

#[tokio::test]
async fn a_token_endpoint_echoing_secrets_does_not_reach_the_error() {
    let fake = Fake::start().await;
    let echo = json!({ "error": "invalid_request", "error_description": "bad code the-code" });
    fake.world().token_failure = Some(Reply::json(400, echo));
    let store = MemoryTokens::default();
    let shown = connect(&fake, None, &store).await.0.err().unwrap().to_string();
    assert!(shown.contains("400"));
    assert!(!shown.contains("the-code"));
    assert!(store.load(ACCOUNT).unwrap().is_none());
}

// Pasted tokens

#[tokio::test]
async fn a_pasted_token_is_proved_then_stored() {
    let fake = Fake::start().await;
    let store = MemoryTokens::default();
    let service = fake.service();
    let link = use_token(&service, " access-1\n".to_string(), &store, ACCOUNT).await.unwrap();
    assert!(link.static_token);
    assert_eq!(link.url, service.url);
    assert_eq!(link.resource, service.url);
    let stored = store.load(ACCOUNT).unwrap().unwrap();
    assert_eq!(stored.access_token, "access-1");
    assert_eq!(stored.refresh_token, None);
    assert_eq!(stored.expires_at, None);
    assert_eq!(fake.rpc("notifications/initialized").len(), 1);
    assert_eq!(fake.hits("/mcp").last().unwrap().method, "DELETE");
}

#[tokio::test]
async fn a_refused_pasted_token_is_not_stored() {
    let fake = Fake::start().await;
    let store = MemoryTokens::default();
    let result = use_token(&fake.service(), "wrong".to_string(), &store, ACCOUNT).await;
    assert!(matches!(result, Err(Error::TokenRefused)));
    assert!(store.load(ACCOUNT).unwrap().is_none());
}

#[tokio::test]
async fn a_pasted_token_never_tries_to_refresh() {
    let fake = Fake::start().await;
    let store = MemoryTokens::default();
    let link = use_token(&fake.service(), "access-1".to_string(), &store, ACCOUNT).await.unwrap();
    let found = digest(&link, None, &store, ACCOUNT, None).await.unwrap();
    assert_eq!(found.items.len(), 1);
    assert!(fake.hits("/token").is_empty());
}

// Digests

#[tokio::test]
async fn a_digest_speaks_the_protocol_and_returns_rows() {
    let fake = Fake::start().await;
    let found = read(&fake, None).await.unwrap();
    assert_eq!(found.server.as_deref(), Some("Fake Server"));
    assert_eq!(found.tool.as_deref(), Some("list_things"));
    assert_eq!(found.tools, ["list_things"]);
    assert_eq!(found.items[0].key, "T-1");
    assert_eq!(found.text, None);

    let requests = fake.hits("/mcp");
    let methods: Vec<Value> = requests.iter().map(|seen| seen.json()["method"].clone()).collect();
    assert_eq!(methods, [json!("initialize"), json!("notifications/initialized"), json!("tools/list"), json!("tools/call"), Value::Null]);
    assert_eq!(requests[4].method, "DELETE");

    for seen in &requests[..4] {
        assert_eq!(seen.method, "POST");
        assert_eq!(seen.header("accept"), Some("application/json, text/event-stream"));
        assert_eq!(seen.header("content-type"), Some("application/json"));
    }
    for seen in &requests {
        assert_eq!(seen.header("authorization"), Some("Bearer access-1"));
    }
    assert_eq!(requests[0].json()["params"]["protocolVersion"], "2025-11-25");
    assert_eq!(requests[0].header("mcp-protocol-version"), None);
    assert_eq!(requests[0].header("mcp-session-id"), None);
    for seen in &requests[1..] {
        assert_eq!(seen.header("mcp-protocol-version"), Some("2025-11-25"));
        assert_eq!(seen.header("mcp-session-id"), Some("session-1"));
    }
    assert_eq!(requests[3].json()["params"], json!({ "name": "list_things", "arguments": {} }));
}

#[tokio::test]
async fn the_version_header_follows_what_the_server_negotiated() {
    let fake = Fake::start().await;
    fake.world().protocol = "2025-06-18".to_string();
    read(&fake, None).await.unwrap();
    assert_eq!(fake.rpc("tools/list")[0].header("mcp-protocol-version"), Some("2025-06-18"));
}

#[tokio::test]
async fn a_server_without_sessions_gets_no_session_header_and_no_delete() {
    let fake = Fake::start().await;
    fake.world().gives_sessions = false;
    read(&fake, None).await.unwrap();
    assert!(fake.hits("/mcp").iter().all(|seen| seen.method == "POST" && seen.header("mcp-session-id").is_none()));
}

#[tokio::test]
async fn sse_replies_are_read_up_to_the_matching_message() {
    let fake = Fake::start().await;
    fake.world().sse = true;
    // The fake holds each stream open, so reading to the end would hang here.
    let found = tokio::time::timeout(Duration::from_secs(5), read(&fake, None)).await.unwrap().unwrap();
    assert_eq!(found.server.as_deref(), Some("Fake Server"));
    assert_eq!(found.tools, ["list_things"]);
    assert_eq!(found.items[0].title, "First thing");
}

#[tokio::test]
async fn a_stream_that_ends_without_an_answer_is_malformed() {
    let fake = Fake::start().await;
    fake.world().sse = true;
    fake.world().sse_silent = true;
    assert!(matches!(read(&fake, None).await, Err(Error::Malformed(_))));
}

#[tokio::test]
async fn a_lost_session_is_rebuilt_once() {
    let fake = Fake::start().await;
    fake.world().forget_sessions = 1;
    let found = read(&fake, None).await.unwrap();
    assert_eq!(found.items.len(), 1);
    assert_eq!(fake.rpc("initialize").len(), 2);
    let list = fake.rpc("tools/list");
    assert_eq!(list[0].header("mcp-session-id"), Some("session-1"));
    assert_eq!(list[1].header("mcp-session-id"), Some("session-2"));
    assert_eq!(fake.rpc("tools/call")[0].header("mcp-session-id"), Some("session-2"));
}

#[tokio::test]
async fn a_session_lost_twice_in_a_row_gives_up() {
    let fake = Fake::start().await;
    fake.world().forget_sessions = 5;
    assert!(matches!(read(&fake, None).await, Err(Error::Http(404))));
    assert_eq!(fake.rpc("initialize").len(), 2);
}

#[tokio::test]
async fn a_404_with_no_session_is_just_a_404() {
    let fake = Fake::start().await;
    let mut link = link(&fake, "fake");
    link.url = format!("{}/nowhere", fake.base);
    let result = digest(&link, None, &valid_store(), ACCOUNT, None).await;
    assert!(matches!(result, Err(Error::Http(404))));
    assert_eq!(fake.hits("/nowhere").len(), 1);
}

#[tokio::test]
async fn expired_tokens_are_refreshed_saved_and_used() {
    let fake = Fake::start().await;
    fake.world().accepted = vec!["access-old".to_string()];
    let store = store_with("access-old", TimeDelta::seconds(30));
    let link = link(&fake, "fake");
    let found = digest(&link, Some("kept-secret".to_string()), &store, ACCOUNT, None).await.unwrap();
    assert_eq!(found.items.len(), 1);

    let refresh = fake.hits("/token")[0].form();
    assert_eq!(refresh["grant_type"], "refresh_token");
    assert_eq!(refresh["refresh_token"], "refresh-1");
    assert_eq!(refresh["resource"], link.resource);
    assert_eq!(refresh["client_id"], "client-1");
    assert_eq!(refresh["client_secret"], "kept-secret");

    let saved = store.load(ACCOUNT).unwrap().unwrap();
    assert_eq!(saved.access_token, "access-2");
    assert_eq!(saved.refresh_token.as_deref(), Some("refresh-2"));
    assert!(fake.rpc("tools/list").iter().all(|seen| seen.header("authorization") == Some("Bearer access-2")));
}

#[tokio::test]
async fn tokens_with_time_left_are_not_refreshed() {
    let fake = Fake::start().await;
    let store = store_with("access-1", TimeDelta::minutes(5));
    digest(&link(&fake, "fake"), None, &store, ACCOUNT, None).await.unwrap();
    assert!(fake.hits("/token").is_empty());
}

#[tokio::test]
async fn a_refused_refresh_means_sign_in_again() {
    let fake = Fake::start().await;
    fake.world().token_failure = Some(Reply::json(400, json!({ "error": "invalid_grant" })));
    let store = store_with("access-old", TimeDelta::seconds(-10));
    let result = digest(&link(&fake, "fake"), None, &store, ACCOUNT, None).await;
    assert!(matches!(result, Err(Error::ReauthRequired)));
    assert!(fake.hits("/mcp").is_empty());
}

#[tokio::test]
async fn a_401_from_the_server_means_sign_in_again() {
    let fake = Fake::start().await;
    fake.world().accepted.clear();
    assert!(matches!(read(&fake, None).await, Err(Error::ReauthRequired)));
    assert!(fake.rpc("tools/list").is_empty());
}

#[tokio::test]
async fn nothing_stored_means_sign_in_again_without_a_request() {
    let fake = Fake::start().await;
    let result = digest(&link(&fake, "fake"), None, &MemoryTokens::default(), ACCOUNT, None).await;
    assert!(matches!(result, Err(Error::ReauthRequired)));
    assert!(fake.paths().is_empty());
}

#[tokio::test]
async fn tools_page_until_the_cursor_runs_out() {
    let fake = Fake::start().await;
    {
        let mut world = fake.world();
        world.tools = (0..7).map(|index| hinted(&format!("list_{index}"))).collect();
        world.page_size = 3;
    }
    let found = read(&fake, None).await.unwrap();
    assert_eq!(found.tools.len(), 7);
    let pages = fake.rpc("tools/list");
    assert_eq!(pages.len(), 3);
    assert!(pages[0].json()["params"].get("cursor").is_none());
    assert_eq!(pages[1].json()["params"]["cursor"], "3");
    assert_eq!(pages[2].json()["params"]["cursor"], "6");
}

#[tokio::test]
async fn tools_stop_at_the_cap() {
    let fake = Fake::start().await;
    {
        let mut world = fake.world();
        world.tools = (0..250).map(|index| hinted(&format!("list_{index}"))).collect();
        world.page_size = 30;
    }
    let found = read(&fake, None).await.unwrap();
    assert_eq!(found.tools.len(), 200);
    assert_eq!(fake.rpc("tools/list").len(), 7);
}

#[tokio::test]
async fn endless_empty_pages_stop_too() {
    let fake = Fake::start().await;
    fake.world().endless_pages = true;
    let found = read(&fake, None).await.unwrap();
    assert!(found.tools.is_empty());
    assert_eq!(fake.rpc("tools/list").len(), 200);
}

#[tokio::test]
async fn a_tool_that_only_claims_to_be_read_only_is_never_called() {
    let fake = Fake::start().await;
    fake.world().tools = vec![hinted("delete_everything"), json!({ "name": "whoami" })];
    let found = read(&fake, None).await.unwrap();
    assert_eq!(found.tool, None);
    assert!(found.tools.is_empty());
    assert!(found.items.is_empty());
    assert!(fake.rpc("tools/call").is_empty());
}

#[tokio::test]
async fn asking_for_a_write_tool_by_name_is_refused_before_anything_is_called() {
    let fake = Fake::start().await;
    fake.world().tools = vec![hinted("delete_everything"), hinted("list_things")];
    let result = read(&fake, Some("delete_everything")).await;
    assert!(matches!(&result, Err(Error::ToolRefused(name)) if name == "delete_everything"));
    assert!(result.err().unwrap().to_string().contains("delete_everything"));
    assert!(fake.rpc("tools/call").is_empty());
    assert_eq!(fake.hits("/mcp").last().unwrap().method, "DELETE");
}

#[tokio::test]
async fn an_explicit_readable_tool_is_called_with_filled_arguments() {
    let fake = Fake::start().await;
    fake.world().tools = vec![
        hinted("list_things"),
        json!({
            "name": "search_things",
            "annotations": { "readOnlyHint": true },
            "inputSchema": {
                "properties": { "query": { "type": "string" }, "limit": { "type": "integer" } },
                "required": ["query"]
            }
        }),
    ];
    let found = read(&fake, Some("search_things")).await.unwrap();
    assert_eq!(found.tool.as_deref(), Some("search_things"));
    let call = fake.rpc("tools/call")[0].json();
    assert_eq!(call["params"]["name"], "search_things");
    assert_eq!(call["params"]["arguments"], json!({ "query": "", "limit": 10 }));
}

#[tokio::test]
async fn a_catalogued_service_uses_its_name_rule_and_preferences() {
    let fake = Fake::start().await;
    fake.world().tools = vec![json!({ "name": "list_issues" }), json!({ "name": "list_my_issues" })];
    let found = digest(&link(&fake, "linear"), None, &valid_store(), ACCOUNT, None).await.unwrap();
    assert_eq!(found.tool.as_deref(), Some("list_my_issues"));
    assert_eq!(found.tools, ["list_issues", "list_my_issues"]);
}

#[tokio::test]
async fn an_unknown_service_gets_no_name_rule() {
    let fake = Fake::start().await;
    fake.world().tools = vec![json!({ "name": "list_issues" })];
    let found = read(&fake, None).await.unwrap();
    assert_eq!(found.tool, None);
    assert!(fake.rpc("tools/call").is_empty());
}

#[tokio::test]
async fn a_failed_tool_call_carries_its_text() {
    let fake = Fake::start().await;
    fake.world().result = json!({ "isError": true, "content": [{ "type": "text", "text": "Quota used up" }] });
    let result = read(&fake, None).await;
    assert!(matches!(&result, Err(Error::Tool(text)) if text == "Quota used up"));
    assert_eq!(fake.hits("/mcp").last().unwrap().method, "DELETE");
}

#[tokio::test]
async fn a_token_quoted_back_by_the_server_never_reaches_the_user() {
    let fake = Fake::start().await;
    fake.world().result = json!({ "isError": true, "content": [{ "type": "text", "text": "Bearer access-1 is bad" }] });
    let shown = read(&fake, None).await.err().unwrap().to_string();
    assert!(shown.contains("is bad"));
    assert!(!shown.contains("access-1"));

    let fake = Fake::start().await;
    fake.world().rpc_error = Some("Rejected access-1".to_string());
    let shown = read(&fake, None).await.err().unwrap().to_string();
    assert!(shown.contains("Rejected"));
    assert!(!shown.contains("access-1"));

    let fake = Fake::start().await;
    fake.world().result = json!({ "content": [{ "type": "text", "text": "You are access-1" }] });
    let found = read(&fake, None).await.unwrap();
    assert_eq!(found.text.as_deref(), Some("You are [token]"));
}

#[tokio::test]
async fn a_json_rpc_error_carries_its_message() {
    let fake = Fake::start().await;
    fake.world().rpc_error = Some("Nope".to_string());
    assert!(matches!(read(&fake, None).await, Err(Error::Tool(text)) if text == "Nope"));
}

#[tokio::test]
async fn text_results_come_back_as_text() {
    let fake = Fake::start().await;
    fake.world().result = json!({ "content": [{ "type": "text", "text": "All quiet." }] });
    let found = read(&fake, None).await.unwrap();
    assert_eq!(found.text.as_deref(), Some("All quiet."));
    assert!(found.items.is_empty());
}

#[tokio::test]
async fn a_reply_past_the_cap_is_refused() {
    let fake = Fake::start().await;
    fake.world().result = json!({ "content": [{ "type": "text", "text": "x".repeat(9 * 1024 * 1024) }] });
    assert!(matches!(read(&fake, None).await, Err(Error::TooLarge)));
}

#[tokio::test]
async fn a_reply_answering_some_other_id_is_malformed() {
    let fake = Fake::start().await;
    let confused = Reply::json(200, json!({ "jsonrpc": "2.0", "id": 99, "result": {} }));
    fake.world().pages.insert("/odd".to_string(), confused);
    let mut link = link(&fake, "fake");
    link.url = format!("{}/odd", fake.base);
    let result = digest(&link, None, &valid_store(), ACCOUNT, None).await;
    assert!(matches!(result, Err(Error::Malformed(_))));
}
