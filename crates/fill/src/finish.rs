//! Finish this for me: what each step may do by itself, what waits for the user's click on the
//! island, and what it never does. Rust decides this before every step, whatever the AI says and
//! whatever the page says. The lists are short on purpose, so they can be reviewed, and they err
//! towards asking: an extra click costs a second, a missed one can send or pay.

use serde::Serialize;

use crate::model::{has_any, site_from_address, Field, FieldKind};
use crate::policy::{on, refusal, secret, Refusal, CONSENT};

/// A step that waits for one click on the island, for that step only. There is no always.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "site", rename_all = "kebab-case")]
pub enum Commit {
    Submit,
    Send,
    Pay,
    Book,
    Upload,
    Delete,
    /// Signing in or out, making or closing an account.
    Account,
    /// OK, Yes and Confirm, which say yes to whatever the page asked.
    Confirm,
    /// Another site than the ones this task has been on.
    NewSite(String),
}

/// What Meridian does with a step the AI asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    Free,
    Ask(Commit),
    /// Never, with the reason for the user.
    Never(String),
}

// Phrases are lowercase whole words, as `model::words` writes them. Automation ids such as
// `btnSubmit` or `place-order` split into the same words.
const SUBMIT: &[&str] = &[
    "submit", "apply", "post", "publish", "file return", "register", "enrol", "enroll", "request", "finish",
    "complete", "approve", "reject", "जमा करें", "सबमिट", "आवेदन", "दर्ज करें", "पोस्ट करें", "प्रकाशित",
];
const SEND: &[&str] = &["send", "send now", "share", "invite", "transfer", "भेजें", "भेजो", "भेजना", "शेयर"];
const PAY: &[&str] = &[
    "pay", "pay now", "make payment", "confirm payment", "buy", "buy now", "purchase", "checkout", "check out",
    "place order", "order now", "confirm order", "donate", "recharge", "top up", "add money", "upgrade",
    "भुगतान", "पे करें", "खरीदें", "ऑर्डर", "रिचार्ज",
];
const BOOK: &[&str] = &["book", "book now", "reserve", "reservation", "check in", "बुक", "बुक करें", "आरक्षित"];
const UPLOAD: &[&str] = &["upload", "attach", "choose file", "import", "अपलोड", "संलग्न"];
const DELETE: &[&str] = &[
    "delete", "remove", "discard", "erase", "trash", "clear all", "empty", "cancel order", "cancel booking",
    "cancel subscription", "unsubscribe", "हटाएँ", "हटाएं", "हटाए", "मिटाएँ", "मिटाएं", "डिलीट",
];
const ACCOUNT: &[&str] = &[
    "sign in", "signin", "log in", "login", "sign up", "signup", "sign out", "log out", "logout",
    "create account", "close account", "साइन इन", "लॉग इन", "लॉगिन", "लॉगआउट",
];
const CONFIRM: &[&str] = &["confirm", "ok", "okay", "yes", "proceed", "पुष्टि", "हाँ", "हां", "ठीक है"];

/// What a button, link or menu item commits to, if anything. The first match wins, so "Delete and
/// send" asks as a delete, and the island says so.
pub fn commit(words: &str) -> Option<Commit> {
    [
        (DELETE, Commit::Delete),
        (PAY, Commit::Pay),
        (UPLOAD, Commit::Upload),
        (SEND, Commit::Send),
        (BOOK, Commit::Book),
        (ACCOUNT, Commit::Account),
        (SUBMIT, Commit::Submit),
        (CONFIRM, Commit::Confirm),
    ]
    .into_iter()
    .find(|(phrases, _)| has_any(words, phrases))
    .map(|(_, commit)| commit)
}

/// One site, a page of it or a part of it: uber.com and riders.uber.com are the same place.
pub fn same_site(a: &str, b: &str) -> bool {
    on(a, b) || on(b, a)
}

/// Whether this task has been on the site already. The site it started on counts.
fn visited(site: &str, visited: &[String]) -> bool {
    visited.iter().any(|seen| same_site(site, seen))
}

/// Pressing a button, link, tab, menu item or list row.
pub fn press(element: &Field, sites: &[String]) -> Step {
    if !element.visible {
        return Step::Never("It is hidden, and hidden things are never pressed.".into());
    }
    if element.kind == FieldKind::File {
        return Step::Ask(Commit::Upload);
    }
    if element.kind == FieldKind::Password {
        return Step::Never(Refusal::Password.to_string());
    }
    let words = element.words();
    if words.trim().is_empty() {
        return Step::Never("It has no name, so what it does is unknown. It is yours to press.".into());
    }
    if let Some(refused) = secret(&words) {
        return Step::Never(refused.to_string());
    }
    if has_any(&words, CONSENT) {
        return Step::Never("Agreeing to terms, consent and offers is yours to do.".into());
    }
    if let Some(commit) = commit(&words) {
        return Step::Ask(commit);
    }
    if element.kind == FieldKind::Link {
        return go(&element.value, sites);
    }
    Step::Free
}

/// Following a link. A link that only runs the page's own script stays on the page.
pub fn go(address: &str, sites: &[String]) -> Step {
    match site_from_address(address) {
        None => Step::Free,
        Some(scheme) if scheme == "javascript:" => Step::Free,
        Some(scheme) if scheme.ends_with(':') => Step::Never("It opens another app or the browser's own pages.".into()),
        Some(site) if visited(&site, sites) => Step::Free,
        Some(site) => Step::Ask(Commit::NewSite(site)),
    }
}

/// Writing in a box, ticking or picking. Passwords, cards, codes, CAPTCHA, uploads and "I agree"
/// are the user's, as for Fill this form.
pub fn fill(field: &Field) -> Step {
    if !field.visible {
        return Step::Never("That box is hidden, and hidden boxes are never filled.".into());
    }
    if matches!(field.kind, FieldKind::Link | FieldKind::Tab | FieldKind::MenuItem | FieldKind::Item) {
        return Step::Never("That is not a box.".into());
    }
    match refusal(field) {
        Some(Refusal::Button) => Step::Never("That is a button, not a box.".into()),
        Some(refused) => Step::Never(refused.to_string()),
        None => Step::Free,
    }
}

/// After a step, the page may have gone somewhere by itself. A site this task has not been on
/// stops it until the user clicks: nothing more is read or done there before that.
pub fn landed(site: Option<&str>, sites: &[String]) -> Option<String> {
    let site = site?;
    (!site.ends_with(':') && !visited(site, sites)).then(|| site.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{field, words};

    fn button(name: &str) -> Field {
        field(0, name, FieldKind::Button)
    }

    fn asks(name: &str) -> Option<Commit> {
        match press(&button(name), &[]) {
            Step::Ask(commit) => Some(commit),
            _ => None,
        }
    }

    #[test]
    fn everyday_commit_buttons_ask() {
        for (name, kind) in [
            ("Submit", Commit::Submit),
            ("Submit claim", Commit::Submit),
            ("Apply now", Commit::Submit),
            ("Post", Commit::Submit),
            ("Send", Commit::Send),
            ("Send money", Commit::Send),
            ("Pay ₹545", Commit::Pay),
            ("Pay now", Commit::Pay),
            ("Proceed to pay", Commit::Pay),
            ("Buy now", Commit::Pay),
            ("Place order", Commit::Pay),
            ("Confirm payment", Commit::Pay),
            ("Checkout", Commit::Pay),
            ("Recharge", Commit::Pay),
            ("Book now", Commit::Book),
            ("Book ticket", Commit::Book),
            ("Reserve a table", Commit::Book),
            ("Upload", Commit::Upload),
            ("Attach files", Commit::Upload),
            ("Delete", Commit::Delete),
            ("Remove item", Commit::Delete),
            ("Move to trash", Commit::Delete),
            ("Sign in", Commit::Account),
            ("Log in", Commit::Account),
            ("Sign out", Commit::Account),
            ("Confirm", Commit::Confirm),
            ("OK", Commit::Confirm),
            ("Yes", Commit::Confirm),
        ] {
            assert_eq!(asks(name), Some(kind), "{name}");
        }
    }

    #[test]
    fn the_same_buttons_ask_in_hindi() {
        for (name, kind) in [
            ("जमा करें", Commit::Submit),
            ("आवेदन करें", Commit::Submit),
            ("भेजें", Commit::Send),
            ("भुगतान करें", Commit::Pay),
            ("अभी खरीदें", Commit::Pay),
            ("ऑर्डर करें", Commit::Pay),
            ("टिकट बुक करें", Commit::Book),
            ("फ़ाइल अपलोड करें", Commit::Upload),
            ("हटाएँ", Commit::Delete),
            ("हटाएं", Commit::Delete),
            ("साइन इन करें", Commit::Account),
            ("पुष्टि करें", Commit::Confirm),
            ("हाँ", Commit::Confirm),
            ("ठीक है", Commit::Confirm),
        ] {
            assert_eq!(asks(name), Some(kind), "{name}");
        }
    }

    #[test]
    fn tricky_names_err_towards_asking() {
        assert_eq!(asks("Submit feedback later"), Some(Commit::Submit), "it still says submit");
        assert_eq!(asks("Delete draft"), Some(Commit::Delete), "a draft is still the user's");
        assert_eq!(asks("Save and submit"), Some(Commit::Submit));
        assert_eq!(asks("Delete and send"), Some(Commit::Delete), "the first kind that matches is named");
        assert_eq!(asks("Cancel order"), Some(Commit::Delete));
        assert_eq!(asks("Payment history"), None, "a noun is not paying");
        assert_eq!(asks("Resend"), None, "only whole words count");
        assert_eq!(asks("Facebook"), None);
    }

    #[test]
    fn the_html_id_names_the_button_when_its_label_does_not() {
        let mut icon = button("");
        icon.automation_id = "btnSubmit".into();
        assert_eq!(press(&icon, &[]), Step::Ask(Commit::Submit));
        icon.automation_id = "place-order".into();
        assert_eq!(press(&icon, &[]), Step::Ask(Commit::Pay));
        assert_eq!(words("deleteButton"), " delete button ");
    }

    #[test]
    fn everyday_buttons_are_pressed_by_itself() {
        for name in ["Next", "Continue", "Save draft", "Search", "Show more", "Category", "Travel", "Add another expense", "Back", "आगे", "जारी रखें"] {
            assert_eq!(press(&button(name), &[]), Step::Free, "{name}");
        }
        for kind in [FieldKind::Tab, FieldKind::MenuItem, FieldKind::Item, FieldKind::List] {
            assert_eq!(press(&field(0, "Travel · Cab", kind), &[]), Step::Free, "{kind:?}");
        }
    }

    #[test]
    fn some_buttons_are_never_pressed() {
        for name in [
            "Show password", "Forgot password?", "Resend OTP", "I'm not a robot", "I agree", "Accept all cookies",
            "Accept terms", "Subscribe to our newsletter", "Add debit card", "मैं सहमत हूँ", "ओटीपी दोबारा भेजें",
        ] {
            assert!(matches!(press(&button(name), &[]), Step::Never(_)), "{name}");
        }
        assert!(matches!(press(&button(""), &[]), Step::Never(_)), "a button with no name");
        let mut hidden = button("Next");
        hidden.visible = false;
        assert!(matches!(press(&hidden, &[]), Step::Never(_)), "a hidden button");
        assert!(matches!(press(&field(0, "Choose", FieldKind::Password), &[]), Step::Never(_)));
    }

    #[test]
    fn an_upload_always_asks() {
        assert_eq!(press(&field(0, "Receipt", FieldKind::File), &[]), Step::Ask(Commit::Upload));
        assert!(matches!(fill(&field(0, "Receipt", FieldKind::File)), Step::Never(_)), "and is never typed into");
    }

    fn link(name: &str, to: &str) -> Field {
        Field { value: to.into(), ..field(0, name, FieldKind::Link) }
    }

    #[test]
    fn a_link_to_a_new_site_asks_and_one_on_a_site_already_visited_does_not() {
        let sites = vec!["expenses.northwind.in".to_string()];
        assert_eq!(press(&link("Get your receipt", "https://riders.uber.com/trips"), &sites), Step::Ask(Commit::NewSite("riders.uber.com".into())));
        assert_eq!(press(&link("My claims", "https://expenses.northwind.in/claims"), &sites), Step::Free);
        assert_eq!(press(&link("Help", "https://northwind.in/help"), &sites), Step::Free, "the same site, another part of it");
        assert_eq!(press(&link("Help", "https://notnorthwind.in/help"), &sites), Step::Ask(Commit::NewSite("notnorthwind.in".into())));
        assert_eq!(press(&link("More", "javascript:void(0)"), &sites), Step::Free);
        assert_eq!(press(&link("Same page", ""), &sites), Step::Free);
        assert!(matches!(press(&link("Mail us", "mailto:hr@northwind.in"), &sites), Step::Never(_)));
        assert!(matches!(press(&link("Settings", "chrome://settings"), &sites), Step::Never(_)));
        // The words still win over where it goes.
        assert_eq!(press(&link("Delete account", "https://expenses.northwind.in/x"), &sites), Step::Ask(Commit::Delete));
    }

    #[test]
    fn landing_on_a_new_site_by_itself_is_caught() {
        let sites = vec!["expenses.northwind.in".to_string()];
        assert_eq!(landed(Some("expenses.northwind.in"), &sites), None);
        assert_eq!(landed(Some("pay.example.com"), &sites).as_deref(), Some("pay.example.com"));
        assert_eq!(landed(None, &sites), None, "an app with no site");
    }

    #[test]
    fn filling_keeps_the_never_fill_rules() {
        assert_eq!(fill(&field(0, "Amount (₹)", FieldKind::Number)), Step::Free);
        assert_eq!(fill(&field(0, "Category", FieldKind::List)), Step::Free);
        assert_eq!(fill(&field(0, "Same as billing", FieldKind::Checkbox)), Step::Free);
        for refused in [
            field(0, "Card number", FieldKind::PlainText),
            field(0, "CVV", FieldKind::PlainText),
            field(0, "UPI PIN", FieldKind::PlainText),
            field(0, "Enter OTP", FieldKind::PlainText),
            field(0, "कैप्चा", FieldKind::PlainText),
            field(0, "Anything", FieldKind::Password),
            field(0, "I agree to the terms", FieldKind::Checkbox),
            field(0, "Submit", FieldKind::Button),
            field(0, "Home", FieldKind::Link),
        ] {
            assert!(matches!(fill(&refused), Step::Never(_)), "{refused:?}");
        }
        let mut trap = field(0, "Phone", FieldKind::Phone);
        trap.visible = false;
        assert!(matches!(fill(&trap), Step::Never(_)));
    }
}
