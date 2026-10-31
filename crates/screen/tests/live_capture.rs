//! Real capture and OCR against a window this test owns, so it never reads what
//! you are working on and does not need focus. A small window appears briefly.
//!
//!     cargo test -p screen --test live_capture -- --ignored

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use windows::core::HSTRING;
use windows::Win32::UI::WindowsAndMessaging::FindWindowW;

const TITLE: &str = "Meridian live capture test";

fn find_window() -> Option<isize> {
    let hwnd = unsafe { FindWindowW(None, &HSTRING::from(TITLE)) }.ok()?;
    Some(hwnd.0 as isize)
}

/// Read-only, and it prints no titles, because a title can hold anything.
#[test]
#[ignore = "reads the real desktop"]
fn lists_what_a_capture_could_show() {
    let front = screen::foreground().expect("a window in front");
    let display = screen::windows_in_view(front.hwnd, true).expect("whole screen");
    let above = screen::windows_in_view(front.hwnd, false).expect("window");
    assert!(display.iter().any(|window| window.hwnd == front.hwnd), "the target is on its own display");
    assert!(!above.iter().any(|window| window.hwnd == front.hwnd), "the walk stops at the target");
    let names = |windows: &[screen::WindowInfo]| windows.iter().map(|w| w.process.clone()).collect::<Vec<_>>();
    println!("whole screen: {} windows, {:?}", display.len(), names(&display));
    println!("above the target: {} windows, {:?}", above.len(), names(&above));
}

#[test]
#[ignore = "opens a real window"]
fn reads_a_real_window_and_finds_the_error() {
    let script = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/live/target-window.ps1");
    let mut child = Command::new("powershell")
        .args(["-NoProfile", "-File", script, "-Title", TITLE, "-TopMost", "-Seconds", "15"])
        .args(["-Text", "terraform plan|Error: Invalid reference|on main.tf line 12"])
        .stdout(Stdio::null())
        .spawn()
        .unwrap();

    let deadline = Instant::now() + Duration::from_secs(12);
    let hwnd = loop {
        if let Some(hwnd) = find_window() {
            break hwnd;
        }
        assert!(Instant::now() < deadline, "the test window never appeared");
        std::thread::sleep(Duration::from_millis(100));
    };
    // Let it paint.
    std::thread::sleep(Duration::from_millis(800));

    let frame = screen::capture_window(hwnd).expect("capture");
    assert!(frame.width > 400 && frame.height > 200, "{}x{}", frame.width, frame.height);

    let text = screen::ocr(&frame).expect("ocr");
    assert!(text.contains("Invalid reference"), "{text}");
    assert!(text.contains("main"), "{text}");

    let signals = screen::detect(&text);
    assert_eq!(signals[0].kind, screen::SignalKind::Terraform);

    let jpeg = screen::to_jpeg(&frame).expect("jpeg");
    assert_eq!(&jpeg[..2], &[0xFF, 0xD8], "not a JPEG");

    let part = screen::crop(&frame, 0.0, 0.2, 1.0, 0.5).expect("crop");
    assert!(screen::ocr(&part).expect("ocr of a crop").contains("Invalid"));

    let _ = child.kill();
}
