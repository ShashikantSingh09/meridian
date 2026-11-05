//! Quiets other apps while the user talks to the assistant. See `media::Hush`.

use media::Hush;
use tauri::{Manager, State};

/// Gives back whatever a crashed run left muted, then hands over the state to manage. Both happen
/// on the one worker, in that order, so a quick first `hush_on` cannot race the old record.
pub fn restore_on_start(app: &tauri::App) -> tauri::Result<Hush> {
    Ok(Hush::new(app.path().app_local_data_dir()?.join("hushed.json")))
}

#[tauri::command]
pub fn hush_on(hush: State<'_, Hush>, leave_calls: bool) {
    hush.on(leave_calls, std::process::id());
}

#[tauri::command]
pub fn hush_off(hush: State<'_, Hush>) {
    hush.off();
}
