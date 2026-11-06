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
    /// What the box is called: its name, else the label pointing at it, else its placeholder, else
    /// the words just before it on the page (see `label_of`). "One-time code" for a cell of a split code.
    pub label: String,
    /// Its placeholder, else the hint the page ties to it (aria-describedby).
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
    "upload", "attach", "attachment", "choose file", "choose files", "browse", "select file", "file",
    // A file box takes its label for its name, so "Your CV *" is all a button says.
    "cv", "resume", "résumé", "बायोडाटा", "अपलोड",
    "संलग्न", "फ़ाइल", "फाइल",
];

/// The platform's own name for a control, as far as telling a box's kind needs. Windows maps UI
/// Automation's control types onto these; a Mac reader would map AX roles.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum Control {
    Edit,
    Document,
    /// A group, pane or custom control: a container, or a bare editable area.
    Group,
    ComboBox,
    List,
    CheckBox,
    RadioButton,
    Spinner,
    Button,
    Hyperlink,
    TabItem,
    MenuItem,
    ListItem,
    TreeItem,
    #[default]
    Other,
}

/// What the platform says about one control.
#[derive(Debug, Clone, Default)]
pub(crate) struct Props {
    pub control: Control,
    /// The page's role for it, lowercase: "textbox", "searchbox", "combobox", "switch", "list". Chrome,
    /// Edge and Firefox give it in every language. Empty outside a web page.
    pub role: String,
    /// The page's ARIA states as the browser lists them, such as "haspopup=listbox;expanded=false".
    pub aria: String,
    /// The control type in the user's language, lowercase. Only Chrome's "date picker" is read from it.
    pub localized: String,
    pub class: String,
    pub automation_id: String,
    pub password: bool,
    pub value_pattern: bool,
    pub read_only: bool,
    /// Text boxes and documents have the text pattern; drop-downs, lists and buttons never do.
    pub text_pattern: bool,
    pub multiline: bool,
    pub selectable: bool,
    pub focusable: bool,
    pub focused: bool,
    /// The box shows nothing yet.
    pub empty: bool,
    /// A spin button inside a date box: Chrome's Day, Month and Year parts of one date.
    pub in_date: bool,
}

/// Pickers that look like a text box but keep only a choice from their list: what is typed and not
/// picked is gone once the box loses the cursor, so typing would look filled and then empty. Known by
/// the class or id their library gives them (MUI Autocomplete, Ant Design, Select2, Chosen, vue-select,
/// React-Select, Choices.js).
const PICKERS: &[&str] = &["muiautocomplete", "ant-select", "select2", "chosen-search", "vs__search", "react-select", "choices__input"];

fn picker(p: &Props) -> bool {
    let named = format!("{} {}", p.class, p.automation_id).to_lowercase();
    PICKERS.iter().any(|marker| named.contains(marker))
}

/// A box's kind from what the platform says about it, or None when it is not a box. `children` is
/// asked only for a many-line text box, since it costs a round trip.
pub(crate) fn kind_of(p: &Props, children: impl FnOnce() -> bool) -> Option<FieldKind> {
    let role = p.role.as_str();
    let kind = match p.control {
        // A switch is a tick box that slides. Chrome and Edge call it a button with a toggle.
        _ if role == "switch" => FieldKind::Checkbox,
        Control::Edit if p.password => FieldKind::Password,
        // A contenteditable editor has its paragraphs as children; a textarea has none. Empty, Chrome shows
        // the two exactly alike, so an empty many-line box on a page is pasted into as an editor: a direct
        // set would show in Gmail's or Slack's box without reaching what they send.
        Control::Edit if p.class.contains("RichEdit") || (p.multiline && (children() || (!role.is_empty() && p.empty))) => FieldKind::RichText,
        Control::Edit if p.multiline => FieldKind::MultiLine,
        Control::Edit if p.localized.contains("date") || p.localized.contains("time") => FieldKind::Date,
        Control::Edit if role == "spinbutton" => FieldKind::Number,
        Control::Edit => FieldKind::PlainText,
        // Word's body, or a page's own editable area. A whole web page is not a box.
        Control::Document if p.focused && p.automation_id != "RootWebArea" => FieldKind::RichText,
        // A bare contenteditable shows as a group that holds text.
        Control::Group if p.focused && p.text_pattern => FieldKind::RichText,
        // An input with suggestions, such as an email box offering domains, reports as a combo box. It
        // takes typing, so it has the text pattern; a drop-down of fixed choices never does. On a page
        // the value pattern cannot tell them apart: Chrome gives a plain <select> one that is not read-only.
        Control::ComboBox if p.text_pattern && !picker(p) => FieldKind::PlainText,
        // A desktop app's drop-down you can type in says so in its value.
        Control::ComboBox if role.is_empty() && p.value_pattern && !p.read_only => FieldKind::PlainText,
        Control::ComboBox => FieldKind::List,
        // A page's bulleted list, and the open list under a <select>, are words, not boxes.
        Control::List if role == "list" => return None,
        // A list you can pick from can be selected in or focused.
        Control::List if p.selectable || p.focusable => FieldKind::List,
        Control::List => return None,
        Control::CheckBox => FieldKind::Checkbox,
        Control::RadioButton => FieldKind::Radio,
        // The Day, Month and Year of a date box are that one box.
        Control::Spinner if p.in_date => return None,
        Control::Spinner => FieldKind::Number,
        // A button that opens a list of choices is a drop-down the page built itself (Headless UI, MUI).
        // A button with aria-pressed stays a button: "Like" and "Follow" are toggles too.
        Control::Button if p.aria.split(';').any(|state| state.trim() == "haspopup=listbox") => FieldKind::List,
        Control::Button => FieldKind::Button,
        // Only Finish this for me asks for these.
        Control::Hyperlink => FieldKind::Link,
        Control::TabItem => FieldKind::Tab,
        Control::MenuItem => FieldKind::MenuItem,
        Control::ListItem | Control::TreeItem => FieldKind::Item,
        Control::Group | Control::Document | Control::Other => return None,
    };
    // A link's address is read-only, and is what tells where it goes. A file box is a button whose value,
    // "No file chosen", is read-only too: it stays, as the user's to fill.
    if p.read_only && !matches!(kind, FieldKind::List | FieldKind::Link | FieldKind::Tab | FieldKind::MenuItem | FieldKind::Item | FieldKind::Button) {
        return None;
    }
    Some(kind)
}

/// Text that says something: a lone "*" or ":" is not a label.
pub(crate) fn says(text: &str) -> bool {
    text.chars().any(char::is_alphanumeric)
}

/// What a box is called: its accessible name, else the element that labels it, else its placeholder,
/// else the text just before it on the page. The later two cost round trips, so each is asked only
/// when everything before it said nothing. `hint` is what an unnamed drop-down shows ("Month"),
/// added to the text before it, so a three-part date reads "Date of birth: Month".
pub(crate) fn label_of(name: &str, placeholder: &str, hint: Option<&str>, labelled_by: impl FnOnce() -> String, nearby: impl FnOnce() -> String) -> String {
    if says(name) {
        return name.trim().to_string();
    }
    let by = labelled_by();
    if says(&by) {
        return by.trim().to_string();
    }
    if says(placeholder) {
        return placeholder.trim().to_string();
    }
    let near = nearby();
    match (says(&near), hint) {
        (true, Some(hint)) => format!("{}: {hint}", near.trim()),
        (true, None) => near.trim().to_string(),
        (false, Some(hint)) => hint.to_string(),
        (false, None) => String::new(),
    }
}

const PROMPTS: &[&str] = &[
    "day", "month", "year", "dd", "mm", "yyyy", "yy", "select", "choose", "pick", "दिन", "माह", "महीना", "वर्ष",
    "साल", "चुनें",
];

/// What an unnamed drop-down shows that says what it asks: its first choice when that is a prompt
/// ("Month", "Select city"), or "Country code" for the "+91" beside a phone box. A real choice is no hint.
pub(crate) fn list_hint(value: &str) -> Option<String> {
    let value = value.trim();
    let digits = value.chars().filter(char::is_ascii_digit).count();
    let dial = value.split('+').nth(1).is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_digit()));
    if dial && (1..=4).contains(&digits) && value.chars().count() <= 24 {
        return Some("Country code".into());
    }
    has_any(&words(value), PROMPTS).then(|| value.to_string())
}

/// A label that marks its box as needed: "Email *", "* Full name", "Phone (required)", "अनिवार्य".
pub(crate) fn marked_required(label: &str) -> bool {
    let label = label.trim();
    label.starts_with('*') || label.ends_with('*') || label.contains(" *") || has_any(&words(label), &["required", "mandatory", "अनिवार्य", "आवश्यक"])
}

/// Where a styled tick box really is. Pages shrink the real input to one pixel and draw a card, a
/// chip or a switch around it, so a tiny named tick counts when its parent is on screen and holds
/// it. A tiny tick in a hidden or off-screen part stays out, as a trap would.
// ponytail: a parent taller than this is the whole group, not the card, so the outline goes on the
// tick's own spot, grown to a size you can see. Measure on real choice cards if outlines look wrong.
const CARD_HEIGHT: i32 = 240;

pub(crate) fn tick_bounds(own: Bounds, parent: Option<Bounds>) -> Option<Bounds> {
    if own.big_enough() {
        return Some(own);
    }
    let parent = parent.filter(|parent| {
        parent.big_enough()
            && (parent.x - 2..=parent.x + parent.width + 2).contains(&own.x)
            && (parent.y - 2..=parent.y + parent.height + 2).contains(&own.y)
    })?;
    Some(if parent.height <= CARD_HEIGHT { parent } else { Bounds { width: own.width.max(16), height: own.height.max(16), ..own } })
}

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
    // Chrome shows a local file without its scheme, as a path from the drive: g:/tests/fill/forms.html.
    let bytes = text.as_bytes();
    if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'/' | b'\\') {
        return Some("file:".into());
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
        assert_eq!(finished("Your CV *", FieldKind::Button), FieldKind::File, "named by its label alone");
        assert_eq!(finished("Upload resume", FieldKind::Button), FieldKind::File);
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

    fn web(control: Control, role: &str) -> Props {
        Props { control, role: role.into(), ..Props::default() }
    }

    fn kind(p: Props) -> Option<FieldKind> {
        kind_of(&p, || false)
    }

    #[test]
    fn a_select_is_a_list_even_with_a_value_chrome_says_is_not_read_only() {
        let select = Props { value_pattern: true, ..web(Control::ComboBox, "combobox") };
        assert_eq!(kind(select), Some(FieldKind::List));
        let select_only = Props { value_pattern: true, aria: "expanded=false;haspopup=listbox".into(), ..web(Control::ComboBox, "combobox") };
        assert_eq!(kind(select_only), Some(FieldKind::List), "a div with role=combobox and no input");
    }

    #[test]
    fn an_input_with_suggestions_is_a_text_box() {
        let email = Props { value_pattern: true, text_pattern: true, ..web(Control::ComboBox, "combobox") };
        assert_eq!(kind(email), Some(FieldKind::PlainText));
        // A desktop app's drop-down you can type in has no web role.
        let desktop = Props { value_pattern: true, ..web(Control::ComboBox, "") };
        assert_eq!(kind(desktop), Some(FieldKind::PlainText));
        let desktop_fixed = Props { value_pattern: true, read_only: true, ..web(Control::ComboBox, "") };
        assert_eq!(kind(desktop_fixed), Some(FieldKind::List));
        // A read-only input that only opens a list, as Ant Design builds its Select.
        let ant = Props { value_pattern: true, read_only: true, ..web(Control::ComboBox, "combobox") };
        assert_eq!(kind(ant), Some(FieldKind::List));
    }

    #[test]
    fn a_picker_that_keeps_only_its_choices_is_a_list_though_it_takes_typing() {
        let typed = |class: &str, id: &str| Props { value_pattern: true, text_pattern: true, class: class.into(), automation_id: id.into(), ..web(Control::ComboBox, "combobox") };
        assert_eq!(kind(typed("MuiAutocomplete-input MuiInputBase-input", "skills")), Some(FieldKind::List));
        assert_eq!(kind(typed("", "react-select-2-input")), Some(FieldKind::List));
        assert_eq!(kind(typed("select2-search__field", "")), Some(FieldKind::List));
        assert_eq!(kind(typed("form-control", "work-email")), Some(FieldKind::PlainText));
    }

    #[test]
    fn a_pages_bulleted_list_is_words_and_a_listbox_is_a_box() {
        assert_eq!(kind(Props { focusable: true, ..web(Control::List, "list") }), None, "even a focusable <ul>");
        assert_eq!(kind(Props { selectable: true, ..web(Control::List, "listbox") }), Some(FieldKind::List));
        assert_eq!(kind(web(Control::List, "")), None);
        assert_eq!(kind(Props { selectable: true, ..web(Control::List, "") }), Some(FieldKind::List));
    }

    #[test]
    fn a_switch_is_a_tick_box_and_a_pressed_button_stays_a_button() {
        assert_eq!(kind(web(Control::Button, "switch")), Some(FieldKind::Checkbox));
        assert_eq!(kind(web(Control::CheckBox, "switch")), Some(FieldKind::Checkbox), "Firefox");
        let like = Props { aria: "pressed=false".into(), ..web(Control::Button, "button") };
        assert_eq!(kind(like), Some(FieldKind::Button));
    }

    #[test]
    fn a_button_that_opens_a_list_of_choices_is_a_drop_down() {
        let listbox = Props { aria: "expanded=false;haspopup=listbox".into(), ..web(Control::Button, "button") };
        assert_eq!(kind(listbox), Some(FieldKind::List));
        let menu = Props { aria: "haspopup=menu".into(), ..web(Control::Button, "button") };
        assert_eq!(kind(menu), Some(FieldKind::Button), "a menu button is not a list");
    }

    #[test]
    fn text_boxes_are_told_apart() {
        assert_eq!(kind(web(Control::Edit, "searchbox")), Some(FieldKind::PlainText));
        assert_eq!(kind(Props { password: true, ..web(Control::Edit, "textbox") }), Some(FieldKind::Password));
        assert_eq!(kind(Props { multiline: true, ..web(Control::Edit, "textbox") }), Some(FieldKind::MultiLine));
        // Empty on a page, a textarea and a rich editor look the same, so it is pasted into; a desktop box is not.
        assert_eq!(kind(Props { multiline: true, empty: true, ..web(Control::Edit, "textbox") }), Some(FieldKind::RichText));
        assert_eq!(kind(Props { multiline: true, empty: true, ..web(Control::Edit, "") }), Some(FieldKind::MultiLine));
        assert_eq!(kind(Props { in_date: true, ..web(Control::Spinner, "spinbutton") }), None, "a date's Day is part of the date");
        assert_eq!(kind(web(Control::Spinner, "spinbutton")), Some(FieldKind::Number));
        assert_eq!(kind_of(&Props { multiline: true, ..web(Control::Edit, "textbox") }, || true), Some(FieldKind::RichText));
        assert_eq!(kind(Props { localized: "date picker".into(), ..web(Control::Edit, "textbox") }), Some(FieldKind::Date));
        assert_eq!(kind(web(Control::Edit, "spinbutton")), Some(FieldKind::Number));
        assert_eq!(kind(Props { read_only: true, ..web(Control::Edit, "textbox") }), None, "a read-only box is not filled");
        assert_eq!(kind(Props { read_only: true, value_pattern: true, ..web(Control::Button, "button") }), Some(FieldKind::Button), "a file box says No file chosen, read-only");
        assert_eq!(kind(web(Control::Group, "group")), None);
        assert_eq!(kind(Props { focused: true, text_pattern: true, ..web(Control::Group, "group") }), Some(FieldKind::RichText));
        assert_eq!(kind(Props { focused: true, automation_id: "RootWebArea".into(), ..web(Control::Document, "document") }), None);
    }

    #[test]
    fn a_many_line_box_asks_for_its_children_only_when_it_matters() {
        let asked = std::cell::Cell::new(false);
        kind_of(&web(Control::Edit, "textbox"), || {
            asked.set(true);
            true
        });
        assert!(!asked.get());
    }

    #[test]
    fn the_label_is_the_name_then_labelled_by_then_placeholder_then_the_text_before() {
        let never = || -> String { panic!("not asked") };
        assert_eq!(label_of("Full name", "Ravi", None, never, never), "Full name");
        assert_eq!(label_of("", "you@example.com", None, || "Email".into(), never), "Email");
        assert_eq!(label_of(" * ", "you@example.com", None, String::new, never), "you@example.com", "a lone star is not a label");
        assert_eq!(label_of("", "", None, String::new, || "Enter the code we sent".into()), "Enter the code we sent");
        assert_eq!(label_of("", "", Some("Month"), String::new, || "Date of birth".into()), "Date of birth: Month");
        assert_eq!(label_of("", "", Some("Year"), String::new, String::new), "Year");
        assert_eq!(label_of("", "", None, String::new, String::new), "");
    }

    #[test]
    fn an_unnamed_drop_down_says_what_it_asks_only_by_a_prompt() {
        assert_eq!(list_hint("Month").as_deref(), Some("Month"));
        assert_eq!(list_hint("Select city").as_deref(), Some("Select city"));
        assert_eq!(list_hint("दिन").as_deref(), Some("दिन"));
        assert_eq!(list_hint("+91").as_deref(), Some("Country code"));
        assert_eq!(list_hint("IN +91").as_deref(), Some("Country code"));
        assert_eq!(list_hint("March"), None, "a real choice");
        assert_eq!(list_hint("+91 98201 44317"), None, "a phone number is not a code");
        assert_eq!(list_hint(""), None);
    }

    #[test]
    fn a_star_or_a_word_marks_a_box_as_needed() {
        for label in ["Email *", "* Full name", "Phone (required)", "मोबाइल नंबर (अनिवार्य)", "Name*"] {
            assert!(marked_required(label), "{label}");
        }
        for label in ["Email", "LinkedIn (optional)", "Requirements met"] {
            assert!(!marked_required(label), "{label}");
        }
    }

    #[test]
    fn a_one_pixel_tick_inside_a_card_on_screen_counts_and_one_alone_does_not() {
        let tiny = Bounds { x: 510, y: 470, width: 1, height: 1 };
        let card = Bounds { x: 500, y: 460, width: 200, height: 60 };
        assert_eq!(tick_bounds(tiny, Some(card)), Some(card));
        let group = Bounds { x: 480, y: 400, width: 800, height: 400 };
        assert_eq!(tick_bounds(tiny, Some(group)), Some(Bounds { x: 510, y: 470, width: 16, height: 16 }));
        assert_eq!(tick_bounds(tiny, None), None, "its parent is off screen");
        assert_eq!(tick_bounds(tiny, Some(Bounds { x: -10000, y: 0, width: 200, height: 60 })), None, "its parent is elsewhere");
        assert_eq!(tick_bounds(card, None), Some(card), "a tick you can see is where it is");
    }

    #[test]
    fn the_site_is_read_from_the_address_bar() {
        assert_eq!(site_from_address("kestrellabs.in/careers/apply").as_deref(), Some("kestrellabs.in"));
        assert_eq!(site_from_address("https://www.onlinesbi.sbi/retail").as_deref(), Some("onlinesbi.sbi"));
        assert_eq!(site_from_address("HTTP://user:pw@Mail.Google.com:443/#inbox").as_deref(), Some("mail.google.com"));
        assert_eq!(site_from_address("localhost:3000/form").as_deref(), Some("localhost"));
        assert_eq!(site_from_address("chrome://settings/passwords").as_deref(), Some("chrome:"));
        assert_eq!(site_from_address("file:///G:/tests/fill/forms.html").as_deref(), Some("file:"));
        // How Chrome shows that same file, with no scheme.
        assert_eq!(site_from_address("G:/Personal%20Projects/tests/fill/forms.html#zoom=0.5").as_deref(), Some("file:"));
        assert_eq!(site_from_address("C:\\Users\\me\\form.html").as_deref(), Some("file:"));
        assert_eq!(site_from_address("about:blank").as_deref(), Some("about:"));
    }

    #[test]
    fn a_search_being_typed_is_not_a_site() {
        assert_eq!(site_from_address("weather in pune"), None);
        assert_eq!(site_from_address("pune"), None);
        assert_eq!(site_from_address("  "), None);
    }
}
