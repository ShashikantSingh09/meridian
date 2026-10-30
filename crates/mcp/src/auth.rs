//! Sign-in for a remote server: ask the server who signs it in, check that
//! answer, then run the loopback flow from `activity`. Every address here came
//! from a server we have not met, so each one passes [`check_url`] before use.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::time::Duration;

use activity::{exchange_code, refresh_tokens, LoopbackFlow, OAuthConfig, TokenStore, Tokens};
use ai_core::is_loopback;
use chrono::{TimeDelta, Utc};
use reqwest::header::ACCEPT;
use reqwest::Url;
use serde_json::{json, Value};
use tokio::net::TcpListener;

use crate::client::{http_client, read_json, Challenge, Connection};
use crate::{digest, Client, Error, Link, Service, SignedIn};

/// Tokens this close to expiry are refreshed first, so a digest does not fail
/// halfway through.
const EXPIRY_MARGIN_SECONDS: i64 = 60;

fn is_internal_v4(ip: Ipv4Addr) -> bool {
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        // 0.0.0.0/8 reaches this host on some systems, and 100.64.0.0/10 is
        // carrier NAT, where one cloud keeps its metadata service.
        || matches!(ip.octets(), [0, ..] | [100, 64..=127, ..])
}

/// `to_ipv4` also unwraps `::ffff:127.0.0.1`, the usual way past a v4-only check.
fn is_internal_v6(ip: Ipv6Addr) -> bool {
    ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_unique_local()
        || ip.is_unicast_link_local()
        || ip.to_ipv4().is_some_and(is_internal_v4)
}

/// The SSRF guard for an address a server gave us: https, and not plainly on
/// this machine or network. Plain http is for tests, and only on loopback, and
/// only when the service itself lives there.
// ponytail: this reads the URL text, so a public name that resolves to an
// internal address (DNS rebinding) still passes. Resolve and pin addresses
// before connecting if this ever talks to servers outside the catalog.
pub(crate) fn check_url(raw: &str, allow_loopback: bool) -> Result<Url, Error> {
    let url = Url::parse(raw).map_err(|_| Error::UnsafeUrl)?;
    let host = url.host_str().ok_or(Error::UnsafeUrl)?;
    let host = host.trim_matches(['[', ']']).trim_end_matches('.').to_ascii_lowercase();
    let internal = match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => is_internal_v4(ip),
        Ok(IpAddr::V6(ip)) => is_internal_v6(ip),
        Err(_) => host == "localhost" || host.ends_with(".localhost"),
    };
    let safe = if allow_loopback && is_loopback(raw) {
        matches!(url.scheme(), "http" | "https")
    } else {
        url.scheme() == "https" && !internal
    };
    safe.then_some(url).ok_or(Error::UnsafeUrl)
}

/// `None` when this address holds no document, so the next one can be tried.
/// Anything that is not a JSON object counts, which covers a host that answers
/// every path with its home page.
async fn fetch_document(http: &reqwest::Client, url: &str) -> Result<Option<Value>, Error> {
    let response = http.get(url).header(ACCEPT, "application/json").send().await.map_err(Error::from_reqwest)?;
    if !response.status().is_success() {
        return Ok(None);
    }
    Ok(read_json(response).await?.filter(Value::is_object))
}

fn protected_resource_urls(server: &Url) -> Vec<String> {
    let origin = server.origin().ascii_serialization();
    let path = server.path().trim_end_matches('/');
    let mut urls = vec![format!("{origin}/.well-known/oauth-protected-resource{path}")];
    if !path.is_empty() {
        urls.push(format!("{origin}/.well-known/oauth-protected-resource"));
    }
    urls
}

fn authorization_server_urls(issuer: &Url) -> Vec<String> {
    let origin = issuer.origin().ascii_serialization();
    let path = issuer.path().trim_end_matches('/');
    let mut urls = vec![
        format!("{origin}/.well-known/oauth-authorization-server{path}"),
        format!("{origin}/.well-known/openid-configuration{path}"),
    ];
    if !path.is_empty() {
        urls.push(format!("{origin}{path}/.well-known/openid-configuration"));
    }
    urls
}

/// `Value::Null` when the server publishes none, which Atlassian does not.
async fn protected_resource(
    http: &reqwest::Client,
    server: &Url,
    challenge: &Challenge,
    allow_loopback: bool,
) -> Result<Value, Error> {
    let mut urls = Vec::new();
    if let Some(url) = &challenge.resource_metadata {
        urls.push(check_url(url, allow_loopback)?.to_string());
    }
    urls.extend(protected_resource_urls(server));
    for url in urls {
        if let Some(document) = fetch_document(http, &url).await? {
            return Ok(document);
        }
    }
    Ok(Value::Null)
}

struct Endpoints {
    authorize: String,
    token: String,
    registration: Option<String>,
}

fn same_issuer(left: &str, right: &str) -> bool {
    left.strip_suffix('/').unwrap_or(left) == right.strip_suffix('/').unwrap_or(right)
}

/// Finds the issuer's metadata and holds it to what the MCP spec demands: the
/// issuer it names is the one we asked, and PKCE with S256 is on offer. A
/// server that omits the method list does not offer it.
async fn authorization_server(http: &reqwest::Client, issuer: &str, allow_loopback: bool) -> Result<Endpoints, Error> {
    let base = check_url(issuer, allow_loopback)?;
    for url in authorization_server_urls(&base) {
        let Some(document) = fetch_document(http, &url).await? else { continue };
        if !same_issuer(document["issuer"].as_str().unwrap_or_default(), issuer) {
            return Err(Error::IssuerMismatch);
        }
        let methods = document["code_challenge_methods_supported"].as_array();
        if !methods.is_some_and(|methods| methods.iter().any(|method| method == "S256")) {
            return Err(Error::PkceUnsupported);
        }
        let endpoint = |name: &str| -> Result<String, Error> {
            let raw = document[name].as_str().ok_or(Error::Malformed("sign-in details"))?;
            Ok(check_url(raw, allow_loopback)?.to_string())
        };
        return Ok(Endpoints {
            authorize: endpoint("authorization_endpoint")?,
            token: endpoint("token_endpoint")?,
            registration: document["registration_endpoint"]
                .is_string()
                .then(|| endpoint("registration_endpoint"))
                .transpose()?,
        });
    }
    Err(Error::NoAuthorizationServer)
}

/// Without a read-only list for this vendor, anything that sounds like writing or
/// administration is left out. Asking for less can only fail safely.
fn narrow(scopes: impl Iterator<Item = String>) -> Vec<String> {
    let broad = |scope: &str| {
        let scope = scope.to_ascii_lowercase();
        scope.contains("admin") || digest::WRITE_WORDS.iter().any(|word| scope.contains(word))
    };
    scopes.filter(|scope| !broad(scope)).collect()
}

fn choose_scopes(service: &Service, challenge: &Challenge, resource: &Value) -> Vec<String> {
    if !service.read_scopes.is_empty() {
        return service.read_scopes.iter().map(|scope| scope.to_string()).collect();
    }
    let challenged = narrow(challenge.scope.iter().flat_map(|s| s.split_whitespace()).map(str::to_string));
    if !challenged.is_empty() {
        return challenged;
    }
    let supported = resource["scopes_supported"].as_array().into_iter().flatten();
    narrow(supported.filter_map(|scope| scope.as_str().map(str::to_string)))
}

/// The metadata has to describe the server it came from (RFC 9728, section 3.3).
/// Otherwise a server could name another service's sign-in, and the token the user
/// granted there would come straight back to it.
fn check_resource(server_url: &str, document: &Value) -> Result<(), Error> {
    let Some(claimed) = document["resource"].as_str() else { return Ok(()) };
    let (Ok(claimed), Ok(server)) = (Url::parse(claimed), Url::parse(server_url)) else {
        return Err(Error::ForeignResource);
    };
    let same_origin = claimed.origin() == server.origin();
    let covers = server.path().trim_end_matches('/').starts_with(claimed.path().trim_end_matches('/'));
    if same_origin && covers {
        Ok(())
    } else {
        Err(Error::ForeignResource)
    }
}

/// Dynamic Client Registration. Client ID Metadata Documents are skipped: they
/// need a hosted https URL, and this app has none. A refusal means the vendor
/// wants a registered app; the server's choice of auth method is simply taken.
async fn register(
    http: &reqwest::Client,
    endpoint: Option<&str>,
    service: &Service,
    port: u16,
) -> Result<Client, Error> {
    let needs_app = || Error::NeedsRegisteredApp(service.name.to_string());
    let body = json!({
        "client_name": "Meridian",
        "redirect_uris": [format!("http://127.0.0.1:{port}")],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    });
    let response = http.post(endpoint.ok_or_else(needs_app)?).json(&body).send().await.map_err(Error::from_reqwest)?;
    let status = response.status();
    if status.is_client_error() {
        return Err(needs_app());
    }
    if !status.is_success() {
        return Err(Error::Http(status.as_u16()));
    }
    let reply = read_json(response).await?.unwrap_or_default();
    let id = reply["client_id"].as_str().ok_or(Error::Malformed("registration reply"))?;
    Ok(Client { id: id.to_string(), secret: reply["client_secret"].as_str().map(str::to_string) })
}

/// Everything a refresh needs, which is everything but the browser half. `resource`
/// goes out on each so a new token stays bound to this server.
fn refresh_config(link: &Link, client_secret: Option<String>) -> OAuthConfig {
    OAuthConfig {
        authorize_url: String::new(),
        token_url: link.token_url.clone(),
        client_id: link.client_id.clone(),
        client_secret,
        scopes: link.scopes.clone(),
        extra_authorize_params: Vec::new(),
        extra_token_params: vec![("resource".to_string(), link.resource.clone())],
        redirect_host: "127.0.0.1",
    }
}

pub async fn sign_in(
    service: &Service,
    client: Option<Client>,
    store: &dyn TokenStore,
    account: &str,
    open: impl FnOnce(&str) -> Result<(), String> + Send,
    timeout: Duration,
) -> Result<SignedIn, Error> {
    let allow_loopback = is_loopback(service.url);
    let http = http_client()?;
    let server = Url::parse(service.url).map_err(|_| Error::Malformed("service address"))?;

    let knock = Connection::new(service.url, None)?.knock().await?;
    let challenge = if knock.status() == 401 { Challenge::from_headers(knock.headers()) } else { Challenge::default() };
    let document = protected_resource(&http, &server, &challenge, allow_loopback).await?;
    let origin = server.origin().ascii_serialization();
    check_resource(service.url, &document)?;
    let issuer = document["authorization_servers"][0].as_str().unwrap_or(&origin);
    let endpoints = authorization_server(&http, issuer, allow_loopback).await?;

    // Registration has to name the redirect, so the port comes first.
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|_| Error::Network("Could not open a local port."))?;
    let port = listener.local_addr().map_err(|_| Error::Network("Could not open a local port."))?.port();
    let client = match client {
        Some(client) => client,
        None => register(&http, endpoints.registration.as_deref(), service, port).await?,
    };

    let link = Link {
        service: service.id.to_string(),
        url: service.url.to_string(),
        token_url: endpoints.token,
        client_id: client.id,
        scopes: choose_scopes(service, &challenge, &document),
        resource: document["resource"].as_str().unwrap_or(service.url).to_string(),
        static_token: false,
        connected_at: Utc::now(),
    };
    let config = OAuthConfig {
        authorize_url: endpoints.authorize,
        extra_authorize_params: vec![("resource".to_string(), link.resource.clone())],
        ..refresh_config(&link, client.secret.clone())
    };
    let flow = LoopbackFlow::start_on(listener, &config)?;
    open(flow.authorize_url()).map_err(Error::Browser)?;
    let code = flow.wait_for_code(timeout).await?;
    let tokens = exchange_code(&config, &code).await?;
    store.save(account, &tokens)?;
    Ok(SignedIn { link, client_secret: client.secret })
}

/// A pasted token has no refresh and no expiry, so it stands until the vendor
/// revokes it. It is stored only once a server has taken it.
pub async fn use_token(
    service: &Service,
    token: String,
    store: &dyn TokenStore,
    account: &str,
) -> Result<Link, Error> {
    let token = token.trim().to_string();
    let mut connection = Connection::new(service.url, Some(token.clone()))?;
    connection.initialize().await.map_err(|err| match err {
        Error::ReauthRequired => Error::TokenRefused,
        other => other,
    })?;
    connection.close().await;
    store.save(account, &Tokens { access_token: token, refresh_token: None, expires_at: None })?;
    Ok(Link {
        service: service.id.to_string(),
        url: service.url.to_string(),
        token_url: String::new(),
        client_id: String::new(),
        scopes: service.read_scopes.iter().map(|scope| scope.to_string()).collect(),
        resource: service.url.to_string(),
        static_token: true,
        connected_at: Utc::now(),
    })
}

pub(crate) async fn fresh_tokens(
    link: &Link,
    client_secret: Option<String>,
    store: &dyn TokenStore,
    account: &str,
) -> Result<Tokens, Error> {
    let tokens = store.load(account)?.ok_or(Error::ReauthRequired)?;
    if tokens.expires_at.is_none_or(|at| at > Utc::now() + TimeDelta::seconds(EXPIRY_MARGIN_SECONDS)) {
        return Ok(tokens);
    }
    let refreshed = refresh_tokens(&refresh_config(link, client_secret), &tokens).await?;
    store.save(account, &refreshed)?;
    Ok(refreshed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service(read_scopes: &'static [&'static str]) -> Service {
        Service { read_scopes, ..*crate::find("linear").unwrap() }
    }

    #[test]
    fn metadata_may_describe_this_server_or_a_parent_of_it() {
        for resource in ["https://mcp.example.com/mcp", "https://mcp.example.com", "https://mcp.example.com/"] {
            assert!(check_resource("https://mcp.example.com/mcp", &json!({ "resource": resource })).is_ok(), "{resource}");
        }
        assert!(check_resource("https://mcp.example.com", &json!({ "resource": "https://mcp.example.com/" })).is_ok());
        assert!(check_resource("https://mcp.example.com/mcp", &json!({})).is_ok());
    }

    #[test]
    fn metadata_naming_another_service_is_refused() {
        for resource in ["https://mcp.linear.app/mcp", "http://mcp.example.com/mcp", "https://mcp.example.com/other", "not a url"] {
            let refused = check_resource("https://mcp.example.com/mcp", &json!({ "resource": resource }));
            assert!(matches!(refused, Err(Error::ForeignResource)), "{resource}");
        }
    }

    #[test]
    fn without_a_read_list_broad_scopes_are_left_out() {
        let challenge = Challenge { scope: Some("read write admin:org".into()), ..Challenge::default() };
        assert_eq!(choose_scopes(&service(&[]), &challenge, &Value::Null), ["read"]);
        let supported = json!({ "scopes_supported": ["files.read", "files.write", "mcp"] });
        assert_eq!(choose_scopes(&service(&[]), &Challenge::default(), &supported), ["files.read", "mcp"]);
    }

    fn refused(url: &str) -> bool {
        matches!(check_url(url, false), Err(Error::UnsafeUrl))
    }

    #[test]
    fn plain_public_https_passes() {
        assert!(!refused("https://mcp.linear.app/mcp"));
        assert!(!refused("https://8.8.8.8/x"));
        assert!(!refused("https://[2606:4700:4700::1111]/x"));
        assert!(!refused("https://[::ffff:8.8.8.8]/x"));
    }

    #[test]
    fn anything_but_https_is_refused() {
        for url in ["http://mcp.linear.app/mcp", "ftp://mcp.linear.app/", "file:///c:/windows/win.ini", "javascript:alert(1)", "not a url"] {
            assert!(refused(url), "{url}");
        }
    }

    #[test]
    fn internal_ipv4_literals_are_refused() {
        for url in [
            "https://127.0.0.1/",
            "https://127.9.9.9/",
            "https://10.0.0.1/",
            "https://172.16.0.1/",
            "https://172.31.255.255/",
            "https://192.168.1.1/",
            "https://169.254.169.254/latest/meta-data/",
            "https://0.0.0.0/",
            "https://0.1.2.3/",
            "https://100.100.100.200/",
        ] {
            assert!(refused(url), "{url}");
        }
    }

    #[test]
    fn internal_ipv6_literals_are_refused() {
        for url in ["https://[::1]/", "https://[::]/", "https://[fc00::1]/", "https://[fd12::1]/", "https://[fe80::1]/"] {
            assert!(refused(url), "{url}");
        }
    }

    #[test]
    fn v4_mapped_and_v4_compatible_addresses_are_unwrapped() {
        for url in ["https://[::ffff:127.0.0.1]/", "https://[::ffff:10.0.0.1]/", "https://[::ffff:169.254.169.254]/", "https://[::192.168.0.1]/"] {
            assert!(refused(url), "{url}");
        }
    }

    #[test]
    fn numeric_spellings_of_an_address_are_refused() {
        for url in ["https://2130706433/", "https://0x7f.0.0.1/", "https://017700000001/", "https://127.1/"] {
            assert!(refused(url), "{url}");
        }
    }

    #[test]
    fn local_names_are_refused() {
        for url in ["https://localhost/", "https://LOCALHOST/", "https://localhost./", "https://x.localhost/"] {
            assert!(refused(url), "{url}");
        }
    }

    #[test]
    fn a_public_name_that_only_looks_local_passes() {
        assert!(!refused("https://localhost.example.com/"));
    }

    #[test]
    fn user_info_cannot_disguise_the_host() {
        assert!(refused("https://mcp.linear.app@127.0.0.1/"));
    }

    #[test]
    fn loopback_is_only_for_a_loopback_service() {
        assert!(check_url("http://127.0.0.1:8080/x", true).is_ok());
        assert!(check_url("http://localhost:8080/x", true).is_ok());
        assert!(check_url("http://127.0.0.1:8080/x", false).is_err());
    }

    #[test]
    fn a_loopback_service_still_gets_nothing_else() {
        assert!(check_url("http://10.0.0.1/x", true).is_err());
        assert!(check_url("https://10.0.0.1/x", true).is_err());
        assert!(check_url("http://example.com/x", true).is_err());
        assert!(check_url("file:///c:/x", true).is_err());
    }

    #[test]
    fn resource_metadata_addresses_go_from_specific_to_root() {
        let url = Url::parse("https://mcp.example.com/v1/mcp").unwrap();
        assert_eq!(
            protected_resource_urls(&url),
            [
                "https://mcp.example.com/.well-known/oauth-protected-resource/v1/mcp",
                "https://mcp.example.com/.well-known/oauth-protected-resource",
            ]
        );
    }

    #[test]
    fn a_rootless_server_has_one_resource_metadata_address() {
        for raw in ["https://mcp.example.com", "https://mcp.example.com/"] {
            assert_eq!(
                protected_resource_urls(&Url::parse(raw).unwrap()),
                ["https://mcp.example.com/.well-known/oauth-protected-resource"]
            );
        }
    }

    #[test]
    fn a_path_issuer_tries_three_addresses_in_order() {
        let issuer = Url::parse("https://auth.example.com/tenant/1").unwrap();
        assert_eq!(
            authorization_server_urls(&issuer),
            [
                "https://auth.example.com/.well-known/oauth-authorization-server/tenant/1",
                "https://auth.example.com/.well-known/openid-configuration/tenant/1",
                "https://auth.example.com/tenant/1/.well-known/openid-configuration",
            ]
        );
    }

    #[test]
    fn a_plain_issuer_tries_two_addresses() {
        let issuer = Url::parse("https://auth.example.com/").unwrap();
        assert_eq!(
            authorization_server_urls(&issuer),
            [
                "https://auth.example.com/.well-known/oauth-authorization-server",
                "https://auth.example.com/.well-known/openid-configuration",
            ]
        );
    }

    #[test]
    fn issuers_compare_exactly_but_for_one_trailing_slash() {
        assert!(same_issuer("https://a.example", "https://a.example/"));
        assert!(same_issuer("https://a.example/", "https://a.example"));
        assert!(same_issuer("https://a.example/t", "https://a.example/t"));
        assert!(!same_issuer("https://a.example//", "https://a.example"));
        assert!(!same_issuer("https://a.example", "https://b.example"));
        assert!(!same_issuer("https://a.example/t", "https://a.example"));
        assert!(!same_issuer("", "https://a.example"));
    }

    fn with_scope(scope: &str) -> Challenge {
        Challenge { scope: Some(scope.to_string()), ..Challenge::default() }
    }

    #[test]
    fn catalog_scopes_beat_everything() {
        let document = json!({ "scopes_supported": ["c"] });
        assert_eq!(choose_scopes(&service(&["a"]), &with_scope("b"), &document), ["a"]);
    }

    #[test]
    fn the_challenge_comes_next_and_splits_on_spaces() {
        let document = json!({ "scopes_supported": ["c"] });
        assert_eq!(choose_scopes(&service(&[]), &with_scope("b  d"), &document), ["b", "d"]);
    }

    #[test]
    fn an_empty_challenge_scope_falls_through_to_the_document() {
        let document = json!({ "scopes_supported": ["c", "d"] });
        assert_eq!(choose_scopes(&service(&[]), &with_scope(" "), &document), ["c", "d"]);
    }

    #[test]
    fn no_scope_anywhere_means_none_are_asked_for() {
        assert!(choose_scopes(&service(&[]), &Challenge::default(), &Value::Null).is_empty());
    }
}
