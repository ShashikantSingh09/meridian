//! A real socket that plays back canned HTTP responses, so adapter tests cover
//! actual reqwest behaviour rather than a mock of it.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

pub struct Canned {
    status: u16,
    content_type: &'static str,
    chunks: Vec<String>,
    hang: bool,
}

impl Canned {
    pub fn sse(events: &[&str]) -> Self {
        Self {
            status: 200,
            content_type: "text/event-stream",
            chunks: events.iter().map(|e| format!("{e}\n\n")).collect(),
            hang: false,
        }
    }

    pub fn hanging(event: &str) -> Self {
        Self { hang: true, ..Self::sse(&[event]) }
    }

    pub fn json(body: &str) -> Self {
        Self { status: 200, content_type: "application/json", chunks: vec![body.into()], hang: false }
    }

    pub fn status(status: u16, body: &str) -> Self {
        Self { status, ..Self::json(body) }
    }
}

async fn read_request(socket: &mut tokio::net::TcpStream) -> String {
    let mut raw = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        let n = socket.read(&mut buf).await.unwrap_or(0);
        raw.extend_from_slice(&buf[..n]);
        let text = String::from_utf8_lossy(&raw).to_string();
        if let Some(head_end) = text.find("\r\n\r\n") {
            let length = text[..head_end]
                .lines()
                .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length: ")?.parse::<usize>().ok())
                .unwrap_or(0);
            if raw.len() >= head_end + 4 + length {
                return text;
            }
        }
        if n == 0 {
            return text;
        }
    }
}

/// Serves `responses` in order, one per connection. Returns the base URL and
/// the raw requests received.
pub async fn serve(responses: Vec<Canned>) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    tokio::spawn(async move {
        for canned in responses {
            let Ok((mut socket, _)) = listener.accept().await else { return };
            let request = read_request(&mut socket).await;
            log.lock().unwrap().push(request);
            let head = format!(
                "HTTP/1.1 {} X\r\ncontent-type: {}\r\nconnection: close\r\n\r\n",
                canned.status, canned.content_type
            );
            let _ = socket.write_all(head.as_bytes()).await;
            for chunk in &canned.chunks {
                let _ = socket.write_all(chunk.as_bytes()).await;
                let _ = socket.flush().await;
            }
            if canned.hang {
                tokio::time::sleep(Duration::from_secs(30)).await;
            }
        }
    });
    (url, seen)
}
