//! Understanding what is on screen, on this machine. Capture and OCR are local:
//! this crate has no network code at all, so nothing here can upload anything.
//! Sending a capture anywhere is a separate, user-approved step in the app.

mod capture;
mod ocr;
mod policy;
mod signals;

pub use capture::{capture_screen_of, capture_window, crop, foreground, window_at, Frame, WindowInfo};
pub use ocr::{ocr, to_jpeg};
pub use policy::{exclusion_reason, DEFAULT_EXCLUSIONS};
pub use signals::{detect, Signal, SignalKind};

#[derive(Debug, thiserror::Error)]
pub enum ScreenError {
    #[error("Nothing to capture: no active window.")]
    NoWindow,
    #[error("Screen capture failed: {0}")]
    Capture(String),
    #[error("Text recognition is unavailable: {0}")]
    Ocr(String),
}

impl From<windows::core::Error> for ScreenError {
    fn from(err: windows::core::Error) -> Self {
        Self::Capture(err.message())
    }
}
