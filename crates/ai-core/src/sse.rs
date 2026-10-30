//! Server-sent events, incrementally. Network chunks split anywhere, including
//! inside a multi-byte character, so this buffers bytes and only ever decodes
//! whole lines.

use std::time::Duration;

use futures_util::StreamExt;
use tokio_util::sync::CancellationToken;

use crate::{ErrorKind, ProviderError};

/// A stream silent for this long is treated as dead, so a stalled provider can
/// never leave the island thinking forever.
const IDLE_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Default)]
pub struct SseParser {
    buffer: Vec<u8>,
    data: Vec<String>,
}

impl SseParser {
    /// Feeds one network chunk and returns the `data` payloads it completed.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buffer.extend_from_slice(chunk);
        let mut events = Vec::new();
        while let Some(end) = self.buffer.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.buffer.drain(..=end).collect();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim_end_matches(['\r', '\n']);
            if line.is_empty() {
                if !self.data.is_empty() {
                    events.push(self.data.join("\n"));
                    self.data.clear();
                }
            } else if let Some(value) = line.strip_prefix("data:") {
                self.data.push(value.strip_prefix(' ').unwrap_or(value).to_string());
            }
            // `event:`, `id:`, `retry:` and `:` comments carry nothing we use:
            // both protocols repeat the event type inside the JSON.
        }
        events
    }
}

/// Reads an SSE body, calling `handle` per event. `handle` returns false to stop
/// early, which is how the OpenAI `[DONE]` sentinel ends the read.
pub async fn read_events(
    response: reqwest::Response,
    cancel: &CancellationToken,
    mut handle: impl FnMut(&str) -> Result<bool, ProviderError>,
) -> Result<(), ProviderError> {
    let mut parser = SseParser::default();
    let mut body = response.bytes_stream();
    loop {
        let next = tokio::select! {
            _ = cancel.cancelled() => return Err(ProviderError::cancelled()),
            next = tokio::time::timeout(IDLE_TIMEOUT, body.next()) => next,
        };
        let chunk = match next {
            Err(_) => return Err(ProviderError::new(ErrorKind::Network, "The provider stopped responding.")),
            Ok(None) => return Ok(()),
            Ok(Some(Err(err))) => return Err(ProviderError::from_reqwest(err)),
            Ok(Some(Ok(chunk))) => chunk,
        };
        for event in parser.push(&chunk) {
            if !handle(&event)? {
                return Ok(());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_events_on_blank_lines() {
        let mut p = SseParser::default();
        assert_eq!(p.push(b"data: one\n\ndata: two\n\n"), ["one", "two"]);
    }

    #[test]
    fn survives_chunks_split_anywhere() {
        let mut p = SseParser::default();
        assert!(p.push(b"da").is_empty());
        assert!(p.push(b"ta: he").is_empty());
        assert_eq!(p.push(b"llo\n\n"), ["hello"]);
    }

    #[test]
    fn survives_a_character_split_across_chunks() {
        let text = "data: héllo\n\n".as_bytes();
        let cut = text.iter().position(|b| *b == 0xC3).unwrap() + 1;
        let mut p = SseParser::default();
        assert!(p.push(&text[..cut]).is_empty());
        assert_eq!(p.push(&text[cut..]), ["héllo"]);
    }

    #[test]
    fn handles_crlf_comments_and_event_names() {
        let mut p = SseParser::default();
        assert_eq!(p.push(b": ping\r\nevent: delta\r\ndata: x\r\n\r\n"), ["x"]);
    }

    #[test]
    fn joins_multi_line_data() {
        let mut p = SseParser::default();
        assert_eq!(p.push(b"data: a\ndata: b\n\n"), ["a\nb"]);
    }
}
