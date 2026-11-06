//! The desktop shell: wires the window, tray, shortcut and core services
//! together. Provider and agent logic lives in crates/ and knows nothing of Tauri.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use agent_adapters::Sessions;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

mod actions;
mod cards;
mod commands;
mod details;
mod following;
mod here;
mod hush;
mod island;
mod knowledge;
mod life;
mod links;
mod log;
mod notetaker;
mod secrets;
mod settings;
mod style;
mod terminal;
mod update;
mod voice;
mod wake;
mod watch;

use commands::Core;

fn toggle(app: &AppHandle) {
    reveal(app);
    let _ = app.emit_to(island::LABEL, "island-toggle", ());
}

/// Anything that asks for the island brings a hidden one back.
fn reveal(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(island::LABEL) {
        island::set_user_hidden(&win, &app.state::<Core>().gate, false);
    }
}

/// The one control that stops all contextual monitoring, from anywhere.
fn toggle_monitoring(app: &AppHandle) {
    let core = app.state::<Core>();
    let settings = {
        let mut s = core.settings.lock().unwrap();
        s.monitoring_paused = !s.monitoring_paused;
        s.clone()
    };
    if let Some(path) = settings::path(app) {
        let _ = settings::save(&path, &settings);
    }
    let _ = app.emit_to(island::LABEL, "settings-changed", settings);
}

/// The only way out, so no agent outlives the app.
fn quit(app: &AppHandle) {
    app.state::<Core>().sessions.shutdown();
    // Other apps get their sound back, and the terminal hooks go until the next start, so nothing
    // else can answer on their address while the app is closed.
    app.state::<media::Hush>().release();
    app.state::<following::Following>().withdraw();
    // Give adapters a moment to end their process trees.
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(400));
        app.exit(0);
    });
}

fn toggle_visibility(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(island::LABEL) {
        let gate = &app.state::<Core>().gate;
        island::set_user_hidden(&win, gate, !island::user_hidden(gate));
    }
}

fn build_tray(app: &App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Meridian", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "visibility", "Show or hide island", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "Pause or resume monitoring", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &settings, &hide, &pause, &quit])?;

    let mut tray = TrayIconBuilder::new()
        .tooltip("Meridian")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => toggle(app),
            "settings" => {
                reveal(app);
                let _ = app.emit_to(island::LABEL, "island-open-tab", "settings");
            }
            "visibility" => toggle_visibility(app),
            "pause" => toggle_monitoring(app),
            "quit" => crate::quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                toggle(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn register_shortcuts(app: &App) {
    let open = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space);
    let handle = app.handle().clone();
    let opened = app.global_shortcut().on_shortcut(open, move |_, _, event| {
        if event.state == ShortcutState::Pressed {
            toggle(&handle);
        }
    });
    let capture = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyS);
    let handle = app.handle().clone();
    let captured = app.global_shortcut().on_shortcut(capture, move |_, _, event| {
        if event.state == ShortcutState::Pressed {
            reveal(&handle);
            let _ = handle.emit_to(island::LABEL, "screen-capture-request", ());
        }
    });
    // Held to talk, so the interface needs both the press and the release.
    let talk = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyV);
    let handle = app.handle().clone();
    let talking = app.global_shortcut().on_shortcut(talk, move |_, _, event| {
        let _ = handle.emit_to(island::LABEL, "voice-key", event.state == ShortcutState::Pressed);
    });
    // Another app may own a combination. The tray and the panel still work.
    for result in [opened, captured, talking] {
        if let Err(err) = result {
            eprintln!("global shortcut unavailable: {err}");
        }
    }
}

fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    log::on_panic(app.path().app_log_dir()?);
    app.manage(links::state(app)?);
    app.manage(following::state(app)?);
    // This also gives back sound a crash left muted.
    app.manage(hush::restore_on_start(app)?);
    app.manage(voice::state(app)?);
    app.manage(wake::Wake::default());
    app.manage(notetaker::state(app)?);
    app.manage(style::state(app)?);
    app.manage(knowledge::state(app)?);
    app.manage(cards::state(app)?);
    app.manage(here::state(app)?);
    let path = settings::path(&handle).ok_or("no config directory")?;
    let settings = settings::load(&path);
    let placement = settings.clone();
    let settings = Mutex::new(settings);

    let emitter = handle.clone();
    let sessions = tauri::async_runtime::block_on(Sessions::new(move |envelope| {
        let _ = emitter.emit_to(island::LABEL, "agent-event", envelope);
    }))?;

    let emitter = handle.clone();
    let now_playing: Arc<Mutex<Option<media::Track>>> = Arc::default();
    let playing = now_playing.clone();
    let media = media::watch(move |snapshot| {
        *playing.lock().unwrap() = snapshot.current.clone();
        let _ = emitter.emit_to(island::LABEL, "media-state", snapshot);
    });

    let emitter = handle.clone();
    media::levels::watch(move |level| {
        let _ = emitter.emit_to(island::LABEL, "level-change", level);
    });

    let tools_url = tauri::async_runtime::block_on(actions::start(handle.clone()))?;
    sessions.set_assistant(actions::setup(&tools_url, &settings.lock().unwrap()));
    let gate = Arc::new(island::Gate::default());
    app.manage(Core {
        settings,
        gate: gate.clone(),
        sessions,
        chats: Mutex::new(HashMap::new()),
        frame: Mutex::new(None),
        media,
        now_playing,
        tools_url,
    });

    let win = app.get_webview_window(island::LABEL).ok_or("island window missing")?;
    island::restrict_permissions(&win);
    island::place(&handle, &win, &gate, &placement);
    island::prepare(&win, &gate);
    island::show_quietly(&win);
    island::spawn_poll(handle.clone(), gate);
    watch::spawn(handle.clone());
    following::resume(&handle);
    following::watch_running(&handle);
    wake::spawn(handle.clone());
    knowledge::spawn(handle.clone());
    cards::spawn(handle.clone());
    here::sync_key(&handle, &placement);
    life::spawn(handle);

    build_tray(app)?;
    register_shortcuts(app);
    Ok(())
}

/// The island only ever shows the app's own pages. Anything else, a dropped file, a link that slipped
/// through, is refused before it loads, because every page here can reach the app's commands.
fn bundled(url: &tauri::Url) -> bool {
    match (url.scheme(), url.host_str()) {
        ("tauri", _) | ("http" | "https", Some("tauri.localhost")) => true,
        ("about", _) => url.as_str() == "about:blank",
        ("http", Some("localhost")) => cfg!(debug_assertions) && url.port() == Some(1420),
        _ => false,
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| toggle(app)))
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri::plugin::Builder::<tauri::Wry>::new("stay-home").on_navigation(|_, url| bundled(url)).build())
        .on_window_event(|window, event| {
            // Click-away closes the panel, like any flyout.
            if let WindowEvent::Focused(false) = event {
                let _ = window.emit_to(island::LABEL, "island-blur", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::island_set_rect,
            commands::island_drag,
            commands::island_gaze,
            commands::island_reset,
            commands::island_placement,
            commands::battery_now,
            commands::island_set_interactive,
            commands::settings_get,
            commands::settings_save,
            commands::monitors_list,
            commands::agent_auth,
            commands::agent_login,
            commands::assistant_dir,
            commands::providers_list,
            commands::provider_set_key,
            commands::provider_clear_key,
            commands::provider_models,
            commands::provider_test,
            commands::providers_discover,
            commands::chat_stream,
            commands::chat_cancel,
            commands::agents_detect,
            commands::session_start,
            commands::session_send,
            commands::session_adopt,
            commands::session_cancel,
            commands::session_answer,
            commands::media_action,
            life::activity_list,
            life::activity_dismiss,
            life::activity_delete,
            life::activity_snooze,
            life::activity_correct,
            life::activity_add_reminder,
            life::activity_import,
            life::activity_claude_mail,
            life::activity_context,
            life::reminder_log,
            life::accounts_list,
            life::account_connect,
            life::account_disconnect,
            life::account_sync,
            life::open_url,
            life::built_in_clients,
            notetaker::notes_state,
            notetaker::notes_resume,
            notetaker::notes_start,
            notetaker::notes_stop,
            notetaker::note_audio,
            notetaker::notes_rename,
            notetaker::notes_rename_speaker,
            notetaker::notes_toggle_todo,
            notetaker::notes_delete,
            notetaker::notes_retry,
            notetaker::notes_summarize,
            notetaker::notes_markdown,
            notetaker::notes_export,
            life::claude_connectors,
            commands::screen_capture,
            commands::screen_crop,
            commands::screen_discard,
            watch::screen_ignore,
            commands::open_project,
            commands::app_version,
            update::update_check,
            update::update_install,
            update::update_kind,
            hush::hush_on,
            hush::hush_off,
            notetaker::notes_keep_going,
            actions::assistant_context,
            terminal::terminal_focus,
            terminal::terminal_in_front,
            commands::open_logs,
            voice::voice_status,
            voice::voice_list,
            voice::voice_key_set,
            voice::voice_key_clear,
            voice::voice_download,
            voice::voice_remove,
            voice::voice_speak,
            voice::voice_stop,
            voice::voice_hear_start,
            voice::voice_hear,
            voice::voice_hear_end,
            wake::wake_status,
            wake::wake_test,
            wake::wake_audio,
            wake::wake_taught,
            wake::wake_teach_sample,
            wake::wake_teach_end,
            wake::wake_forget,
            following::running_refresh,
            following::watch_preview,
            following::watch_status,
            following::hooks_health,
            following::watch_set,
            links::integrations_list,
            links::ai_sign_in,
            links::integration_connect,
            links::integration_disconnect,
            links::integration_fetch,
            details::details_get,
            details::details_save,
            details::details_delete,
            details::details_ids,
            details::details_id_show,
            details::details_id_set,
            style::style_get,
            style::style_learn,
            style::style_stop,
            style::style_set_line,
            style::style_forget,
            knowledge::knowledge_state,
            knowledge::knowledge_update,
            knowledge::knowledge_stop,
            knowledge::knowledge_search,
            knowledge::knowledge_read,
            knowledge::knowledge_save,
            knowledge::knowledge_tick,
            knowledge::knowledge_open,
            cards::cards_state,
            cards::cards_check,
            cards::cards_hide,
            cards::cards_dismiss,
            cards::cards_draft,
            cards::cards_set_draft,
            here::here_start,
            here::here_retry,
            here::here_rewrite,
            here::here_undo,
            here::here_copy,
            here::here_stop,
            here::here_done,
            here::here_offer,
            here::fill_place_set,
            here::fill_place_forget,
        ])
        .setup(setup)
        .run(tauri::generate_context!())
        .expect("Meridian failed to start");
}

#[cfg(test)]
mod tests {
    use super::bundled;

    #[test]
    fn the_island_never_leaves_its_own_pages() {
        for url in ["http://tauri.localhost/index.html", "https://tauri.localhost/", "tauri://localhost/", "about:blank"] {
            assert!(bundled(&url.parse().unwrap()), "{url}");
        }
        for url in ["file:///C:/Users/x/probe.html", "https://example.com/", "http://127.0.0.1:9/", "http://tauri.localhost.evil.com/", "about:srcdoc"] {
            assert!(!bundled(&url.parse().unwrap()), "{url}");
        }
    }
}
