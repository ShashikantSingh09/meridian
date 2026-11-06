//! What Meridian never fills, where it never works, and where it asks every time.
//! Checked in Rust before the AI sees a form and again right before each write,
//! whatever the AI says. The lists are short on purpose, so they can be reviewed.

use serde::Serialize;

use crate::model::{has_any, Field, FieldKind, Target};

/// Why a box is the user's to fill.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Refusal {
    Password,
    CardNumber,
    Cvv,
    Expiry,
    OneTimeCode,
    Captcha,
    Consent,
    FileUpload,
    Button,
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str(match self {
            Self::Password => "Password boxes are yours to fill.",
            Self::CardNumber => "Card numbers are yours to fill.",
            Self::Cvv => "CVV boxes are yours to fill.",
            Self::Expiry => "Expiry dates are yours to fill.",
            Self::OneTimeCode => "One-time codes are yours to fill.",
            Self::Captcha => "CAPTCHAs are yours to fill.",
            Self::Consent => "“I agree” boxes are yours to tick.",
            Self::FileUpload => "File uploads are yours to do.",
            Self::Button => "Buttons are yours to press.",
        })
    }
}

// Phrases are lowercase whole words, as `model::words` writes them.
const ONE_TIME_CODE: &[&str] = &[
    "otp", "one time password", "one time code", "one time pin", "verification code", "auth code",
    "authentication code", "2fa", "two factor", "2 step", "sms code", "ओटीपी", "वन टाइम पासवर्ड", "सत्यापन कोड",
];
const PASSWORD: &[&str] = &[
    "password", "passwd", "pwd", "passcode", "mpin", "upi pin", "atm pin", "transaction pin", "tpin",
    "security pin", "पासवर्ड", "कूटशब्द",
];
const CVV: &[&str] = &[
    "cvv", "cvv2", "cvc", "cvc2", "csc", "card verification", "card security code", "security code", "सीवीवी",
];
const CARD_NUMBER: &[&str] = &[
    "card number", "card no", "card num", "cardnumber", "cc number", "cc num", "ccnum", "credit card",
    "debit card", "कार्ड नंबर", "कार्ड संख्या", "क्रेडिट कार्ड", "डेबिट कार्ड",
];
/// ID cards are not payment cards: an Aadhaar or PAN number can come from Your details.
const ID_CARDS: &[&str] = &["aadhaar", "aadhar", "pan", "voter", "ration", "id card", "आधार", "पैन", "राशन", "मतदाता"];
const EXPIRY: &[&str] = &[
    "expiry", "expiration", "expires", "exp date", "exp month", "exp year", "cc exp", "valid thru",
    "valid through", "mm yy", "समाप्ति", "वैधता",
];
const CAPTCHA: &[&str] = &[
    "captcha", "recaptcha", "hcaptcha", "not a robot", "characters you see", "characters shown", "कैप्चा",
];
/// Only for tick boxes and choices: a text box called "Terms" is just a box.
const CONSENT: &[&str] = &[
    "agree", "agreement", "accept", "consent", "terms", "conditions", "privacy policy", "i have read",
    "i confirm", "declare", "declaration", "authorise", "authorize", "subscribe", "newsletter", "marketing",
    "offers", "promotional", "opt in", "send me", "सहमत", "स्वीकार", "शर्तें", "शर्तों", "नियम", "घोषणा",
    "अनुमति", "सदस्यता",
];

/// Why Meridian never fills this box, if it never does.
pub fn refusal(field: &Field) -> Option<Refusal> {
    match field.kind {
        FieldKind::Password => return Some(Refusal::Password),
        FieldKind::File => return Some(Refusal::FileUpload),
        FieldKind::Button => return Some(Refusal::Button),
        _ => {}
    }
    let words = field.words();
    let tick = matches!(field.kind, FieldKind::Checkbox | FieldKind::Radio);
    // A one-time password is a code, so codes are checked before passwords.
    if has_any(&words, ONE_TIME_CODE) {
        Some(Refusal::OneTimeCode)
    } else if has_any(&words, PASSWORD) {
        Some(Refusal::Password)
    } else if has_any(&words, CVV) {
        Some(Refusal::Cvv)
    } else if has_any(&words, CARD_NUMBER) && !has_any(&words, ID_CARDS) {
        Some(Refusal::CardNumber)
    } else if has_any(&words, EXPIRY) {
        Some(Refusal::Expiry)
    } else if has_any(&words, CAPTCHA) {
        Some(Refusal::Captcha)
    } else if tick && has_any(&words, CONSENT) {
        Some(Refusal::Consent)
    } else {
        None
    }
}

/// Whether Meridian may fill in this window at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "access", content = "reason", rename_all = "kebab-case")]
pub enum Access {
    /// Never, whatever the user's list says. The reason names the place, such as "a terminal".
    Never(&'static str),
    /// Asks before every fill, naming the site: banks, tax and government.
    EachTime(&'static str),
    /// The user's own list of apps and sites decides, asking the first time.
    Usual,
}

// Executable names without ".exe", lowercase. Terminal and iTerm2 are the Mac's.
const TERMINALS: &[&str] = &[
    "cmd", "powershell", "powershell_ise", "pwsh", "windowsterminal", "wt", "conhost", "openconsole", "wsl",
    "wslhost", "bash", "mintty", "alacritty", "wezterm", "wezterm-gui", "putty", "kitty", "hyper", "tabby",
    "mobaxterm", "conemu", "conemu64", "cmder", "termius", "warp", "terminal", "iterm2",
];
/// The Settings app runs inside ApplicationFrameHost, so its title tells it apart.
const SETTINGS_TITLES: &[&str] = &["settings", "सेटिंग्स"];
const SECURITY_APPS: &[&str] = &["sechealthui", "securityhealthhost", "credentialuibroker", "consent", "logonui"];
const SECURITY_TITLES: &[&str] = &["windows security", "windows सुरक्षा"];
const PASSWORD_APPS: &[&str] = &[
    "1password", "bitwarden", "keepass", "lastpass", "dashlane", "enpass", "nordpass", "roboform", "keeper",
    "protonpass",
];
const PASSWORD_TITLES: &[&str] = &[
    "password manager", "credential manager", "1password", "bitwarden", "keepass", "lastpass", "dashlane",
    "nordpass", "roboform", "proton pass",
];
/// "(गुप्त)" is Chrome's Hindi incognito mark. The bare word would block every "Gupta".
const PRIVATE_TITLES: &[&str] = &["inprivate", "incognito", "private browsing", "private window", "(private)", "(गुप्त)"];
const BROWSERS: &[&str] = &[
    "chrome", "msedge", "firefox", "brave", "opera", "vivaldi", "arc", "chromium", "librewolf", "waterfox", "zen",
    "iexplore", "google chrome", "safari",
];
/// Tax sites outside .gov. Matched as the domain or any part of it.
const TAX_SITES: &[&str] =
    &["cleartax.in", "tin-nsdl.com", "protean-tinpan.com", "proteantech.in", "utiitsl.com"];
/// Indian banks whose site does not say "bank". `.sbi` is SBI's own top-level domain.
const BANK_SITES: &[&str] = &["sbi", "sbi.co.in", "onlinesbi.com", "kotak.com", "pnbindia.in", "netpnb.com", "iob.in", "indusind.com", "npci.org.in"];

fn stem(process: &str) -> String {
    let process = process.trim().to_lowercase();
    process.strip_suffix(".exe").unwrap_or(&process).to_string()
}

pub fn is_browser(process: &str) -> bool {
    BROWSERS.contains(&stem(process).as_str())
}

fn on(host: &str, domain: &str) -> bool {
    host == domain || host.strip_suffix(domain).is_some_and(|rest| rest.ends_with('.'))
}

fn careful_site(host: &str) -> Option<&'static str> {
    if host.split('.').any(|part| matches!(part, "gov" | "nic" | "mil")) {
        Some("a government site")
    } else if host.contains("incometax") || TAX_SITES.iter().any(|domain| on(host, domain)) {
        Some("a tax site")
    } else if host.contains("bank") || BANK_SITES.iter().any(|domain| on(host, domain)) {
        Some("a bank")
    } else {
        None
    }
}

/// Where this window stands. Check it before reading a single box.
pub fn access(target: &Target) -> Access {
    let stem = stem(&target.process);
    let title = target.title.trim().to_lowercase();
    let titled = |list: &[&str]| list.iter().any(|phrase| title.contains(phrase));
    if stem == "meridian" {
        return Access::Never("Meridian itself");
    }
    if TERMINALS.contains(&stem.as_str()) {
        return Access::Never("a terminal");
    }
    if stem == "systemsettings" || (stem == "applicationframehost" && SETTINGS_TITLES.contains(&title.as_str())) {
        return Access::Never("Windows Settings");
    }
    if SECURITY_APPS.contains(&stem.as_str()) || titled(SECURITY_TITLES) {
        return Access::Never("Windows Security");
    }
    // Starts with, so KeePassXC counts and a bookkeeping app does not.
    if PASSWORD_APPS.iter().any(|app| stem.starts_with(app)) || titled(PASSWORD_TITLES) {
        return Access::Never("a password manager");
    }
    if titled(PRIVATE_TITLES) {
        return Access::Never("a private window");
    }
    match &target.site {
        None if is_browser(&stem) => Access::EachTime("a site that could not be read"),
        None => Access::Usual,
        Some(site) if site == "file:" => Access::Usual,
        Some(site) if site.ends_with(':') => Access::Never("the browser's own pages"),
        Some(site) => careful_site(site).map_or(Access::Usual, Access::EachTime),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::field;

    fn refused(label: &str) -> Option<Refusal> {
        refusal(&field(0, label, FieldKind::PlainText))
    }

    #[test]
    fn secrets_and_payment_boxes_are_known_by_their_english_words() {
        assert_eq!(refused("Confirm password"), Some(Refusal::Password));
        assert_eq!(refused("UPI PIN"), Some(Refusal::Password));
        assert_eq!(refused("Enter OTP"), Some(Refusal::OneTimeCode));
        assert_eq!(refused("One-time password"), Some(Refusal::OneTimeCode));
        assert_eq!(refused("Verification code"), Some(Refusal::OneTimeCode));
        assert_eq!(refused("Card number"), Some(Refusal::CardNumber));
        assert_eq!(refused("Debit card"), Some(Refusal::CardNumber));
        assert_eq!(refused("CVV"), Some(Refusal::Cvv));
        assert_eq!(refused("Security code"), Some(Refusal::Cvv));
        assert_eq!(refused("Expiry (MM/YY)"), Some(Refusal::Expiry));
        assert_eq!(refused("Type the characters you see"), Some(Refusal::Captcha));
        assert_eq!(refused("captcha"), Some(Refusal::Captcha));
    }

    #[test]
    fn the_same_boxes_are_known_in_hindi() {
        assert_eq!(refused("पासवर्ड"), Some(Refusal::Password));
        assert_eq!(refused("ओटीपी डालें"), Some(Refusal::OneTimeCode));
        assert_eq!(refused("कार्ड नंबर"), Some(Refusal::CardNumber));
        assert_eq!(refused("सीवीवी"), Some(Refusal::Cvv));
        assert_eq!(refused("कैप्चा"), Some(Refusal::Captcha));
        let consent = field(0, "मैं नियम और शर्तों से सहमत हूँ", FieldKind::Checkbox);
        assert_eq!(refusal(&consent), Some(Refusal::Consent));
    }

    #[test]
    fn the_placeholder_and_the_html_id_count_too() {
        let mut by_id = field(0, "", FieldKind::PlainText);
        by_id.automation_id = "cc-number".into();
        assert_eq!(refusal(&by_id), Some(Refusal::CardNumber));
        let mut camel = field(0, "Code", FieldKind::PlainText);
        camel.automation_id = "otpCode".into();
        assert_eq!(refusal(&camel), Some(Refusal::OneTimeCode));
        let mut hint = field(0, "Card", FieldKind::PlainText);
        hint.placeholder = "MM / YY".into();
        assert_eq!(refusal(&hint), Some(Refusal::Expiry));
    }

    #[test]
    fn an_aadhaar_card_number_is_not_a_payment_card() {
        assert_eq!(refused("Aadhaar card number"), None);
        assert_eq!(refused("PAN card number"), None);
        assert_eq!(refused("आधार कार्ड नंबर"), None);
    }

    #[test]
    fn consent_words_refuse_tick_boxes_only() {
        let tick = field(0, "I agree to the privacy policy", FieldKind::Checkbox);
        assert_eq!(refusal(&tick), Some(Refusal::Consent));
        let marketing = field(0, "Send me offers by email", FieldKind::Checkbox);
        assert_eq!(refusal(&marketing), Some(Refusal::Consent));
        assert_eq!(refused("Terms you prefer"), None);
        assert_eq!(refusal(&field(0, "I have a driving licence", FieldKind::Checkbox)), None);
    }

    #[test]
    fn passwords_uploads_and_buttons_are_refused_by_kind() {
        assert_eq!(refusal(&field(0, "Choose", FieldKind::Password)), Some(Refusal::Password));
        assert_eq!(refusal(&field(0, "Your CV", FieldKind::File)), Some(Refusal::FileUpload));
        assert_eq!(refusal(&field(0, "Submit", FieldKind::Button)), Some(Refusal::Button));
    }

    #[test]
    fn ordinary_boxes_are_fine() {
        for label in [
            "Full name", "Email", "Phone", "PIN code", "Notice period", "Why do you want to join Kestrel Labs?",
            "Address line 1", "पूरा नाम", "पिन कोड", "Expected salary (₹ a year)", "Postcode",
        ] {
            assert_eq!(refused(label), None, "{label}");
        }
    }

    fn target(process: &str, title: &str, site: Option<&str>) -> Target {
        Target { process: process.into(), title: title.into(), site: site.map(str::to_string) }
    }

    #[test]
    fn some_places_are_never_filled() {
        let never = [
            target("Meridian.exe", "Meridian", None),
            target("WindowsTerminal.exe", "PowerShell", None),
            target("powershell.exe", "Windows PowerShell", None),
            target("SystemSettings.exe", "Settings", None),
            target("ApplicationFrameHost.exe", "Settings", None),
            target("SecHealthUI.exe", "Windows Security", None),
            target("1Password.exe", "All items", None),
            target("chrome.exe", "Bitwarden Web vault - Google Chrome", Some("vault.bitwarden.com")),
            target("msedge.exe", "New tab - [InPrivate] - Microsoft Edge", Some("bing.com")),
            target("chrome.exe", "New Incognito tab - Google Chrome (Incognito)", Some("google.com")),
            target("chrome.exe", "Password Manager", Some("chrome:")),
            target("msedge.exe", "Settings", Some("edge:")),
        ];
        for place in never {
            assert!(matches!(access(&place), Access::Never(_)), "{place:?}");
        }
    }

    #[test]
    fn banks_tax_and_government_sites_ask_every_time() {
        for site in [
            "onlinesbi.sbi", "retail.onlinesbi.sbi", "sbi.bank.in", "netbanking.hdfcbank.com", "kotak.com",
            "incometax.gov.in", "eportal.incometax.gov.in", "uidai.gov.in", "gst.gov.in", "services.nic.in",
            "usa.gov", "www.gov.uk", "tin-nsdl.com",
        ] {
            let place = target("chrome.exe", "Page", Some(site));
            assert!(matches!(access(&place), Access::EachTime(_)), "{site}");
        }
    }

    #[test]
    fn a_browser_whose_site_cannot_be_read_asks_every_time() {
        assert!(matches!(access(&target("vivaldi.exe", "Page", None)), Access::EachTime(_)));
    }

    #[test]
    fn everyday_apps_and_sites_follow_the_users_list() {
        for place in [
            target("chrome.exe", "Apply - Kestrel Labs", Some("kestrellabs.in")),
            target("msedge.exe", "Inbox - Gmail", Some("mail.google.com")),
            target("chrome.exe", "Test forms", Some("file:")),
            target("ms-teams.exe", "Chat | Microsoft Teams", None),
            target("notepad.exe", "Untitled - Notepad", None),
            target("chrome.exe", "Priya Gupta - LinkedIn", Some("linkedin.com")),
            target("chrome.exe", "Pothole near Govandi", Some("govandi-news.com")),
        ] {
            assert_eq!(access(&place), Access::Usual, "{place:?}");
        }
    }
}
