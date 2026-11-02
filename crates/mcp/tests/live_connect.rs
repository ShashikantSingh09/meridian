//! Runs the real Connect flow against each real service, as far as the moment the browser would
//! open, which needs no account. A service that reaches that point works with one click.
//!
//!     cargo test -p mcp --test live_connect -- --ignored --nocapture

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use activity::{TokenStore, Tokens};
use mcp::{catalog, sign_in, Access};
use reqwest::Url;

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

#[tokio::test]
#[ignore = "calls every real service, and registers a client with those that offer it"]
async fn says_which_services_reach_the_browser() {
    for service in catalog().iter().filter(|service| service.access == Access::Open) {
        let opened = Arc::new(Mutex::new(None));
        let seen = opened.clone();
        let open = move |url: &str| {
            *seen.lock().unwrap() = Some(url.to_string());
            Ok(())
        };
        let store = MemoryTokens::default();
        let outcome = tokio::time::timeout(Duration::from_secs(20), sign_in(service, None, &store, "probe", open, Duration::from_millis(50))).await;
        let url = opened.lock().unwrap().clone();
        match url {
            Some(url) => {
                let parsed = Url::parse(&url).unwrap();
                let pairs: HashMap<_, _> = parsed.query_pairs().into_owned().collect();
                let scope = pairs.get("scope").map_or("-", String::as_str);
                println!("{:10} OPENS {} scope {scope}", service.id, parsed.host_str().unwrap_or("?"));
            }
            None => println!("{:10} STOPS {}", service.id, outcome.map_or("timed out".to_string(), |result| result.err().map_or("no browser".to_string(), |err| err.to_string()))),
        }
    }
}
