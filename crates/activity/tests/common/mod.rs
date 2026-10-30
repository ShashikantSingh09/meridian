//! A real socket that plays back canned HTTP responses, so connector tests cover
//! actual reqwest behaviour rather than a mock of it.

use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

pub struct Canned {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

impl Canned {
    pub fn json(body: impl Into<String>) -> Self {
        Self { status: 200, headers: Vec::new(), body: body.into() }
    }

    pub fn status(status: u16, body: impl Into<String>) -> Self {
        Self { status, ..Self::json(body) }
    }

    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_string(), value.to_string()));
        self
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

/// Serves `responses` in order, one per connection, replacing `{base}` in each
/// body with the server's own URL. Returns that URL and the raw requests. A
/// request past the last response is refused, which fails a test that made one.
pub async fn serve(responses: Vec<Canned>) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    let base = url.clone();
    tokio::spawn(async move {
        for canned in responses {
            let Ok((mut socket, _)) = listener.accept().await else { return };
            let request = read_request(&mut socket).await;
            log.lock().unwrap().push(request);
            let body = canned.body.replace("{base}", &base);
            let mut head = format!(
                "HTTP/1.1 {} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n",
                canned.status,
                body.len()
            );
            for (name, value) in &canned.headers {
                head.push_str(&format!("{name}: {value}\r\n"));
            }
            head.push_str("\r\n");
            let _ = socket.write_all(head.as_bytes()).await;
            let _ = socket.write_all(body.as_bytes()).await;
            let _ = socket.flush().await;
        }
    });
    (url, seen)
}
