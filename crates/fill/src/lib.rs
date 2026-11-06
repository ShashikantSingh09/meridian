//! Fill in the page: the shared engine behind Write here, Fill this form and
//! Finish this for me.
//!
//! The AI proposes and Meridian acts. A run goes:
//! 1. [`Reader::target`] names the window in front, and [`access`] says whether
//!    Meridian may work there at all, before a single box is read;
//! 2. [`Reader::focused`] or [`Reader::fields`] reads the boxes you can see, and
//!    [`refusal`] sets aside the ones that are yours (passwords, cards, codes,
//!    CAPTCHA, "I agree", uploads);
//! 3. the AI returns a [`Mapping`], and [`check`] keeps only what may be written;
//! 4. [`write`] puts each value in with the writer ladder, and [`UndoLog`] can put
//!    each box back.
//!
//! Nothing here submits, sends or presses Enter. The platform layer is the
//! [`Reader`] and [`Writer`] traits: Windows has [`Uia`], and a Mac reader and
//! writer can implement the same two traits.

mod finish;
mod form;
mod mapping;
mod model;
mod policy;
mod undo;
#[cfg(windows)]
mod win;
mod write;

#[cfg(test)]
mod fake;

pub use finish::{commit, same_site, Commit, Step};
pub mod steps {
    //! Finish this for me's rules for each step, by name: `steps::press`, `steps::fill`, `steps::go`, `steps::landed`.
    pub use crate::finish::{fill, go, landed, press};
}
pub use form::{Form, Given, Lookup, Origin, Row, State};
pub use mapping::{check, id_kind, is_id_key, Answer, Checked, Fill, Mapping, Problem, Source, ID_KEYS, MAX_TEXT};
pub use model::{site_from_address, Bounds, Field, FieldKind, Target, MAX_VALUE, MIN_SIDE};
pub use policy::{access, is_browser, refusal, Access, Refusal};
pub use undo::{Undone, UndoLog};
#[cfg(windows)]
pub use win::{copy, pasted, Uia};
pub use write::{write, yes_no, Method, Mode, Need, Written, Writer};

/// Messages are shown to the user as they are, and never hold a box's value.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FillError {
    #[error("Nothing is in front.")]
    NoWindow,
    #[error("Click in a text box first.")]
    NoBox,
    #[error("You moved to another box, so nothing was put in.")]
    Moved,
    #[error("You moved to another window, so Meridian stopped.")]
    WindowChanged,
    #[error("That box is no longer there.")]
    Gone,
    #[error("That box is hidden, and hidden boxes are never filled.")]
    Hidden,
    #[error("{0}")]
    Refused(Refusal),
    #[error("{0}")]
    NeedsYou(String),
    /// The box shows something unexpected after a write. Nothing more is tried, so
    /// nothing is written twice.
    #[error("The box shows something else after writing, so Meridian stopped. Check it.")]
    Uncertain,
    #[error("{0}")]
    Blocked(String),
    #[error("{0}")]
    Clipboard(String),
    #[error("Windows could not read or change the box: {0}")]
    Platform(String),
}

/// The platform's eyes. Read the target first: the other reads work in that window
/// and fail with [`FillError::WindowChanged`] once another window is in front.
/// Each read of boxes starts their ids again from 0.
pub trait Reader {
    /// The window in front: its app, its title and, for a browser, its site.
    fn target(&mut self) -> Result<Target, FillError>;
    /// The box with the keyboard cursor, for Write here.
    fn focused(&mut self) -> Result<Field, FillError>;
    /// Every box you can see in the window, in page order, for Fill this form.
    /// Hidden, off-screen and tiny boxes are left out.
    fn fields(&mut self) -> Result<Vec<Field>, FillError>;
    /// Up to `limit` characters of the window's text, for context. After
    /// [`Reader::focused`], the text leading up to that box: the conversation above a reply.
    fn text(&mut self, limit: usize) -> Result<String, FillError>;
}
