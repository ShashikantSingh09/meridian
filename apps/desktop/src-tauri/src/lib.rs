//! The desktop shell: wires the window, tray, shortcut and core services
//! together. Provider and agent logic lives in crates/ and knows nothing of Tauri.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use agent_adapters::Sessions;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

mod commands;
mod glass;
mod island;
mod life;
mod secrets;
mod settings;
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
            "quit" => {
                app.state::<Core>().sessions.shutdown();
                // Give adapters a moment to end their process trees.
                let app = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(400));
                    app.exit(0);
                });
            }
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
    // Another app may own a combination. The tray and the panel still work.
    for result in [opened, captured] {
        if let Err(err) = result {
            eprintln!("global shortcut unavailable: {err}");
        }
    }
}

fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let path = settings::path(&handle).ok_or("no config directory")?;
    let settings = settings::load(&path);
    let placement = (settings.island_monitor.clone(), settings.island_align.clone());
    let settings = Mutex::new(settings);

    let emitter = handle.clone();
    let sessions = tauri::async_runtime::block_on(Sessions::new(move |envelope| {
        let _ = emitter.emit_to(island::LABEL, "agent-event", envelope);
    }))?;

    let emitter = handle.clone();
    let media = media::watch(move |snapshot| {
        let _ = emitter.emit_to(island::LABEL, "media-state", snapshot);
    });

    let gate = Arc::new(island::Gate::default());
    app.manage(Core {
        settings,
        gate: gate.clone(),
        sessions,
        chats: Mutex::new(HashMap::new()),
        frame: Mutex::new(None),
        media,
    });

    let win = app.get_webview_window(island::LABEL).ok_or("island window missing")?;
    island::restrict_permissions(&win);
    island::place(&handle, &win, &gate, &placement.0, &placement.1);
    if let Some(hwnd) = island::hwnd(&win) {
        glass::attach(hwnd);
    }
    island::prepare(&win, &gate);
    island::show_quietly(&win);
    island::spawn_poll(handle.clone(), gate);
    watch::spawn(handle.clone());
    life::spawn(handle);

    build_tray(app)?;
    register_shortcuts(app);
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| toggle(app)))
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .on_window_event(|window, event| {
            // Click-away closes the panel, like any flyout.
            if let WindowEvent::Focused(false) = event {
                let _ = window.emit_to(island::LABEL, "island-blur", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::island_set_rect,
            commands::island_set_interactive,
            commands::glass_active,
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
            life::activity_context,
            life::reminder_log,
            life::accounts_list,
            life::account_connect,
            life::account_disconnect,
            life::account_sync,
            life::open_url,
            commands::screen_capture,
            commands::screen_crop,
            commands::screen_discard,
            watch::screen_ignore,
            commands::open_project,
        ])
        .setup(setup)
        .run(tauri::generate_context!())
        .expect("Meridian failed to start");
}
