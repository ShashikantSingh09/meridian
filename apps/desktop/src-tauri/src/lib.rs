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
mod secrets;
mod settings;

use commands::Core;

fn toggle(app: &AppHandle) {
    let _ = app.emit_to(island::LABEL, "island-toggle", ());
}

fn build_tray(app: &App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Meridian", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &settings, &quit])?;

    let mut tray = TrayIconBuilder::new()
        .tooltip("Meridian")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => toggle(app),
            "settings" => {
                let _ = app.emit_to(island::LABEL, "island-open-tab", "settings");
            }
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

fn register_shortcut(app: &App) {
    let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space);
    let handle = app.handle().clone();
    let registered = app.global_shortcut().on_shortcut(shortcut, move |_, _, event| {
        if event.state == ShortcutState::Pressed {
            toggle(&handle);
        }
    });
    // Another app may own the combination. The tray still opens the panel.
    if let Err(err) = registered {
        eprintln!("global shortcut unavailable: {err}");
    }
}

fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let path = settings::path(&handle).ok_or("no config directory")?;
    let settings = Mutex::new(settings::load(&path));

    let emitter = handle.clone();
    let sessions = tauri::async_runtime::block_on(Sessions::new(move |envelope| {
        let _ = emitter.emit_to(island::LABEL, "agent-event", envelope);
    }))?;

    let gate = Arc::new(island::Gate::default());
    app.manage(Core { settings, gate: gate.clone(), sessions, chats: Mutex::new(HashMap::new()) });

    let win = app.get_webview_window(island::LABEL).ok_or("island window missing")?;
    island::restrict_permissions(&win);
    island::place(&handle, &win);
    if let Some(hwnd) = island::hwnd(&win) {
        glass::attach(hwnd);
    }
    win.show()?;
    island::prepare(&win, &gate);
    island::spawn_poll(handle, gate);

    build_tray(app)?;
    register_shortcut(app);
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
            commands::open_project,
        ])
        .setup(setup)
        .run(tauri::generate_context!())
        .expect("Meridian failed to start");
}
