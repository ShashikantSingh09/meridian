//! Your details: the user's name, contact, address and work, kept in one file in the app's local
//! data folder on this PC for filling in forms. Nothing here is synced, backed up or sent anywhere.
//! When a form needs the phone number, the AI only names the key, "phone", and `resolve` turns it
//! into the number here in Rust. The values never go to the AI.
//!
//! ID numbers (PAN, Aadhaar and passport) are off until the user turns them on, and are kept in
//! Windows Credential Manager, never in the file. Every fill that would use one must ask first and
//! name the site: `resolve` hands them back as `Value::AskFirst`, so the fill engine cannot write
//! one without asking.

use std::path::{Path, PathBuf};

use chrono::{Datelike, Local, NaiveDate};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::life::SERVICE;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Name {
    pub en: String,
    /// In Hindi script, for forms in Hindi.
    pub hi: String,
}

/// Kept in parts, so a form with separate City and PIN code boxes gets the right piece.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Address {
    /// Flat, building, street and area.
    pub lines: String,
    pub city: String,
    pub pin: String,
    pub state: String,
    /// The whole address in Hindi.
    pub hi: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Work {
    pub company: String,
    pub title: String,
    pub department: String,
    pub employee_id: String,
    pub email: String,
    pub linkedin: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Profile {
    pub name: Name,
    /// The date of birth, as 1991-08-14.
    pub birth: String,
    pub email: String,
    pub phone: String,
    pub other_phone: String,
    pub address: Address,
    pub work: Work,
    /// ID numbers may be kept and used. Off until turned on, and turning it off removes them.
    pub ids: bool,
}

/// The ID numbers Your details can hold, by the name of their key after "id.".
pub const ID_KINDS: [&str; 3] = ["pan", "aadhaar", "passport"];

/// Every key the fill engine may ask for. The AI is given these names, never the values.
pub const KEYS: &[&str] = &[
    "name", "name.en", "name.hi", "name.first", "name.last", "birth", "email", "phone", "phone.other", "address", "address.lines", "address.city",
    "address.pin", "address.state", "address.hi", "work.company", "work.title", "work.department", "work.id", "work.email", "work.linkedin", "id.pan",
    "id.aadhaar", "id.passport",
];

/// A value for one box, as Rust writes it.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Plain(String),
    /// A PAN, Aadhaar or passport number. The fill asks the user first, naming the site.
    AskFirst(String),
}

/// The value for a profile key, like `phone`, `name.en` or `address.city`, or None when it is empty
/// or not a key. `id` reads an ID number by kind, and is only asked when ID numbers are on.
fn resolve_in(profile: &Profile, key: &str, id: impl Fn(&str) -> Option<String>) -> Option<Value> {
    let full_name = profile.name.en.trim();
    let split = full_name.rsplit_once(char::is_whitespace);
    let text = match key {
        "name" | "name.en" => full_name.to_string(),
        "name.hi" => profile.name.hi.clone(),
        // A form with separate boxes: the last word is the surname, and the rest goes first.
        "name.first" => split.map_or(full_name, |(first, _)| first.trim()).to_string(),
        "name.last" => split.map(|(_, last)| last.to_string()).unwrap_or_default(),
        "birth" => profile.birth.clone(),
        "email" => profile.email.clone(),
        "phone" => profile.phone.clone(),
        "phone.other" => profile.other_phone.clone(),
        "address" => english_address(&profile.address),
        "address.lines" => profile.address.lines.clone(),
        "address.city" => profile.address.city.clone(),
        "address.pin" => profile.address.pin.clone(),
        "address.state" => profile.address.state.clone(),
        "address.hi" => profile.address.hi.clone(),
        "work.company" => profile.work.company.clone(),
        "work.title" => profile.work.title.clone(),
        "work.department" => profile.work.department.clone(),
        "work.id" => profile.work.employee_id.clone(),
        "work.email" => profile.work.email.clone(),
        "work.linkedin" => profile.work.linkedin.clone(),
        _ => {
            let kind = key.strip_prefix("id.").filter(|kind| ID_KINDS.contains(kind))?;
            return profile.ids.then(|| id(kind)).flatten().filter(|v| !v.is_empty()).map(Value::AskFirst);
        }
    };
    let text = text.trim();
    (!text.is_empty()).then(|| Value::Plain(text.to_string()))
}

/// The whole address on one line, the way the Hindi one is written: lines, city and PIN, state.
fn english_address(address: &Address) -> String {
    let city = [address.city.trim(), address.pin.trim()].iter().filter(|p| !p.is_empty()).copied().collect::<Vec<_>>().join(" ");
    [address.lines.trim(), city.as_str(), address.state.trim()].iter().filter(|p| !p.is_empty()).copied().collect::<Vec<_>>().join(", ")
}

/// The one call the fill engine makes for a value. It reads the file and Credential Manager here,
/// so a value goes from this PC's store straight into the box.
pub fn resolve(app: &AppHandle, key: &str) -> Option<Value> {
    resolve_in(&kept(app), key, read_id)
}

/// Your details as kept on this PC, without the ID numbers.
pub fn kept(app: &AppHandle) -> Profile {
    path(app).map(|path| load(&path)).unwrap_or_default()
}

impl Profile {
    /// Nothing added yet, so a fill can offer to start them.
    pub fn is_empty(&self) -> bool {
        tidy(self.clone()) == Profile { ids: self.ids, ..Profile::default() }
    }
}

/// An ID number as the Show list may show it: only its end.
pub fn masked(key: &str, number: &str) -> String {
    mask(key.strip_prefix("id.").unwrap_or(key), number)
}

// ── Checks ─────────────────────────────────────────────────────────────

fn looks_like_email(text: &str) -> bool {
    let Some((name, domain)) = text.split_once('@') else { return false };
    !name.is_empty() && !domain.contains('@') && !text.contains(char::is_whitespace) && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.')
}

/// Digits with the usual spaces, dashes and brackets, and a + only at the front.
fn looks_like_phone(text: &str) -> bool {
    let body = text.strip_prefix('+').unwrap_or(text);
    let digits = body.chars().filter(char::is_ascii_digit).count();
    body.chars().all(|c| c.is_ascii_digit() || " -()".contains(c)) && (10..=15).contains(&digits)
}

fn is_pin(text: &str) -> bool {
    text.len() == 6 && text.chars().all(|c| c.is_ascii_digit())
}

/// A real day, after 1900 and not in the future.
fn is_birth(text: &str) -> bool {
    NaiveDate::parse_from_str(text, "%Y-%m-%d").is_ok_and(|day| day.year() >= 1900 && day <= Local::now().date_naive())
}

/// What is wrong first, in the words the page shows, or None. Empty boxes are always fine.
fn problem(profile: &Profile) -> Option<&'static str> {
    let filled = |text: &str| !text.trim().is_empty();
    let checks = [
        (filled(&profile.birth) && !is_birth(profile.birth.trim()), "Use a real date of birth, not in the future."),
        (filled(&profile.email) && !looks_like_email(profile.email.trim()), "An email looks like name@example.com."),
        (filled(&profile.phone) && !looks_like_phone(profile.phone.trim()), "A phone number has 10 to 15 digits."),
        (filled(&profile.other_phone) && !looks_like_phone(profile.other_phone.trim()), "A phone number has 10 to 15 digits."),
        (filled(&profile.address.pin) && !is_pin(profile.address.pin.trim()), "A PIN code has 6 digits."),
        (filled(&profile.work.email) && !looks_like_email(profile.work.email.trim()), "An email looks like name@example.com."),
    ];
    checks.into_iter().find(|(wrong, _)| *wrong).map(|(_, why)| why)
}

/// The number as it is kept: capitals with no spaces, and an Aadhaar number as its 12 digits.
fn tidy_id(text: &str) -> String {
    text.chars().filter(|c| !c.is_whitespace() && *c != '-').collect::<String>().to_uppercase()
}

fn id_problem(kind: &str, number: &str) -> Option<&'static str> {
    let b = number.as_bytes();
    match kind {
        "pan" if !(b.len() == 10 && b[..5].iter().all(u8::is_ascii_uppercase) && b[5..9].iter().all(u8::is_ascii_digit) && b[9].is_ascii_uppercase()) => {
            Some("A PAN looks like ABCDE1234F.")
        }
        "aadhaar" if !(b.len() == 12 && b.iter().all(u8::is_ascii_digit)) => Some("An Aadhaar number has 12 digits."),
        "passport" if !((6..=9).contains(&b.len()) && b.iter().all(u8::is_ascii_alphanumeric) && b.iter().any(u8::is_ascii_digit)) => {
            Some("A passport number has 6 to 9 letters and digits.")
        }
        _ => None,
    }
}

/// Only the end shows, as the page draws it: •••••1234K, •••• •••• 8823.
fn mask(kind: &str, number: &str) -> String {
    let chars: Vec<char> = number.chars().collect();
    let shown = if kind == "pan" { 5 } else { 4 }.min(chars.len());
    let end: String = chars[chars.len() - shown..].iter().collect();
    if kind == "aadhaar" {
        format!("•••• •••• {end}")
    } else {
        format!("{}{end}", "•".repeat(chars.len() - shown))
    }
}

// ── Storage ────────────────────────────────────────────────────────────

fn path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("details.json"))
}

/// A broken file is set aside, so the user can still get it back, and the page starts empty.
fn load(path: &Path) -> Profile {
    let Ok(bytes) = std::fs::read(path) else { return Profile::default() };
    serde_json::from_slice(&bytes).unwrap_or_else(|_| {
        let _ = std::fs::rename(path, path.with_extension("json.bad"));
        Profile::default()
    })
}

fn tidy(mut profile: Profile) -> Profile {
    for text in [
        &mut profile.name.en,
        &mut profile.name.hi,
        &mut profile.birth,
        &mut profile.email,
        &mut profile.phone,
        &mut profile.other_phone,
        &mut profile.address.lines,
        &mut profile.address.city,
        &mut profile.address.pin,
        &mut profile.address.state,
        &mut profile.address.hi,
        &mut profile.work.company,
        &mut profile.work.title,
        &mut profile.work.department,
        &mut profile.work.employee_id,
        &mut profile.work.email,
        &mut profile.work.linkedin,
    ] {
        *text = text.trim().to_string();
    }
    profile
}

/// Checks and writes the profile. Turning ID numbers off removes the ones kept.
fn save_to(path: &Path, profile: Profile, clear_ids: impl FnOnce() -> Result<(), String>) -> Result<Profile, String> {
    let profile = tidy(profile);
    if let Some(why) = problem(&profile) {
        return Err(why.into());
    }
    if load(path).ids && !profile.ids {
        clear_ids()?;
    }
    crate::settings::save(path, &profile).map_err(|e| e.to_string())?;
    Ok(profile)
}

fn delete_at(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(err.to_string()),
        _ => Ok(()),
    }
}

fn id_entry(kind: &str) -> Result<Entry, String> {
    if !ID_KINDS.contains(&kind) {
        return Err("That is not an ID number Meridian keeps.".into());
    }
    Entry::new(SERVICE, &format!("details/{kind}")).map_err(|e| e.to_string())
}

fn read_id(kind: &str) -> Option<String> {
    id_entry(kind).ok()?.get_password().ok().filter(|n| !n.is_empty())
}

fn clear_id(kind: &str) -> Result<(), String> {
    match id_entry(kind)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn clear_ids() -> Result<(), String> {
    ID_KINDS.iter().try_for_each(|kind| clear_id(kind))
}

// ── Commands ───────────────────────────────────────────────────────────

#[tauri::command]
pub fn details_get(app: AppHandle) -> Result<Profile, String> {
    Ok(load(&path(&app)?))
}

/// Returns the profile as kept, trimmed.
#[tauri::command]
pub fn details_save(app: AppHandle, profile: Profile) -> Result<Profile, String> {
    save_to(&path(&app)?, profile, clear_ids)
}

/// Delete all my details: the file and every ID number.
#[tauri::command]
pub fn details_delete(app: AppHandle) -> Result<(), String> {
    clear_ids()?;
    delete_at(&path(&app)?)
}

/// The ID numbers kept, masked, by kind. None are shown while they are off.
#[derive(Debug, Default, Serialize)]
pub struct IdNumbers {
    pan: Option<String>,
    aadhaar: Option<String>,
    passport: Option<String>,
}

#[tauri::command]
pub fn details_ids(app: AppHandle) -> Result<IdNumbers, String> {
    if !load(&path(&app)?).ids {
        return Ok(IdNumbers::default());
    }
    let masked = |kind: &str| read_id(kind).map(|n| mask(kind, &n));
    Ok(IdNumbers { pan: masked("pan"), aadhaar: masked("aadhaar"), passport: masked("passport") })
}

/// The whole number, for the Show button. It goes to the page only, never to the AI.
#[tauri::command]
pub fn details_id_show(kind: String) -> Result<String, String> {
    read_id(&kind).ok_or_else(|| "That number is not kept.".into())
}

/// Keeps a number in Credential Manager, or removes it when the box is empty.
#[tauri::command]
pub fn details_id_set(app: AppHandle, kind: String, number: String) -> Result<(), String> {
    let number = tidy_id(&number);
    if number.is_empty() {
        return clear_id(&kind);
    }
    if !load(&path(&app)?).ids {
        return Err("Turn on ID numbers first.".into());
    }
    if let Some(why) = id_problem(&kind, &number) {
        return Err(why.into());
    }
    id_entry(&kind)?.set_password(&number).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("meridian-details-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("details.json")
    }

    fn ravi() -> Profile {
        Profile {
            name: Name { en: "Ravi Kumar Sharma".into(), hi: "रवि शर्मा".into() },
            birth: "1991-08-14".into(),
            email: "ravi.sharma84@gmail.com".into(),
            phone: "+91 98201 44317".into(),
            other_phone: String::new(),
            address: Address {
                lines: "Flat 702, Lotus Towers, 14th Main, HSR Layout".into(),
                city: "Bengaluru".into(),
                pin: "560102".into(),
                state: "Karnataka".into(),
                hi: "फ़्लैट 702, लोटस टावर्स, बेंगलुरु 560102, कर्नाटक".into(),
            },
            work: Work {
                company: "Northwind Software".into(),
                title: "Senior Product Designer".into(),
                department: "Design".into(),
                employee_id: "NW-20417".into(),
                email: "ravi.s@northwind.in".into(),
                linkedin: "linkedin.com/in/ravi-sharma-design".into(),
            },
            ids: true,
        }
    }

    fn plain(text: &str) -> Option<Value> {
        Some(Value::Plain(text.into()))
    }

    const NO_IDS: fn(&str) -> Option<String> = |_| None;

    #[test]
    fn keys_resolve_to_the_values_kept_in_both_scripts() {
        let profile = ravi();
        assert_eq!(resolve_in(&profile, "phone", NO_IDS), plain("+91 98201 44317"));
        assert_eq!(resolve_in(&profile, "name.en", NO_IDS), plain("Ravi Kumar Sharma"));
        assert_eq!(resolve_in(&profile, "name.hi", NO_IDS), plain("रवि शर्मा"));
        assert_eq!(resolve_in(&profile, "address.city", NO_IDS), plain("Bengaluru"));
        assert_eq!(resolve_in(&profile, "address.pin", NO_IDS), plain("560102"));
        assert_eq!(resolve_in(&profile, "work.id", NO_IDS), plain("NW-20417"));
        assert_eq!(resolve_in(&profile, "address", NO_IDS), plain("Flat 702, Lotus Towers, 14th Main, HSR Layout, Bengaluru 560102, Karnataka"));
    }

    #[test]
    fn a_name_splits_into_first_and_last_for_forms_with_two_boxes() {
        let mut profile = ravi();
        assert_eq!(resolve_in(&profile, "name.first", NO_IDS), plain("Ravi Kumar"));
        assert_eq!(resolve_in(&profile, "name.last", NO_IDS), plain("Sharma"));
        profile.name.en = "Ravi".into();
        assert_eq!(resolve_in(&profile, "name.first", NO_IDS), plain("Ravi"));
        assert_eq!(resolve_in(&profile, "name.last", NO_IDS), None);
    }

    #[test]
    fn a_profile_with_nothing_added_is_empty_even_with_id_numbers_on() {
        assert!(Profile::default().is_empty());
        assert!(Profile { ids: true, email: "  ".into(), ..Profile::default() }.is_empty());
        assert!(!Profile { phone: "+91 98201 44317".into(), ..Profile::default() }.is_empty());
        assert_eq!(masked("id.pan", "ABCDE1234K"), "•••••1234K");
    }

    #[test]
    fn empty_values_and_unknown_keys_resolve_to_nothing() {
        let profile = ravi();
        assert_eq!(resolve_in(&profile, "phone.other", NO_IDS), None);
        assert_eq!(resolve_in(&profile, "password", NO_IDS), None);
        assert_eq!(resolve_in(&profile, "id.card", |_| Some("4111".into())), None);
        assert_eq!(resolve_in(&Profile::default(), "address", NO_IDS), None);
    }

    #[test]
    fn every_listed_key_resolves_on_a_full_profile() {
        let mut profile = ravi();
        profile.other_phone = "080 2345 6789".into();
        for key in KEYS {
            assert!(resolve_in(&profile, key, |kind| Some(format!("{kind}-number"))).is_some(), "{key}");
        }
    }

    #[test]
    fn id_numbers_always_ask_first_and_are_not_read_while_off() {
        let mut profile = ravi();
        let ids = |kind: &str| (kind == "pan").then(|| "ABCDE1234K".to_string());
        assert_eq!(resolve_in(&profile, "id.pan", ids), Some(Value::AskFirst("ABCDE1234K".into())));
        assert_eq!(resolve_in(&profile, "id.aadhaar", ids), None);
        profile.ids = false;
        assert_eq!(resolve_in(&profile, "id.pan", |_| panic!("read while off")), None);
    }

    #[test]
    fn a_pin_code_has_six_digits() {
        let mut profile = ravi();
        for (pin, ok) in [("560102", true), ("56010", false), ("5601022", false), ("56O102", false), ("", true)] {
            profile.address.pin = pin.into();
            assert_eq!(problem(&profile).is_none(), ok, "{pin}");
        }
        profile.address.pin = "56010".into();
        assert_eq!(problem(&profile), Some("A PIN code has 6 digits."));
    }

    #[test]
    fn emails_and_phones_are_checked_when_filled() {
        for (email, ok) in [("ravi@gmail.com", true), ("ravi.s@northwind.co.in", true), ("ravi", false), ("ravi@gmail", false), ("ra vi@gmail.com", false), ("@gmail.com", false), ("a@b@c.com", false)] {
            assert_eq!(looks_like_email(email), ok, "{email}");
        }
        for (phone, ok) in [("+91 98201 44317", true), ("9820144317", true), ("080-2345-6789", true), ("(080) 2345 6789", true), ("98201", false), ("98201 4431x", false), ("91+9820144317", false)] {
            assert_eq!(looks_like_phone(phone), ok, "{phone}");
        }
        let mut profile = ravi();
        profile.work.email = "ravi.s@northwind".into();
        assert_eq!(problem(&profile), Some("An email looks like name@example.com."));
    }

    #[test]
    fn a_date_of_birth_is_a_real_day_in_the_past() {
        assert!(is_birth("1991-08-14"));
        assert!(!is_birth("1991-02-30"));
        assert!(!is_birth("14/08/1991"));
        assert!(!is_birth("1850-01-01"));
        assert!(!is_birth(&(Local::now().date_naive() + chrono::Days::new(1)).format("%Y-%m-%d").to_string()));
    }

    #[test]
    fn id_numbers_are_tidied_checked_and_masked() {
        assert_eq!(tidy_id(" abcde 1234k "), "ABCDE1234K");
        assert_eq!(tidy_id("1234 5678 8823"), "123456788823");
        assert_eq!(id_problem("pan", "ABCDE1234K"), None);
        assert_eq!(id_problem("pan", "ABCD12345K"), Some("A PAN looks like ABCDE1234F."));
        assert_eq!(id_problem("aadhaar", "123456788823"), None);
        assert_eq!(id_problem("aadhaar", "12345678882"), Some("An Aadhaar number has 12 digits."));
        assert_eq!(id_problem("passport", "A1234567"), None);
        assert_eq!(id_problem("passport", "ABCDEFG"), Some("A passport number has 6 to 9 letters and digits."));
        assert_eq!(mask("pan", "ABCDE1234K"), "•••••1234K");
        assert_eq!(mask("aadhaar", "123456788823"), "•••• •••• 8823");
        assert_eq!(mask("passport", "A1234567"), "••••4567");
    }

    #[test]
    fn saving_trims_refuses_a_wrong_value_and_round_trips() {
        let path = scratch("save");
        let mut profile = ravi();
        profile.name.en = "  Ravi Kumar Sharma ".into();
        let kept = save_to(&path, profile, || Ok(())).unwrap();
        assert_eq!(kept.name.en, "Ravi Kumar Sharma");
        assert_eq!(load(&path), kept);

        let mut wrong = kept.clone();
        wrong.address.pin = "56010".into();
        assert_eq!(save_to(&path, wrong, || Ok(())), Err("A PIN code has 6 digits.".into()));
        assert_eq!(load(&path), kept);
    }

    #[test]
    fn turning_id_numbers_off_removes_them() {
        let path = scratch("ids-off");
        save_to(&path, ravi(), || panic!("cleared while turning on")).unwrap();
        let cleared = std::cell::Cell::new(false);
        save_to(&path, Profile { ids: false, ..ravi() }, || {
            cleared.set(true);
            Ok(())
        })
        .unwrap();
        assert!(cleared.get());
    }

    #[test]
    fn a_broken_file_is_set_aside_and_deleting_twice_is_fine() {
        let path = scratch("broken");
        std::fs::write(&path, "{ not json").unwrap();
        assert_eq!(load(&path), Profile::default());
        assert!(path.with_extension("json.bad").exists());
        save_to(&path, ravi(), || Ok(())).unwrap();
        delete_at(&path).unwrap();
        delete_at(&path).unwrap();
        assert_eq!(load(&path), Profile::default());
    }

    #[test]
    fn only_the_three_id_numbers_reach_credential_manager() {
        assert!(id_entry("card").is_err());
        assert!(id_entry("../pan").is_err());
    }

    #[test]
    #[ignore = "writes to the real Credential Manager, under a test account"]
    fn an_id_number_round_trips_through_credential_manager() {
        let entry = Entry::new(SERVICE, "details/test-roundtrip").unwrap();
        entry.set_password("ABCDE1234K").unwrap();
        assert_eq!(entry.get_password().unwrap(), "ABCDE1234K");
        entry.delete_credential().unwrap();
        assert!(matches!(entry.get_password(), Err(keyring::Error::NoEntry)));
    }
}
