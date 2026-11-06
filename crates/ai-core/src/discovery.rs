//! Finds model servers already running on this machine.

use std::time::Duration;

use futures_util::future::join_all;
use serde::Serialize;

use crate::catalog::{catalog, Kind};
use crate::{client, Endpoint};

const PROBE_TIMEOUT: Duration = Duration::from_millis(700);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalServer {
    pub provider_id: String,
    pub base_url: String,
    pub models: Vec<String>,
}

async fn probe(id: &str, base_url: String, api_key: Option<String>) -> Option<LocalServer> {
    let def = crate::find(id)?;
    let provider = client(def.protocol, Endpoint { base_url: base_url.clone(), api_key }).ok()?;
    let models = tokio::time::timeout(PROBE_TIMEOUT, provider.models()).await.ok()?.ok()?;
    Some(LocalServer { provider_id: id.to_string(), base_url, models: models.into_iter().map(|m| m.id).collect() })
}

/// Probes every local provider at the address `resolve` gives for it, with the key `key` gives,
/// for a server on another machine that asks for one. Silent ports are simply absent from the result.
pub async fn discover(resolve: impl Fn(&str) -> Option<String>, key: impl Fn(&str) -> Option<String>) -> Vec<LocalServer> {
    let probes = catalog()
        .iter()
        .filter(|p| p.kind == Kind::Local)
        .map(|p| probe(p.id, resolve(p.id).unwrap_or_else(|| p.base_url.to_string()), key(p.id)));
    join_all(probes).await.into_iter().flatten().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_server::{serve, Canned};

    #[tokio::test]
    async fn an_unrelated_web_server_is_not_a_model_server() {
        let (url, _) = serve(vec![Canned::json("<html>some other app</html>")]).await;
        let found = discover(|id| match id {
            "llamacpp" => Some(url.clone()),
            _ => Some("http://127.0.0.1:9/v1".to_string()),
        }, |_| None)
        .await;
        assert!(found.is_empty());
    }

    #[tokio::test]
    async fn an_empty_model_list_still_counts_as_a_server() {
        let (url, _) = serve(vec![Canned::json(r#"{"data":[]}"#)]).await;
        let found = discover(|id| match id {
            "lmstudio" => Some(url.clone()),
            _ => Some("http://127.0.0.1:9/v1".to_string()),
        }, |_| None)
        .await;
        assert_eq!(found.len(), 1);
    }

    #[tokio::test]
    async fn finds_a_running_server_and_ignores_silent_ports() {
        let (url, _) = serve(vec![Canned::json(r#"{"data":[{"id":"phi-4"}]}"#)]).await;
        let found = discover(|id| match id {
            "lmstudio" => Some(url.clone()),
            _ => Some("http://127.0.0.1:9/v1".to_string()),
        }, |_| None)
        .await;
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].provider_id, "lmstudio");
        assert_eq!(found[0].models, ["phi-4"]);
    }

    #[tokio::test]
    async fn a_server_that_asks_for_a_key_gets_its_own() {
        let (url, seen) = serve(vec![Canned::json(r#"{"data":[{"id":"llama3"}]}"#)]).await;
        let found = discover(
            |id| Some(if id == "ollama" { url.clone() } else { "http://127.0.0.1:9/v1".to_string() }),
            |id| (id == "ollama").then(|| "lan-secret".to_string()),
        )
        .await;
        assert_eq!(found.len(), 1);
        assert!(seen.lock().unwrap()[0].to_ascii_lowercase().contains("authorization: bearer lan-secret"));
    }
}
