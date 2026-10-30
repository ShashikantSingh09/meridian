//! Connectors and sync against a local canned server: the OAuth flow, token
//! refresh, paging, cursors and every failure the app has to react to.

mod common;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use activity::accounts::graph::DeltaPage;
use activity::{
    disconnect, exchange_code, sync_google, sync_microsoft, CalendarChange, Error, EventStatus, Gmail, GoogleCalendar,
    Graph, LoopbackFlow, OAuthConfig, Session, Store, SyncOptions, TokenStore, Tokens,
};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{DateTime, TimeDelta, TimeZone, Utc};
use common::{serve, Canned};
use reqwest::Url;

const ACCOUNT: &str = "alex@example.test";

#[derive(Default)]
struct MemoryTokens(Mutex<HashMap<String, Tokens>>);

impl TokenStore for MemoryTokens {
    fn load(&self, account: &str) -> Result<Option<Tokens>, Error> {
        Ok(self.0.lock().unwrap().get(account).cloned())
    }
    fn save(&self, account: &str, tokens: &Tokens) -> Result<(), Error> {
        self.0.lock().unwrap().insert(account.to_string(), tokens.clone());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), Error> {
        self.0.lock().unwrap().remove(account);
        Ok(())
    }
}

fn now() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 30, 12, 0, 0).unwrap()
}

fn tokens_valid_for(duration: TimeDelta) -> Arc<MemoryTokens> {
    let store = Arc::new(MemoryTokens::default());
    let tokens = Tokens {
        access_token: "access-1".into(),
        refresh_token: Some("refresh-1".into()),
        expires_at: Some(Utc::now() + duration),
    };
    store.save(ACCOUNT, &tokens).unwrap();
    store
}

fn valid_tokens() -> Arc<MemoryTokens> {
    tokens_valid_for(TimeDelta::hours(1))
}

fn google_config(base: &str) -> OAuthConfig {
    let mut config = OAuthConfig::google("client-1", Some("desktop-secret".into()));
    config.token_url = format!("{base}/token");
    config
}

fn microsoft_config(base: &str) -> OAuthConfig {
    let mut config = OAuthConfig::microsoft("client-2");
    config.token_url = format!("{base}/token");
    config
}

fn gmail(base: &str, tokens: Arc<MemoryTokens>) -> Gmail {
    Gmail::new(Session::new(base, google_config(base), ACCOUNT, tokens).unwrap())
}

fn calendar(base: &str, tokens: Arc<MemoryTokens>) -> GoogleCalendar {
    GoogleCalendar::new(Session::new(base, google_config(base), ACCOUNT, tokens).unwrap())
}

fn graph(base: &str, tokens: Arc<MemoryTokens>) -> Graph {
    Graph::new(Session::new(base, microsoft_config(base), ACCOUNT, tokens).unwrap())
}

fn requests(seen: &Arc<Mutex<Vec<String>>>) -> Vec<String> {
    seen.lock().unwrap().clone()
}

fn request_line(request: &str) -> &str {
    request.lines().next().unwrap_or_default()
}

fn b64(text: &str) -> String {
    URL_SAFE_NO_PAD.encode(text)
}

fn gmail_message(id: &str, subject: &str, text: &str) -> Canned {
    Canned::json(
        serde_json::json!({
            "id": id,
            "internalDate": "1791000000000",
            "payload": {
                "mimeType": "multipart/alternative",
                "headers": [{ "name": "From", "value": "Northwind <bookings@northwind-air.example>" }, { "name": "Subject", "value": subject }],
                "parts": [{ "mimeType": "text/plain", "filename": "", "body": { "data": b64(text) } }]
            }
        })
        .to_string(),
    )
}

const FLIGHT_MAIL: &str = "Your e-ticket is attached.\nBooking reference: QX7K2M\nFlight NW204\nBoston (BOS) to Reykjavik (KEF)\nDeparts: 20 Nov 2026 19:40\n";

fn empty_calendar() -> Canned {
    Canned::json(r#"{"items":[],"nextSyncToken":"sync-1"}"#)
}

fn profile() -> Canned {
    Canned::json(format!(r#"{{"emailAddress":"{ACCOUNT}","historyId":"900"}}"#))
}

async fn cursor_json(store: &Store, resource: &str) -> serde_json::Value {
    serde_json::from_str(&store.cursor(ACCOUNT, resource).unwrap().unwrap()).unwrap()
}

// OAuth

/// Stands in for the browser following the redirect.
async fn browser_redirect(flow_url: &str, query: &str) -> reqwest::Result<reqwest::Response> {
    let authorize = Url::parse(flow_url).unwrap();
    let redirect = authorize.query_pairs().find(|(k, _)| k == "redirect_uri").unwrap().1.to_string();
    reqwest::get(format!("{redirect}/?{query}")).await
}

fn authorize_param(url: &str, name: &str) -> String {
    Url::parse(url).unwrap().query_pairs().find(|(k, _)| k == name).unwrap().1.to_string()
}

#[tokio::test]
async fn the_loopback_flow_returns_a_url_and_exchanges_the_code_with_pkce() {
    let (base, seen) = serve(vec![Canned::json(
        r#"{"access_token":"a","refresh_token":"r","expires_in":3600,"token_type":"Bearer"}"#,
    )])
    .await;
    let config = google_config(&base);
    let flow = LoopbackFlow::start(&config).await.unwrap();
    let url = flow.authorize_url().to_string();
    assert!(url.starts_with("https://accounts.google.com/"));
    assert_eq!(authorize_param(&url, "code_challenge_method"), "S256");
    assert!(authorize_param(&url, "redirect_uri").starts_with("http://127.0.0.1:"));

    let query = format!("code=the-code&state={}", authorize_param(&url, "state"));
    let (reply, code) = tokio::join!(browser_redirect(&url, &query), flow.wait_for_code(Duration::from_secs(5)));
    let tokens = exchange_code(&config, &code.unwrap()).await.unwrap();
    assert_eq!(tokens.access_token, "a");
    assert_eq!(tokens.refresh_token.as_deref(), Some("r"));
    assert!(tokens.expires_at.is_some());
    assert!(reply.unwrap().text().await.unwrap().contains("close this window"));

    let sent = requests(&seen);
    assert!(sent[0].contains("grant_type=authorization_code"));
    assert!(sent[0].contains("code=the-code"));
    assert!(sent[0].contains("code_verifier="));
    assert!(sent[0].contains("client_secret=desktop-secret"));
}

#[tokio::test]
async fn a_public_client_sends_no_secret() {
    let (base, seen) = serve(vec![Canned::json(r#"{"access_token":"a"}"#)]).await;
    let config = microsoft_config(&base);
    let flow = LoopbackFlow::start(&config).await.unwrap();
    let url = flow.authorize_url().to_string();
    let query = format!("code=c&state={}", authorize_param(&url, "state"));
    let (_, code) = tokio::join!(browser_redirect(&url, &query), flow.wait_for_code(Duration::from_secs(5)));
    exchange_code(&config, &code.unwrap()).await.unwrap();
    assert!(!requests(&seen)[0].contains("client_secret"));
}

#[tokio::test]
async fn a_wrong_state_is_refused() {
    let flow = LoopbackFlow::start(&OAuthConfig::microsoft("c")).await.unwrap();
    let url = flow.authorize_url().to_string();
    let (_, result) = tokio::join!(
        browser_redirect(&url, "code=stolen&state=forged"),
        flow.wait_for_code(Duration::from_secs(5))
    );
    assert!(matches!(result.err(), Some(Error::StateMismatch)));
}

#[tokio::test]
async fn a_refused_consent_is_reported_with_the_providers_reason() {
    let flow = LoopbackFlow::start(&OAuthConfig::microsoft("c")).await.unwrap();
    let url = flow.authorize_url().to_string();
    let query = format!("error=access_denied&state={}", authorize_param(&url, "state"));
    let (_, result) = tokio::join!(browser_redirect(&url, &query), flow.wait_for_code(Duration::from_secs(5)));
    assert!(matches!(result.err(), Some(Error::AuthorizationDenied(reason)) if reason == "access_denied"));
}

#[tokio::test]
async fn nobody_answering_times_out() {
    let flow = LoopbackFlow::start(&OAuthConfig::microsoft("c")).await.unwrap();
    let result = flow.wait_for_code(Duration::from_millis(50)).await;
    assert!(matches!(result.err(), Some(Error::AuthorizationTimedOut)));
}

#[tokio::test]
async fn a_favicon_request_and_a_silent_socket_do_not_block_the_redirect() {
    let flow = LoopbackFlow::start(&OAuthConfig::microsoft("c")).await.unwrap();
    let url = flow.authorize_url().to_string();
    let state = authorize_param(&url, "state");
    let redirect = authorize_param(&url, "redirect_uri");
    let address = redirect.trim_start_matches("http://").to_string();
    let browser = async {
        // Browsers open spare sockets and write nothing on them.
        let _idle = tokio::net::TcpStream::connect(&address).await.unwrap();
        assert_eq!(reqwest::get(format!("{redirect}/favicon.ico")).await.unwrap().status(), 404);
        browser_redirect(&url, &format!("code=c&state={state}")).await.unwrap();
    };
    let (_, result) = tokio::join!(browser, flow.wait_for_code(Duration::from_secs(5)));
    assert!(result.is_ok());
}

// Token handling

#[tokio::test]
async fn a_401_refreshes_once_and_retries() {
    let (base, seen) = serve(vec![
        Canned::status(401, r#"{"error":{"code":401,"message":"Invalid Credentials"}}"#),
        Canned::json(r#"{"access_token":"access-2","expires_in":3600}"#),
        profile(),
    ])
    .await;
    let tokens = valid_tokens();
    let profile = gmail(&base, tokens.clone()).profile().await.unwrap();
    assert_eq!(profile.email.as_deref(), Some(ACCOUNT));

    let sent = requests(&seen);
    assert!(sent[0].to_ascii_lowercase().contains("authorization: bearer access-1"));
    assert!(sent[1].contains("grant_type=refresh_token"));
    assert!(sent[1].contains("refresh_token=refresh-1"));
    assert!(sent[2].to_ascii_lowercase().contains("authorization: bearer access-2"));
    let saved = tokens.load(ACCOUNT).unwrap().unwrap();
    assert_eq!(saved.access_token, "access-2");
    assert_eq!(saved.refresh_token.as_deref(), Some("refresh-1"), "Google sends none back, so the old one stays");
}

#[tokio::test]
async fn a_rotated_refresh_token_is_stored() {
    let (base, _) = serve(vec![
        Canned::status(401, ""),
        Canned::json(r#"{"access_token":"access-2","refresh_token":"refresh-2","expires_in":3600}"#),
        Canned::json(r#"{"mail":"alex@example.test","displayName":"Alex"}"#),
    ])
    .await;
    let tokens = valid_tokens();
    graph(&base, tokens.clone()).profile().await.unwrap();
    assert_eq!(tokens.load(ACCOUNT).unwrap().unwrap().refresh_token.as_deref(), Some("refresh-2"));
}

#[tokio::test]
async fn an_expired_token_is_refreshed_before_the_first_request() {
    let (base, seen) = serve(vec![Canned::json(r#"{"access_token":"access-2","expires_in":3600}"#), profile()]).await;
    gmail(&base, tokens_valid_for(TimeDelta::seconds(-10))).profile().await.unwrap();
    let sent = requests(&seen);
    assert!(sent[0].contains("grant_type=refresh_token"));
    assert!(sent[1].to_ascii_lowercase().contains("authorization: bearer access-2"));
}

#[tokio::test]
async fn a_second_401_means_sign_in_again() {
    let (base, _) = serve(vec![
        Canned::status(401, ""),
        Canned::json(r#"{"access_token":"access-2"}"#),
        Canned::status(401, ""),
    ])
    .await;
    let result = gmail(&base, valid_tokens()).profile().await;
    assert!(matches!(result, Err(Error::ReauthRequired)));
}

#[tokio::test]
async fn a_revoked_grant_means_sign_in_again() {
    let (base, _) = serve(vec![
        Canned::status(401, ""),
        Canned::status(400, r#"{"error":"invalid_grant","error_description":"Token has been revoked"}"#),
    ])
    .await;
    let result = gmail(&base, valid_tokens()).profile().await;
    assert!(matches!(result, Err(Error::ReauthRequired)));
}

#[tokio::test]
async fn no_stored_tokens_means_sign_in_again_without_a_request() {
    let (base, seen) = serve(vec![]).await;
    let result = gmail(&base, Arc::new(MemoryTokens::default())).profile().await;
    assert!(matches!(result, Err(Error::ReauthRequired)));
    assert!(requests(&seen).is_empty());
}

// Failure surfaces

#[tokio::test]
async fn a_429_is_a_typed_error_with_its_retry_time() {
    let (base, _) = serve(vec![Canned::status(429, "{}").header("Retry-After", "120")]).await;
    let result = gmail(&base, valid_tokens()).profile().await;
    assert!(matches!(result, Err(Error::RateLimited { retry_after: Some(d) }) if d == Duration::from_secs(120)));
}

#[tokio::test]
async fn google_quota_403_is_rate_limiting_too() {
    let body = r#"{"error":{"code":403,"errors":[{"reason":"userRateLimitExceeded"}],"message":"Too fast"}}"#;
    let (base, _) = serve(vec![Canned::status(403, body)]).await;
    let result = gmail(&base, valid_tokens()).profile().await;
    assert!(matches!(result, Err(Error::RateLimited { .. })));
}

#[tokio::test]
async fn graph_throttling_503_is_rate_limiting_too() {
    let (base, _) = serve(vec![Canned::status(503, "").header("Retry-After", "7")]).await;
    let result = graph(&base, valid_tokens()).profile().await;
    assert!(matches!(result, Err(Error::RateLimited { retry_after: Some(d) }) if d == Duration::from_secs(7)));
}

#[tokio::test]
async fn malformed_json_and_non_objects_are_typed_errors() {
    for body in ["<html>captive portal</html>", "not json", "[]", ""] {
        let (base, _) = serve(vec![Canned::json(body)]).await;
        let result = gmail(&base, valid_tokens()).profile().await;
        assert!(matches!(result, Err(Error::Malformed(_))), "{body}");
    }
}

#[tokio::test]
async fn a_server_that_is_down_is_a_network_error() {
    let result = gmail("http://127.0.0.1:9", valid_tokens()).profile().await;
    assert!(matches!(result, Err(Error::Network(_))));
}

#[tokio::test]
async fn errors_carry_only_the_providers_message() {
    let body = r#"{"error":{"code":500,"message":"Backend Error"}}"#;
    let (base, _) = serve(vec![Canned::status(500, body)]).await;
    let error = gmail(&base, valid_tokens()).profile().await.unwrap_err();
    let shown = error.to_string();
    assert!(shown.contains("Backend Error"));
    assert!(!shown.contains("access-1"));
}

// Gmail

#[tokio::test]
async fn gmail_first_sync_pages_through_a_bounded_search_and_records_the_position() {
    let (base, seen) = serve(vec![
        profile(),
        Canned::json(r#"{"messages":[{"id":"m1"}],"nextPageToken":"p2"}"#),
        gmail_message("m1", "Your booking confirmation", FLIGHT_MAIL),
        Canned::json(r#"{"messages":[{"id":"m2"}]}"#),
        gmail_message("m2", "Team lunch", "See you at noon."),
        empty_calendar(),
    ])
    .await;
    let store = Store::in_memory().unwrap();
    let tokens = valid_tokens();
    let summary =
        sync_google(&gmail(&base, tokens.clone()), &calendar(&base, tokens), &store, &SyncOptions::default(), now()).await;

    assert!(summary.failures.is_empty(), "{:?}", summary.failures);
    assert_eq!(summary.messages_fetched, 2);
    assert_eq!(summary.items_extracted, 1);
    assert_eq!(summary.inserted, 1);

    let sent = requests(&seen);
    assert!(sent[1].contains("newer_than%3A90d") || sent[1].contains("newer_than:90d"), "{}", request_line(&sent[1]));
    assert!(sent[3].contains("pageToken=p2"));
    assert!(sent[2].contains("format=full"));

    let saved = store.list(&Default::default(), now().fixed_offset()).unwrap();
    assert_eq!(saved[0].source_ref.as_ref().unwrap().message_id, "m1");
    assert_eq!(saved[0].source_ref.as_ref().unwrap().account, ACCOUNT);
    assert_eq!(cursor_json(&store, "gmail").await["sync"], "900");
}

async fn store_with_gmail_cursor(history_id: &str) -> Store {
    let store = Store::in_memory().unwrap();
    store.set_cursor(ACCOUNT, "gmail", &format!(r#"{{"sync":"{history_id}"}}"#), now()).unwrap();
    store.set_cursor(ACCOUNT, "googleCalendar", r#"{"sync":"sync-0"}"#, now()).unwrap();
    store
}

#[tokio::test]
async fn gmail_incremental_reads_history_and_skips_promotions_without_fetching_them() {
    let history = r#"{"history":[
        {"id":"901","messagesAdded":[{"message":{"id":"m3","labelIds":["INBOX","CATEGORY_UPDATES"]}}]},
        {"id":"902","messagesAdded":[{"message":{"id":"m4","labelIds":["INBOX","CATEGORY_PROMOTIONS"]}}]},
        {"id":"903","messagesAdded":[{"message":{"id":"m3","labelIds":["INBOX"]}}]}
    ],"historyId":"903"}"#;
    let (base, seen) = serve(vec![
        Canned::json(history),
        gmail_message("m3", "Your booking confirmation", FLIGHT_MAIL),
        empty_calendar(),
    ])
    .await;
    let store = store_with_gmail_cursor("900").await;
    let tokens = valid_tokens();
    let summary =
        sync_google(&gmail(&base, tokens.clone()), &calendar(&base, tokens), &store, &SyncOptions::default(), now()).await;

    assert!(summary.failures.is_empty(), "{:?}", summary.failures);
    assert_eq!(summary.messages_fetched, 1);
    assert!(requests(&seen)[0].contains("startHistoryId=900"));
    assert_eq!(cursor_json(&store, "gmail").await["sync"], "903");
}

#[tokio::test]
async fn gmail_with_no_new_mail_just_advances() {
    let (base, seen) = serve(vec![Canned::json(r#"{"historyId":"950"}"#), empty_calendar()]).await;
    let store = store_with_gmail_cursor("900").await;
    let tokens = valid_tokens();
    let summary =
        sync_google(&gmail(&base, tokens.clone()), &calendar(&base, tokens), &store, &SyncOptions::default(), now()).await;
    assert!(summary.failures.is_empty(), "{:?}", summary.failures);
    assert_eq!(requests(&seen).len(), 2);
    assert_eq!(cursor_json(&store, "gmail").await["sync"], "950");
}

#[tokio::test]
async fn gmail_expired_history_falls_back_to_the_bounded_search() {
    let (base, seen) = serve(vec![
        Canned::status(404, r#"{"error":{"code":404,"message":"Not Found"}}"#),
        profile(),
        Canned::json(r#"{"resultSizeEstimate":0}"#),
        empty_calendar(),
    ])
    .await;
    let store = store_with_gmail_cursor("1").await;
    let tokens = valid_tokens();
    let summary =
        sync_google(&gmail(&base, tokens.clone()), &calendar(&base, tokens), &store, &SyncOptions::default(), now()).await;
    assert!(summary.failures.is_empty(), "{:?}", summary.failures);
    assert!(summary.resynced);
    assert!(requests(&seen)[2].contains("newer_than"));
    assert_eq!(cursor_json(&store, "gmail").await["sync"], "900");
}

#[tokio::test]
async fn a_message_deleted_after_listing_does_not_fail_the_sync() {
    let (base, _) = serve(vec![
        profile(),
        Canned::json(r#"{"messages":[{"id":"gone"},{"id":"m1"}]}"#),
        Canned::status(404, ""),
        gmail_message("m1", "Your booking confirmation", FLIGHT_MAIL),
        empty_calendar(),
    ])
    .await;
    let store = Store::in_memory().unwrap();
    let tokens = valid_tokens();
    let summary =
        sync_google(&gmail(&base, tokens.clone()), &calendar(&base, tokens), &store, &SyncOptions::default(), now()).await;
    assert!(summary.failures.is_empty(), "{:?}", summary.failures);
    assert_eq!(summary.inserted, 1);
}

#[tokio::test]
async fn an_invite_behind_an_attachment_id_is_fetched() {
    let ics = "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:u1\r\nDTSTART:20261105T150000Z\r\nSUMMARY:Sync\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    let message = serde_json::json!({
        "id": "m1",
        "internalDate": "1791000000000",
        "payload": {
            "mimeType": "multipart/mixed",
            "headers": [{ "name": "Subject", "value": "Invitation" }],
            "parts": [{ "mimeType": "text/calendar", "filename": "invite.ics", "body": { "attachmentId": "att-1", "size": 200 } }]
        }
    });
    let (base, seen) = serve(vec![
        Canned::json(message.to_string()),
        Canned::json(format!(r#"{{"data":"{}","size":200}}"#, b64(ics))),
    ])
    .await;
    let fetched = gmail(&base, valid_tokens()).get_message("m1").await.unwrap().unwrap();
    assert!(requests(&seen)[1].contains("/attachments/att-1"));
    assert!(fetched.calendar.unwrap().contains("UID:u1"));
}

#[tokio::test]
async fn rate_limiting_stops_the_page_and_the_next_run_resumes_there() {
    let (base, _) = serve(vec![
        profile(),
        Canned::json(r#"{"messages":[{"id":"m1"}],"nextPageToken":"p2"}"#),
        gmail_message("m1", "Your booking confirmation", FLIGHT_MAIL),
        Canned::status(429, "{}").header("Retry-After", "30"),
        empty_calendar(),
    ])
    .await;
    let store = Store::in_memory().unwrap();
    let tokens = valid_tokens();
    let summary =
        sync_google(&gmail(&base, tokens.clone()), &calendar(&base, tokens), &store, &SyncOptions::default(), now()).await;

    assert_eq!(summary.inserted, 1, "what was fetched first is kept");
    assert_eq!(summary.failures.len(), 1, "the calendar still ran");
    assert_eq!(summary.failures[0].resource, "gmail");
    assert!(matches!(summary.failures[0].error, Error::RateLimited { .. }));

    let (base, seen) = serve(vec![
        Canned::json(r#"{"messages":[{"id":"m9"}]}"#),
        gmail_message("m9", "Lunch", "See you at noon."),
        empty_calendar(),
    ])
    .await;
    let tokens = valid_tokens();
    let resumed =
        sync_google(&gmail(&base, tokens.clone()), &calendar(&base, tokens), &store, &SyncOptions::default(), now()).await;
    assert!(resumed.failures.is_empty(), "{:?}", resumed.failures);
    assert!(requests(&seen)[0].contains("pageToken=p2"), "{}", request_line(&requests(&seen)[0]));
    assert_eq!(cursor_json(&store, "gmail").await["sync"], "900", "the id noted before the listing");
}

#[tokio::test]
async fn the_initial_cap_ends_the_first_sync_early() {
    let (base, seen) = serve(vec![
        profile(),
        Canned::json(r#"{"messages":[{"id":"m1"}],"nextPageToken":"p2"}"#),
        gmail_message("m1", "Lunch", "See you at noon."),
        empty_calendar(),
    ])
    .await;
    let store = Store::in_memory().unwrap();
    let tokens = valid_tokens();
    let options = SyncOptions { max_initial_messages: 1, ..Default::default() };
    let summary = sync_google(&gmail(&base, tokens.clone()), &calendar(&base, tokens), &store, &options, now()).await;
    assert!(summary.failures.is_empty(), "{:?}", summary.failures);
    assert_eq!(requests(&seen).len(), 4, "page two was never asked for");
}

// Google Calendar

const CALENDAR_ITEM: &str = r#"{
    "id": "evt1",
    "status": "confirmed",
    "summary": "Design review",
    "iCalUID": "uid-1@google.test",
    "updated": "2026-10-01T09:00:00.000Z",
    "sequence": 0,
    "start": { "dateTime": "2026-11-05T10:00:00-05:00" },
    "end": { "dateTime": "2026-11-05T11:00:00-05:00" },
    "hangoutLink": "https://meet.google.com/abc-defg-hij"
}"#;

#[tokio::test]
async fn calendar_pages_through_a_full_sync_then_uses_the_sync_token() {
    let (base, seen) = serve(vec![
        Canned::json(format!(r#"{{"items":[{CALENDAR_ITEM}],"nextPageToken":"c2"}}"#)),
        Canned::json(r#"{"items":[],"nextSyncToken":"sync-1"}"#),
    ])
    .await;
    let client = calendar(&base, valid_tokens());
    let first = client.events_page(None, None, now(), 50).await.unwrap();
    assert_eq!(first.changes.len(), 1);
    assert_eq!(first.next_page.as_deref(), Some("c2"));
    let CalendarChange::Event(event) = &first.changes[0] else { panic!("expected an event") };
    assert_eq!(event.suggested_actions[0].action_id, "join");

    client.events_page(None, first.next_page.as_deref(), now(), 50).await.unwrap();
    let sent = requests(&seen);
    assert!(sent[0].contains("singleEvents=true"));
    assert!(sent[0].contains("timeMin="));
    assert!(sent[1].contains("pageToken=c2"));
}

#[tokio::test]
async fn a_sync_token_is_never_sent_with_a_time_bound() {
    let (base, seen) = serve(vec![Canned::json(r#"{"items":[]}"#)]).await;
    calendar(&base, valid_tokens()).events_page(Some("tok"), None, now(), 50).await.unwrap();
    let sent = requests(&seen);
    assert!(sent[0].contains("syncToken=tok"));
    assert!(sent[0].contains("singleEvents=true"), "must match the full sync");
    assert!(!sent[0].contains("timeMin"));
}

#[tokio::test]
async fn a_410_drops_the_token_and_reads_everything_again() {
    let (base, seen) = serve(vec![
        Canned::json(r#"{"historyId":"950"}"#),
        Canned::status(410, r#"{"error":{"code":410,"message":"Sync token is no longer valid"}}"#),
        Canned::json(format!(r#"{{"items":[{CALENDAR_ITEM}],"nextSyncToken":"sync-2"}}"#)),
    ])
    .await;
    let store = store_with_gmail_cursor("900").await;
    let tokens = valid_tokens();
    let summary =
        sync_google(&gmail(&base, tokens.clone()), &calendar(&base, tokens), &store, &SyncOptions::default(), now()).await;

    assert!(summary.failures.is_empty(), "{:?}", summary.failures);
    assert!(summary.resynced);
    assert_eq!(summary.inserted, 1);
    let sent = requests(&seen);
    assert!(sent[1].contains("syncToken=sync-0"));
    assert!(sent[2].contains("timeMin="));
    assert!(!sent[2].contains("syncToken"));
    assert_eq!(cursor_json(&store, "googleCalendar").await["sync"], "sync-2");
}

#[tokio::test]
async fn a_410_on_a_full_sync_is_reported_not_retried_forever() {
    let (base, _) = serve(vec![Canned::status(410, "{}")]).await;
    let result = calendar(&base, valid_tokens()).events_page(None, None, now(), 50).await;
    assert!(matches!(result, Err(Error::CursorExpired)));
}

#[tokio::test]
async fn an_invite_and_its_calendar_event_are_one_row_and_a_deletion_finds_it() {
    let (base, _) = serve(vec![
        Canned::json(r#"{"historyId":"950"}"#),
        Canned::json(format!(r#"{{"items":[{CALENDAR_ITEM}],"nextSyncToken":"sync-1"}}"#)),
        Canned::json(r#"{"historyId":"951"}"#),
        Canned::json(r#"{"items":[{"id":"evt1","status":"cancelled"}],"nextSyncToken":"sync-2"}"#),
    ])
    .await;
    let store = store_with_gmail_cursor("900").await;
    let mut invite = activity::ContextEvent::new(
        activity::EventKind::Meeting,
        activity::EventSource::Email,
        "Design review",
        "ical:uid-1@google.test",
        now() - TimeDelta::days(60),
    );
    invite.source_ref = Some(activity::SourceRef {
        account: ACCOUNT.to_string(),
        message_id: "m1".into(),
        subject: "Invitation".into(),
        received_at: now() - TimeDelta::days(60),
        link: None,
    });
    store.upsert(invite.clone()).unwrap();

    let tokens = valid_tokens();
    let (mail, cal) = (gmail(&base, tokens.clone()), calendar(&base, tokens));
    let first = sync_google(&mail, &cal, &store, &SyncOptions::default(), now()).await;
    assert!(first.failures.is_empty(), "{:?}", first.failures);
    assert_eq!(first.updated, 1);
    assert_eq!(first.inserted, 0);
    assert!(store.get(&invite.id).unwrap().unwrap().starts_at.is_some());

    let second = sync_google(&mail, &cal, &store, &SyncOptions::default(), now()).await;
    assert!(second.failures.is_empty(), "{:?}", second.failures);
    assert_eq!(second.removed, 1);
    assert_eq!(store.get(&invite.id).unwrap().unwrap().status, EventStatus::Cancelled);
}

// Microsoft Graph

const GRAPH_EVENT: &str = r#"{
    "id": "AAMk1",
    "iCalUId": "uid-9@graph.test",
    "subject": "Budget sync",
    "lastModifiedDateTime": "2026-10-01T09:00:00Z",
    "start": { "dateTime": "2026-11-05T15:00:00.0000000", "timeZone": "UTC" },
    "end": { "dateTime": "2026-11-05T15:30:00.0000000", "timeZone": "UTC" },
    "isAllDay": false,
    "isCancelled": false,
    "onlineMeeting": { "joinUrl": "https://teams.microsoft.com/l/meetup-join/1" }
}"#;

fn graph_mail(id: &str, subject: &str) -> String {
    serde_json::json!({
        "id": id,
        "subject": subject,
        "receivedDateTime": "2026-10-20T09:00:00Z",
        "from": { "emailAddress": { "name": "Northwind", "address": "bookings@northwind-air.example" } },
        "body": { "contentType": "text", "content": FLIGHT_MAIL },
        "webLink": "https://outlook.office365.com/owa/?itemid=1"
    })
    .to_string()
}

#[tokio::test]
async fn graph_pages_then_stores_the_delta_link_and_uses_it_next_time() {
    let (base, seen) = serve(vec![
        Canned::json(format!(
            r#"{{"value":[{}],"@odata.nextLink":"{{base}}/me/mailFolders/inbox/messages/delta?$skiptoken=s2"}}"#,
            graph_mail("m1", "Your booking confirmation")
        )),
        Canned::json(r#"{"value":[{"id":"gone","@removed":{"reason":"deleted"}}],"@odata.deltaLink":"{base}/me/mailFolders/inbox/messages/delta?$deltatoken=d1"}"#),
        Canned::json(format!(
            r#"{{"value":[{GRAPH_EVENT}],"@odata.deltaLink":"{{base}}/me/calendarView/delta?$deltatoken=c1"}}"#
        )),
        Canned::json(r#"{"value":[],"@odata.deltaLink":"{base}/me/mailFolders/inbox/messages/delta?$deltatoken=d2"}"#),
        Canned::json(r#"{"value":[{"id":"AAMk1","@removed":{"reason":"deleted"}}],"@odata.deltaLink":"{base}/me/calendarView/delta?$deltatoken=c2"}"#),
    ])
    .await;
    let store = Store::in_memory().unwrap();
    let client = graph(&base, valid_tokens());
    let summary = sync_microsoft(&client, &store, &SyncOptions::default(), now()).await;

    assert!(summary.failures.is_empty(), "{:?}", summary.failures);
    assert_eq!(summary.messages_fetched, 1);
    assert_eq!(summary.inserted, 2, "one flight and one meeting");

    let sent = requests(&seen);
    let first = sent[0].to_ascii_lowercase();
    assert!(request_line(&sent[0]).contains("/me/mailFolders/inbox/messages/delta"));
    assert!(request_line(&sent[0]).contains("receivedDateTime"));
    assert!(first.contains("prefer: outlook.allow-unsafe-html"), "JSON-LD lives in script tags Graph strips");
    assert!(sent[1].contains("skiptoken=s2"));
    assert!(sent[2].to_ascii_lowercase().contains("prefer: outlook.timezone=\"utc\""));
    assert!(request_line(&sent[2]).contains("startDateTime="));

    let again = sync_microsoft(&client, &store, &SyncOptions::default(), now()).await;
    assert!(again.failures.is_empty(), "{:?}", again.failures);
    assert_eq!(again.removed, 1);
    let sent = requests(&seen);
    assert!(sent[3].contains("deltatoken=d1"));
    assert!(sent[4].contains("deltatoken=c1"));
    assert!(sent[4].to_ascii_lowercase().contains("prefer: outlook.timezone=\"utc\""), "the preference applies per request");
}

#[tokio::test]
async fn a_paging_link_to_another_host_is_refused_without_sending_the_token() {
    let (base, seen) = serve(vec![Canned::json(
        r#"{"value":[],"@odata.nextLink":"https://evil.example/steal"}"#,
    )])
    .await;
    let client = graph(&base, valid_tokens());
    let first: DeltaPage<_> = client.messages_page(None, now(), 50).await.unwrap();
    let result = client.messages_page(first.next_link.as_deref(), now(), 50).await;
    assert!(matches!(result, Err(Error::Malformed(_))));
    assert_eq!(requests(&seen).len(), 1);
}

#[tokio::test]
async fn an_expired_delta_link_starts_over() {
    let (base, seen) = serve(vec![
        Canned::status(410, r#"{"error":{"code":"syncStateNotFound","message":"expired"}}"#),
        Canned::json(r#"{"value":[],"@odata.deltaLink":"{base}/me/mailFolders/inbox/messages/delta?$deltatoken=new"}"#),
        Canned::json(r#"{"value":[],"@odata.deltaLink":"{base}/me/calendarView/delta?$deltatoken=c"}"#),
    ])
    .await;
    let store = Store::in_memory().unwrap();
    let stale = format!(r#"{{"sync":"{base}/me/mailFolders/inbox/messages/delta?$deltatoken=old"}}"#);
    store.set_cursor(ACCOUNT, "graphMail", &stale, now()).unwrap();
    let summary = sync_microsoft(&graph(&base, valid_tokens()), &store, &SyncOptions::default(), now()).await;
    assert!(summary.failures.is_empty(), "{:?}", summary.failures);
    assert!(summary.resynced);
    assert!(requests(&seen)[1].contains("receivedDateTime"), "a fresh, bounded delta");
}

#[tokio::test]
async fn the_calendar_window_is_reopened_before_it_runs_out() {
    let (base, seen) = serve(vec![
        Canned::json(r#"{"value":[],"@odata.deltaLink":"{base}/me/mailFolders/inbox/messages/delta?$deltatoken=d"}"#),
        Canned::json(r#"{"value":[],"@odata.deltaLink":"{base}/me/calendarView/delta?$deltatoken=new"}"#),
    ])
    .await;
    let store = Store::in_memory().unwrap();
    let opened = (now() - TimeDelta::days(60)).to_rfc3339();
    let cursor = format!(r#"{{"sync":"{base}/me/calendarView/delta?$deltatoken=old","windowOpened":"{opened}"}}"#);
    store.set_cursor(ACCOUNT, "graphCalendar", &cursor, now()).unwrap();
    let summary = sync_microsoft(&graph(&base, valid_tokens()), &store, &SyncOptions::default(), now()).await;
    assert!(summary.failures.is_empty(), "{:?}", summary.failures);
    assert!(request_line(&requests(&seen)[1]).contains("startDateTime="));
}

#[tokio::test]
async fn graph_rate_limiting_reaches_the_summary_and_keeps_the_position() {
    let (base, _) = serve(vec![
        Canned::json(format!(
            r#"{{"value":[{}],"@odata.nextLink":"{{base}}/me/mailFolders/inbox/messages/delta?$skiptoken=s2"}}"#,
            graph_mail("m1", "Your booking confirmation")
        )),
        Canned::status(429, "{}").header("Retry-After", "11"),
        Canned::json(r#"{"value":[],"@odata.deltaLink":"{base}/me/calendarView/delta?$deltatoken=c"}"#),
    ])
    .await;
    let store = Store::in_memory().unwrap();
    let summary = sync_microsoft(&graph(&base, valid_tokens()), &store, &SyncOptions::default(), now()).await;
    assert_eq!(summary.failures.len(), 1);
    assert!(matches!(summary.failures[0].error, Error::RateLimited { retry_after: Some(_) }));
    assert!(cursor_json(&store, "graphMail").await["page"].as_str().unwrap().contains("skiptoken=s2"));
}

#[tokio::test]
async fn graph_profile_prefers_mail_and_falls_back_to_the_principal_name() {
    let (base, _) = serve(vec![Canned::json(r#"{"mail":null,"userPrincipalName":"alex@tenant.example"}"#)]).await;
    let profile = graph(&base, valid_tokens()).profile().await.unwrap();
    assert_eq!(profile.email.as_deref(), Some("alex@tenant.example"));
}

// The rest

#[tokio::test]
async fn disconnect_removes_tokens_and_everything_stored() {
    let (base, _) = serve(vec![
        profile(),
        Canned::json(r#"{"messages":[{"id":"m1"}]}"#),
        gmail_message("m1", "Your booking confirmation", FLIGHT_MAIL),
        empty_calendar(),
    ])
    .await;
    let store = Store::in_memory().unwrap();
    let tokens = valid_tokens();
    sync_google(&gmail(&base, tokens.clone()), &calendar(&base, tokens.clone()), &store, &SyncOptions::default(), now()).await;

    assert_eq!(disconnect(&store, tokens.as_ref(), ACCOUNT).unwrap(), 1);
    assert!(tokens.load(ACCOUNT).unwrap().is_none());
    assert_eq!(store.cursor(ACCOUNT, "gmail").unwrap(), None);
    assert!(store.list(&Default::default(), now().fixed_offset()).unwrap().is_empty());
}

#[test]
fn sync_futures_can_be_spawned() {
    fn assert_send<T: Send>(_: &T) {}
    let tokens = valid_tokens();
    let store = Store::in_memory().unwrap();
    let options = SyncOptions::default();
    let (mail, cal) = (gmail("http://x", tokens.clone()), calendar("http://x", tokens.clone()));
    let client = graph("http://x", tokens);
    assert_send(&sync_google(&mail, &cal, &store, &options, now()));
    assert_send(&sync_microsoft(&client, &store, &options, now()));
}
