//! Gmail, read-only. The search below keeps the first sync to mail that could
//! hold something, rather than downloading the mailbox.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{DateTime, Utc};
use serde_json::Value;

use super::{Profile, Session};
use crate::event::SourceRef;
use crate::extract::Message;
use crate::Error;

pub const BASE_URL: &str = "https://gmail.googleapis.com";

/// Gmail's `{a b}` means a OR b.
const LIKELY_MAIL: &str = "{category:reservations category:purchases category:updates filename:ics \
                           subject:booking subject:reservation subject:itinerary subject:flight subject:hotel \
                           subject:order subject:shipped subject:delivery subject:tracking subject:invoice \
                           subject:payment subject:renewal subject:subscription subject:appointment}";

/// History hands back every new message, so these labels stand in for the
/// search above on incremental sync without a request per message.
const SKIPPED_LABELS: &[&str] =
    &["SPAM", "TRASH", "DRAFT", "SENT", "CHAT", "CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_FORUMS"];

pub struct Gmail {
    session: Session,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessagePage {
    pub ids: Vec<String>,
    pub next_page: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryPage {
    pub added: Vec<String>,
    pub next_page: Option<String>,
    pub history_id: Option<String>,
}

fn string(value: &Value) -> Option<String> {
    value.as_str().map(str::to_string)
}

impl Gmail {
    pub fn new(session: Session) -> Self {
        Self { session }
    }

    pub fn account(&self) -> &str {
        self.session.account()
    }

    pub async fn profile(&self) -> Result<Profile, Error> {
        let value = self.session.get("gmail/v1/users/me/profile", &[]).await?;
        Ok(Profile { email: string(&value["emailAddress"]), display_name: None })
    }

    /// Where the mailbox is now, taken before a first listing so that nothing
    /// arriving during it falls between the listing and incremental sync.
    pub async fn current_history_id(&self) -> Result<String, Error> {
        let value = self.session.get("gmail/v1/users/me/profile", &[]).await?;
        string(&value["historyId"]).ok_or(Error::Malformed("Gmail profile"))
    }

    /// A bounded search over mail from the last `window_days`.
    pub async fn list_messages(&self, window_days: u32, page: Option<&str>, size: u32) -> Result<MessagePage, Error> {
        let mut query = vec![("q", format!("newer_than:{window_days}d {LIKELY_MAIL}")), ("maxResults", size.to_string())];
        if let Some(page) = page {
            query.push(("pageToken", page.to_string()));
        }
        let value = self.session.get("gmail/v1/users/me/messages", &query).await?;
        let listed = value["messages"].as_array().map(Vec::as_slice).unwrap_or_default();
        Ok(MessagePage {
            ids: listed.iter().filter_map(|m| string(&m["id"])).collect(),
            next_page: string(&value["nextPageToken"]),
        })
    }

    /// A 404 means the start id has aged out, which Gmail reports differently
    /// from a missing message: [`Error::CursorExpired`] tells sync to start over.
    pub async fn history(&self, start: &str, page: Option<&str>) -> Result<HistoryPage, Error> {
        let mut query = vec![("startHistoryId", start.to_string()), ("historyTypes", "messageAdded".to_string())];
        if let Some(page) = page {
            query.push(("pageToken", page.to_string()));
        }
        let value = match self.session.get("gmail/v1/users/me/history", &query).await {
            Err(Error::NotFound) => return Err(Error::CursorExpired),
            other => other?,
        };
        let records = value["history"].as_array().map(Vec::as_slice).unwrap_or_default();
        let mut added = Vec::new();
        for record in records {
            for entry in record["messagesAdded"].as_array().map(Vec::as_slice).unwrap_or_default() {
                let message = &entry["message"];
                let labels = message["labelIds"].as_array().map(Vec::as_slice).unwrap_or_default();
                let skipped = labels.iter().any(|l| l.as_str().is_some_and(|l| SKIPPED_LABELS.contains(&l)));
                if let (Some(id), false) = (string(&message["id"]), skipped) {
                    if !added.contains(&id) {
                        added.push(id);
                    }
                }
            }
        }
        Ok(HistoryPage { added, next_page: string(&value["nextPageToken"]), history_id: string(&value["historyId"]) })
    }

    /// `None` when the message has gone since it was listed: the user deleted
    /// it, which must not fail the whole sync.
    pub async fn get_message(&self, id: &str) -> Result<Option<Message>, Error> {
        let path = format!("gmail/v1/users/me/messages/{id}");
        let value = match self.session.get(&path, &[("format", "full".to_string())]).await {
            Err(Error::NotFound) => return Ok(None),
            other => other?,
        };
        let mut parts = Parts::default();
        collect_parts(&value["payload"], &mut parts);
        if parts.calendar.is_none() {
            if let Some(attachment) = &parts.calendar_attachment {
                let path = format!("gmail/v1/users/me/messages/{id}/attachments/{attachment}");
                let body = self.session.get(&path, &[]).await?;
                parts.calendar = body["data"].as_str().and_then(decode);
            }
        }
        let received_at = value["internalDate"]
            .as_str()
            .and_then(|ms| ms.parse().ok())
            .and_then(DateTime::<Utc>::from_timestamp_millis)
            .ok_or(Error::Malformed("Gmail message"))?;
        let from = header(&value, "From").unwrap_or_default();
        let subject = header(&value, "Subject").unwrap_or_default();
        let account = self.session.account();
        let link = format!("https://mail.google.com/mail/?authuser={account}#all/{id}");
        Ok(Some(Message {
            source_ref: SourceRef {
                account: account.to_string(),
                message_id: id.to_string(),
                subject: subject.clone(),
                received_at,
                link: Some(link),
            },
            from,
            subject,
            received_at,
            text: parts.text,
            html: parts.html,
            calendar: parts.calendar,
        }))
    }
}

fn header(message: &Value, name: &str) -> Option<String> {
    let headers = message["payload"]["headers"].as_array()?;
    let found = headers.iter().find(|h| h["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(name)))?;
    string(&found["value"])
}

#[derive(Default)]
struct Parts {
    text: Option<String>,
    html: Option<String>,
    calendar: Option<String>,
    calendar_attachment: Option<String>,
}

/// Gmail's base64url may or may not be padded. Bytes that are not UTF-8 stay
/// readable enough for extraction rather than losing the whole message.
fn decode(data: &str) -> Option<String> {
    let bytes = URL_SAFE_NO_PAD.decode(data.trim_end_matches('=')).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// Walks the MIME tree. The first body of each type wins, an attached .txt is
/// not the message body, and an invite may sit behind an attachment id.
fn collect_parts(part: &Value, parts: &mut Parts) {
    let mime = part["mimeType"].as_str().unwrap_or_default().to_ascii_lowercase();
    let attached = part["filename"].as_str().is_some_and(|name| !name.is_empty());
    let data = part["body"]["data"].as_str().and_then(decode);
    match mime.as_str() {
        "text/plain" if !attached && parts.text.is_none() => parts.text = data,
        "text/html" if !attached && parts.html.is_none() => parts.html = data,
        "text/calendar" | "application/ics" if parts.calendar.is_none() => {
            parts.calendar = data;
            if parts.calendar.is_none() && parts.calendar_attachment.is_none() {
                parts.calendar_attachment = string(&part["body"]["attachmentId"]);
            }
        }
        _ => {}
    }
    for child in part["parts"].as_array().map(Vec::as_slice).unwrap_or_default() {
        collect_parts(child, parts);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn encoded(text: &str) -> String {
        URL_SAFE_NO_PAD.encode(text)
    }

    #[test]
    fn decodes_with_or_without_padding_and_url_safe_characters() {
        assert_eq!(decode("aGk").as_deref(), Some("hi"));
        assert_eq!(decode("aGk=").as_deref(), Some("hi"));
        assert_eq!(decode(&encoded("a?>b~")).as_deref(), Some("a?>b~"));
        assert_eq!(decode("***"), None);
    }

    #[test]
    fn walks_nested_multipart_and_skips_attachments() {
        let payload = json!({
            "mimeType": "multipart/mixed",
            "parts": [
                { "mimeType": "multipart/alternative", "parts": [
                    { "mimeType": "text/plain", "filename": "", "body": { "data": encoded("plain") } },
                    { "mimeType": "multipart/related", "parts": [
                        { "mimeType": "text/html", "filename": "", "body": { "data": encoded("<p>html</p>") } }
                    ]}
                ]},
                { "mimeType": "text/plain", "filename": "notes.txt", "body": { "attachmentId": "a1" } },
                { "mimeType": "text/calendar", "filename": "invite.ics", "body": { "attachmentId": "a2" } }
            ]
        });
        let mut parts = Parts::default();
        collect_parts(&payload, &mut parts);
        assert_eq!(parts.text.as_deref(), Some("plain"));
        assert_eq!(parts.html.as_deref(), Some("<p>html</p>"));
        assert_eq!(parts.calendar, None);
        assert_eq!(parts.calendar_attachment.as_deref(), Some("a2"));
    }

    #[test]
    fn an_attached_text_file_is_not_the_body() {
        let payload = json!({ "mimeType": "multipart/mixed", "parts": [
            { "mimeType": "text/plain", "filename": "log.txt", "body": { "data": encoded("attachment") } },
            { "mimeType": "text/html", "filename": "", "body": { "data": encoded("<p>real</p>") } }
        ]});
        let mut parts = Parts::default();
        collect_parts(&payload, &mut parts);
        assert_eq!(parts.text, None);
        assert_eq!(parts.html.as_deref(), Some("<p>real</p>"));
    }

    #[test]
    fn a_corrupt_part_is_absent_rather_than_fatal() {
        let payload = json!({ "mimeType": "text/plain", "filename": "", "body": { "data": "***" } });
        let mut parts = Parts::default();
        collect_parts(&payload, &mut parts);
        assert_eq!(parts.text, None);
    }
}
