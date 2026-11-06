//! Real UI Automation, clipboard and keys against the local test page. Every test is
//! ignored: each one reads, and most type into, whatever window is in front, so
//! only a person runs them, by hand, one at a time.
//!
//! 1. Open `tests/fill/forms.html` in Chrome or Edge (drag the file onto a window),
//!    and zoom out until the whole page fits: only boxes on screen are read.
//! 2. In a terminal, from the repo root, run one test:
//!
//!        cargo test -p fill --test live_forms -- --ignored --nocapture --test-threads 1 <test name>
//!
//! 3. Within 5 seconds, click where the test's comment says, then leave the mouse
//!    and keyboard alone until it ends. Each test prints what it read.
//! 4. Afterwards, check "What the page saw" at the bottom of the page: no "Enter
//!    pressed", no "Tab pressed", no "Submitted" and no "A trap box was filled".

#![cfg(windows)]

use std::process::Command;
use std::time::Duration;

use fill::{access, refusal, write, Access, Field, FieldKind, FillError, Method, Mode, Reader, Refusal, Uia, UndoLog, Undone, Writer};

fn after_click(what: &str) -> Uia {
    println!("Click {what} within 5 seconds.");
    std::thread::sleep(Duration::from_secs(5));
    let mut uia = Uia::new().expect("UI Automation");
    let target = uia.target().expect("a window in front");
    println!("target: {} {:?}", target.process, target.site);
    assert!(fill::is_browser(&target.process), "the browser must be in front, not {}", target.process);
    assert_eq!(target.site.as_deref(), Some("file:"), "the test page must be open");
    assert_eq!(access(&target), Access::Usual);
    uia
}

fn find<'a>(fields: &'a [Field], label: &str) -> &'a Field {
    fields.iter().find(|field| field.label.contains(label)).unwrap_or_else(|| panic!("no box called {label}"))
}

fn print(fields: &[Field]) {
    for field in fields {
        println!("{:>2} {:<10?} required={:<5} {:?} = {:?}", field.id, field.kind, field.required, field.label, field.value);
    }
}

fn page_text(uia: &mut Uia) -> String {
    uia.text(50_000).expect("page text")
}

fn clipboard() -> String {
    let out = Command::new("powershell").args(["-NoProfile", "-Command", "Get-Clipboard -Raw"]).output().unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn set_clipboard(text: &str) {
    let script = format!("Set-Clipboard -Value '{text}'");
    assert!(Command::new("powershell").args(["-NoProfile", "-Command", &script]).status().unwrap().success());
}

/// Click on the page background, not in a box. Reads only.
#[test]
#[ignore = "reads the window in front; run by hand against tests/fill/forms.html"]
fn reads_every_box_on_the_test_page_and_no_trap() {
    let mut uia = after_click("on the test page's background");
    let fields = uia.fields().expect("fields");
    print(&fields);
    assert_eq!(find(&fields, "Full name").kind, FieldKind::PlainText);
    assert!(find(&fields, "Full name").required);
    assert_eq!(find(&fields, "पूरा नाम").kind, FieldKind::PlainText);
    assert_eq!(find(&fields, "Email").kind, FieldKind::Email);
    assert_eq!(find(&fields, "मोबाइल नंबर").kind, FieldKind::Phone);
    assert_eq!(find(&fields, "Why do you want").kind, FieldKind::MultiLine);
    assert_eq!(find(&fields, "Cover note").kind, FieldKind::RichText);
    assert_eq!(find(&fields, "Start date").kind, FieldKind::Date);
    assert_eq!(find(&fields, "Notice period").kind, FieldKind::List);
    assert_eq!(find(&fields, "Work mode: Remote").kind, FieldKind::Radio);
    assert_eq!(find(&fields, "Same as billing").kind, FieldKind::Checkbox);
    assert_eq!(find(&fields, "Create a password").kind, FieldKind::Password);
    assert_eq!(find(&fields, "Your CV").kind, FieldKind::File);
    assert_eq!(refusal(find(&fields, "Enter OTP")), Some(Refusal::OneTimeCode));
    assert_eq!(refusal(find(&fields, "Card number")), Some(Refusal::CardNumber));
    assert_eq!(refusal(find(&fields, "I agree")), Some(Refusal::Consent));
    assert!(fields.iter().all(|field| !field.label.contains("Trap")), "trap boxes are never read");
    assert!(fields.iter().all(|field| field.kind != FieldKind::Button), "plain buttons are not boxes");
    assert_eq!(find(&fields, "Message").kind, FieldKind::RichText, "every box on the page counts, in a form or not");
    assert!(!fields.iter().any(|field| field.label.contains("Address and search")), "the browser's address bar is not the page");
}

/// Click on the page background. Fills the form through the ladder, checks what the
/// page took, then undoes it all. Uses your clipboard and puts it back.
#[test]
#[ignore = "types into the window in front; run by hand against tests/fill/forms.html"]
fn fills_the_test_page_and_puts_every_box_back() {
    let mut uia = after_click("on the test page's background");
    let fields = uia.fields().expect("fields");
    let mut log = UndoLog::new(Mode::Form);
    for (label, text) in [
        ("Full name", "Ravi Sharma"),
        ("पूरा नाम", "रवि शर्मा"),
        ("मोबाइल नंबर", "+91 98201 44317"),
        ("React name", "Ravi"),
        ("Why do you want", "I build payment screens.\nUPI for kirana stores is next."),
        ("Cover note", "Hello from Meridian"),
        ("Notice period", "60 days"),
        ("Work mode: Remote", "yes"),
        ("Same as billing", "yes"),
    ] {
        let field = find(&fields, label);
        let written = write(&mut uia, field, text, Mode::Form).unwrap_or_else(|error| panic!("{label}: {error}"));
        println!("{label}: {:?}", written.method);
        log.record(field, written);
    }
    std::thread::sleep(Duration::from_millis(300));
    let seen = page_text(&mut uia);
    assert!(seen.contains("React state: Ravi"), "the React box kept the value:\n{seen}");
    assert!(seen.contains("Cover note model: Hello from Meridian"), "the editor's model took the paste:\n{seen}");
    for never in ["Enter pressed", "Tab pressed", "Submitted", "A trap box was filled"] {
        assert!(!seen.contains(never), "{never}:\n{seen}");
    }

    let date = write(&mut uia, find(&fields, "Start date"), "2026-12-01", Mode::Form);
    println!("Start date: {date:?}");
    assert!(matches!(date, Ok(_) | Err(FillError::NeedsYou(_))), "a date is set directly or left to you");

    let undone = log.undo(&mut uia);
    println!("{undone:?}");
    assert!(undone.iter().all(|(_, result)| *result == Undone::PutBack || *result == Undone::Failed("A choice is cleared by picking another one.".into())));
}

/// Click in the Message box at the bottom (a chat box where Enter sends).
#[test]
#[ignore = "pastes into the window in front and uses the clipboard; run by hand against tests/fill/forms.html"]
fn write_here_pastes_a_reply_and_keeps_the_clipboard() {
    set_clipboard("kept by the test");
    let mut uia = after_click("in the Message box");
    let field = uia.focused().expect("the Message box");
    assert_eq!(field.kind, FieldKind::RichText);
    println!("context: {:?}", uia.text(300).expect("text"));
    let written = write(&mut uia, &field, "Hi Asha,\n\n4 pm works for me.", Mode::Here).expect("write");
    assert_eq!(written.method, Method::Paste);
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(clipboard(), "kept by the test", "the clipboard was put back");
    let seen = page_text(&mut uia);
    assert!(seen.contains("4 pm works for me."), "the editor's model took it:\n{seen}");
    assert!(!seen.contains("Enter pressed"), "nothing was sent:\n{seen}");
    // Also check by hand: Win+V does not list "Hi Asha".
}

/// Click in the Message box at the bottom. Writes a reply, then selects it, as Write here does.
#[test]
#[ignore = "pastes into the window in front; run by hand against tests/fill/forms.html"]
fn the_reply_written_here_is_left_selected() {
    let mut uia = after_click("in the Message box");
    let field = uia.focused().expect("the Message box");
    let reply = "Hi Asha,\n\nThanks, see you at 4.";
    write(&mut uia, &field, reply, Mode::Here).expect("write");
    uia.select(field.id, reply).expect("selected");
    // Check by hand: the reply shows selected, and typing a letter replaces it.
    assert!(page_text(&mut uia).contains("see you at 4"));
}

/// Click in "पूरा नाम (हिंदी में)". Types Devanagari with SendInput, then reads it back.
#[test]
#[ignore = "types into the window in front; run by hand against tests/fill/forms.html"]
fn typing_carries_hindi() {
    let mut uia = after_click("in the box called पूरा नाम");
    let field = uia.focused().expect("the Hindi box");
    uia.check(field.id, fill::Need::Focus).expect("still focused");
    uia.type_text(field.id, "रवि शर्मा", true).expect("typed");
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(uia.value(field.id).expect("read back"), "रवि शर्मा");
}

/// Click in "Create a password".
#[test]
#[ignore = "reads the window in front; run by hand against tests/fill/forms.html"]
fn write_here_never_types_into_a_password_box() {
    let mut uia = after_click("in Create a password");
    let field = uia.focused().expect("the password box");
    assert_eq!(field.kind, FieldKind::Password);
    assert_eq!(field.value, "", "a password box's value is never kept");
    assert_eq!(write(&mut uia, &field, "hunter2", Mode::Here), Err(FillError::Refused(Refusal::Password)));
}

/// Click in "Full name", then within 3 seconds click in "LinkedIn".
#[test]
#[ignore = "reads the window in front; run by hand against tests/fill/forms.html"]
fn a_write_stops_when_the_cursor_moved_to_another_box() {
    let mut uia = after_click("in Full name");
    let field = uia.focused().expect("Full name");
    println!("Now click in LinkedIn within 3 seconds.");
    std::thread::sleep(Duration::from_secs(3));
    assert_eq!(write(&mut uia, &field, "Ravi Sharma", Mode::Here), Err(FillError::Moved));
}
