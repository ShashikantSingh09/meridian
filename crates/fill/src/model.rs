//! What a fill works on: the boxes in a window, and the window itself. Nothing here
//! is Windows-only, so a Mac reader fills the same types.

use serde::Serialize;

/// Narrower or shorter than this is not a box a person can see or use. Pages hide
/// trap fields this way, so a reader drops them.
pub const MIN_SIDE: i32 = 4;

/// The most of a box's text a read keeps. The AI needs the start of a draft, not a whole document.
pub const MAX_VALUE: usize = 4_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FieldKind {
    PlainText,
    MultiLine,
    /// A rich editor or document surface: the Gmail body, Slack, Word. Always pasted.
    RichText,
    Number,
    Email,
    Phone,
    Date,
    List,
    Checkbox,
    Radio,
    Password,
    File,
    Button,
    /// Only Finish this for me reads these. A link's value is where it goes.
    Link,
    Tab,
    MenuItem,
    /// A row of a list or tree.
    Item,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Bounds {
    pub fn big_enough(&self) -> bool {
        self.width >= MIN_SIDE && self.height >= MIN_SIDE
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Field {
    /// Stable for one read: the box's place in page order. A new read starts again.
    pub id: u32,
    /// What the box is called: its name, else the label pointing at it, else its placeholder.
    pub label: String,
    pub placeholder: String,
    /// The author's id for the box (the HTML id on the web), which often names its purpose.
    pub automation_id: String,
    pub kind: FieldKind,
    pub required: bool,
    pub visible: bool,
    /// What it holds now. Always empty for a box Meridian never fills.
    pub value: String,
    pub bounds: Bounds,
}

impl Field {
    /// The last step of every read, on every platform: the kind sharpened from the
    /// box's words, and no value kept for a box Meridian never fills, so a typed card
    /// number never reaches the AI.
    pub fn finish(mut self) -> Self {
        self.label = self.label.trim().to_string();
        self.kind = refine(self.kind, &self.words());
        if crate::policy::refusal(&self).is_some() {
            self.value.clear();
        }
        if self.value.chars().count() > MAX_VALUE {
            self.value = self.value.chars().take(MAX_VALUE).collect();
        }
        self
    }

    /// Label, placeholder and id as one string of lowercase words.
    pub(crate) fn words(&self) -> String {
        words(&format!("{} {} {}", self.label, self.placeholder, self.automation_id))
    }
}

/// The window a fill would work in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Target {
    /// Executable name, such as chrome.exe.
    pub process: String,
    pub title: String,
    /// For a browser, the site from the address bar, such as kestrellabs.in, or
    /// "chrome:" for pages that are not on the web. None when it could not be read.
    pub site: Option<String>,
}

/// Lowercase words separated by single spaces, with a space at each end, so a phrase
/// matches only as whole words. Splits `cardNumber` and `cc-number` the same way.
/// Devanagari is kept as it is: its vowel signs and virama are not punctuation.
pub(crate) fn words(text: &str) -> String {
    let mut out = String::from(" ");
    let mut lower_before = false;
    for c in text.chars() {
        if c.is_ascii_uppercase() && lower_before {
            out.push(' ');
        }
        lower_before = c.is_ascii_lowercase();
        let gap = c.is_whitespace()
            || c.is_ascii_punctuation()
            || matches!(c, '।' | '॥' | '…' | '–' | '—' | '‘' | '’' | '“' | '”' | '·' | '•' | '₹');
        if !gap {
            out.extend(c.to_lowercase());
        } else if !out.ends_with(' ') {
            out.push(' ');
        }
    }
    if !out.ends_with(' ') {
        out.push(' ');
    }
    out
}

/// True when `words` (from [`words`]) holds any of the phrases as whole words.
pub(crate) fn has_any(words: &str, phrases: &[&str]) -> bool {
    phrases.iter().any(|phrase| words.contains(&format!(" {phrase} ")))
}

const EMAIL: &[&str] = &["email", "e mail", "mail id", "ईमेल", "ई मेल"];
const PHONE: &[&str] = &[
    "phone", "mobile", "telephone", "tel", "contact number", "whatsapp", "फ़ोन", "फोन", "मोबाइल", "दूरभाष",
];
const DATE: &[&str] = &[
    "date", "dob", "birthday", "dd mm yyyy", "mm dd yyyy", "yyyy mm dd", "dd mm yy", "तारीख", "तिथि", "दिनांक",
];
const UPLOAD: &[&str] = &[
    "upload", "attach", "attachment", "choose file", "choose files", "browse", "select file", "file", "अपलोड",
    "संलग्न", "फ़ाइल", "फाइल",
];

/// Web pages do not tell UI Automation an input's type, so email, phone and date
/// boxes are known by their words. A file input shows up as a button.
fn refine(kind: FieldKind, words: &str) -> FieldKind {
    match kind {
        FieldKind::PlainText if has_any(words, DATE) => FieldKind::Date,
        FieldKind::PlainText if has_any(words, EMAIL) => FieldKind::Email,
        FieldKind::PlainText if has_any(words, PHONE) => FieldKind::Phone,
        FieldKind::Button if has_any(words, UPLOAD) => FieldKind::File,
        kind => kind,
    }
}

/// The site in an address bar's text: the host without "www.", or "scheme:" for a
/// page that is not on the web. None for a search being typed, or nothing.
pub fn site_from_address(address: &str) -> Option<String> {
    let text = address.trim().to_lowercase();
    if text.is_empty() || text.contains(char::is_whitespace) {
        return None;
    }
    let rest = match text.split_once("://") {
        Some(("http" | "https", rest)) => rest,
        Some((scheme, _)) => return Some(format!("{scheme}:")),
        None => match text.split_once(':') {
            Some((scheme @ ("about" | "data" | "javascript" | "view-source" | "blob" | "mailto"), _)) => {
                return Some(format!("{scheme}:"))
            }
            _ => text.as_str(),
        },
    };
    let host = rest.split(['/', '?', '#']).next()?;
    let host = host.rsplit('@').next()?;
    let host = match host.rsplit_once(':') {
        Some((name, port)) if port.chars().all(|c| c.is_ascii_digit()) => name,
        _ => host,
    };
    let host = host.trim_end_matches('.');
    let host = host.strip_prefix("www.").unwrap_or(host);
    let looks_like_host = (host.contains('.') || host == "localhost")
        && host.chars().all(|c| c.is_alphanumeric() || c == '.' || c == '-');
    looks_like_host.then(|| host.to_string())
}

#[cfg(test)]
pub(crate) fn field(id: u32, label: &str, kind: FieldKind) -> Field {
    Field {
        id,
        label: label.into(),
        placeholder: String::new(),
        automation_id: String::new(),
        kind,
        required: false,
        visible: true,
        value: String::new(),
        bounds: Bounds { x: 0, y: 0, width: 200, height: 24 },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_split_ids_and_keep_hindi_whole() {
        assert_eq!(words("cardNumber"), " card number ");
        assert_eq!(words("cc-number"), " cc number ");
        assert_eq!(words("Full name *"), " full name ");
        assert_eq!(words("पासवर्ड डालें।"), " पासवर्ड डालें ");
    }

    #[test]
    fn phrases_match_whole_words_only() {
        assert!(has_any(&words("Start date"), &["date"]));
        assert!(!has_any(&words("Update your candidate profile"), &["date"]));
    }

    #[test]
    fn email_phone_date_and_upload_boxes_are_known_by_their_words() {
        let finished = |label: &str, kind| field(0, label, kind).finish().kind;
        assert_eq!(finished("Email", FieldKind::PlainText), FieldKind::Email);
        assert_eq!(finished("मोबाइल नंबर", FieldKind::PlainText), FieldKind::Phone);
        assert_eq!(finished("Date of birth", FieldKind::PlainText), FieldKind::Date);
        assert_eq!(finished("Your CV Choose File No file chosen", FieldKind::Button), FieldKind::File);
        assert_eq!(finished("Submit application", FieldKind::Button), FieldKind::Button);
        assert_eq!(finished("Full name", FieldKind::PlainText), FieldKind::PlainText);
    }

    #[test]
    fn a_box_meridian_never_fills_keeps_no_value() {
        let mut card = field(0, "Card number", FieldKind::PlainText);
        card.value = "4111 1111 1111 1111".into();
        assert_eq!(card.finish().value, "");
    }

    #[test]
    fn a_long_value_is_cut_short() {
        let mut draft = field(0, "Message", FieldKind::RichText);
        draft.value = "a".repeat(MAX_VALUE + 10);
        assert_eq!(draft.finish().value.len(), MAX_VALUE);
    }

    #[test]
    fn the_site_is_read_from_the_address_bar() {
        assert_eq!(site_from_address("kestrellabs.in/careers/apply").as_deref(), Some("kestrellabs.in"));
        assert_eq!(site_from_address("https://www.onlinesbi.sbi/retail").as_deref(), Some("onlinesbi.sbi"));
        assert_eq!(site_from_address("HTTP://user:pw@Mail.Google.com:443/#inbox").as_deref(), Some("mail.google.com"));
        assert_eq!(site_from_address("localhost:3000/form").as_deref(), Some("localhost"));
        assert_eq!(site_from_address("chrome://settings/passwords").as_deref(), Some("chrome:"));
        assert_eq!(site_from_address("file:///G:/tests/fill/forms.html").as_deref(), Some("file:"));
        assert_eq!(site_from_address("about:blank").as_deref(), Some("about:"));
    }

    #[test]
    fn a_search_being_typed_is_not_a_site() {
        assert_eq!(site_from_address("weather in pune"), None);
        assert_eq!(site_from_address("pune"), None);
        assert_eq!(site_from_address("  "), None);
    }
}
