//! What the assistant can do on this PC, offered to it as tools over a local MCP server, so the same
//! abilities the user has in the app are the ones it has when spoken to. Only this app's own agents
//! get the address, with a random token in the path.
//!
//! Tools named in `RUN_WITHOUT_ASKING` undo easily and go nowhere, so they just happen. Everything
//! else stops on the island for a yes first, through the permission hook every run already has.

use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use agent_adapters::approvals::{read_request, respond};
use agent_adapters::AssistantSetup;
use chrono::{DateTime, Local, NaiveDateTime};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::{TcpListener, TcpStream};

use crate::commands::{take_capture, Core};
use crate::settings::Settings;
use crate::{island, life};

const NO_WINDOW: u32 = 0x0800_0000;
const MOST_BYTES: usize = 1 << 20;
const READ_TIMEOUT: Duration = Duration::from_secs(5);
/// Apps change rarely, and asking Windows takes about a second.
const APPS_LAST: Duration = Duration::from_secs(300);
const MOST_FILES: usize = 25;
const MOST_LOOKED_AT: usize = 40_000;
const SCREEN_CHARS: usize = 6000;
const SERVER: &str = "meridian";
const RUN_WITHOUT_ASKING: [&str; 14] = [
    "open_app", "list_apps", "open_website", "search_web", "open_windows_settings", "open_path", "find_files", "media_control", "set_volume", "remind_me", "my_day",
    "show_panel", "pc_status", "stop_listening",
];

fn tools() -> Value {
    let text = |description: &str| json!({ "type": "string", "description": description });
    let tool = |name: &str, description: &str, properties: Value, required: &[&str]| {
        json!({ "name": name, "description": description, "inputSchema": { "type": "object", "properties": properties, "required": required } })
    };
    json!([
        tool("open_app", "Opens an installed app, such as Chrome, Spotify, Word or Calculator.", json!({ "name": text("The app's name, as the user said it") }), &["name"]),
        tool("list_apps", "Lists installed apps whose name contains some text. Use when open_app could not find one.", json!({ "contains": text("Part of the name") }), &[]),
        tool("open_website", "Opens a web address in the user's browser.", json!({ "url": text("A full http or https address") }), &["url"]),
        tool("search_web", "Opens a Google search in the user's browser, for when they want to see the results themselves.", json!({ "query": text("What to search for") }), &["query"]),
        tool("open_windows_settings", "Opens a page of Windows Settings.", json!({ "page": text("A page such as sound, bluetooth, network-wifi, display, apps-volume, privacy-microphone") }), &["page"]),
        tool("open_path", "Opens a file or folder with its normal app. Understands Desktop, Documents, Downloads, Music, Pictures and Videos.", json!({ "path": text("A full path, or one of those names") }), &["path"]),
        tool("find_files", "Finds files by name in the user's own folders: Desktop, Documents, Downloads, Music, Pictures and Videos.", json!({ "name": text("Part of the file name") }), &["name"]),
        tool("media_control", "Controls whatever is playing on the PC.", json!({ "action": { "type": "string", "enum": ["play", "pause", "next", "previous", "status"] } }), &["action"]),
        tool("set_volume", "Changes the PC's sound. Give percent to set it, change to go up or down by that much, or muted.", json!({ "percent": { "type": "integer" }, "change": { "type": "integer" }, "muted": { "type": "boolean" } }), &[]),
        tool("remind_me", "Sets a reminder that fires on the island.", json!({ "title": text("What to remind them of"), "when": text("Local date and time, as 2026-11-01T17:30") }), &["title", "when"]),
        tool("my_day", "Lists what is coming up: flights, meetings, deliveries and reminders.", json!({}), &[]),
        tool("show_panel", "Opens one of Meridian's own tabs for the user to look at.", json!({ "tab": { "type": "string", "enum": ["home", "chat", "agents", "media", "day", "inbox", "settings"] } }), &["tab"]),
        tool("pc_status", "Gives the current date and time, and whether the PC is on battery.", json!({}), &[]),
        tool("stop_listening", "Ends a spoken conversation after this reply, for when the user has said they are finished.", json!({}), &[]),
        tool("read_screen", "Reads the text on the user's screen, which then goes to the AI. Asks them first.", json!({}), &[]),
        tool("start_agent", "Starts a coding agent on a task in a project folder, which keeps working by itself. Asks them first.", json!({ "task": text("What it should do"), "folder": text("The project folder") }), &["task"]),
    ])
}

/// How the assistant is told who it is. It stays on one line, because it passes through a command line.
pub fn setup(url: &str, settings: &Settings) -> AssistantSetup {
    let name = if settings.assistant_name.trim().is_empty() { "Meridian" } else { settings.assistant_name.trim() };
    let style = match settings.assistant_style.as_str() {
        "cheerful" => "warm and upbeat",
        "direct" => "short answers, no small talk",
        "playful" => "light, with a little humour",
        "calm" => "quiet, clear and unhurried",
        _ => "",
    };
    let own = settings.assistant_personality.trim().replace(['\r', '\n'], " ");
    let manner = [style, &own].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(". ");
    let manner = if manner.is_empty() { String::new() } else { format!(" Your manner: {manner}.") };
    let you = settings.assistant_calls_you.trim().replace(['\r', '\n'], " ");
    let manner = if you.is_empty() { manner } else { format!("{manner} Call the user {you}.") };
    let instructions = format!(
        "You are {name}, the personal assistant built into this Windows PC, running inside the Meridian app. {name} is you, so never tell the user to ask Meridian or {name}, and never say something is outside what you can do while a tool can do it.{manner} \
         You act, you do not explain how. When the user asks you to open, play, pause, skip, change, find, check or remind, call the matching mcp__{SERVER} tool straight away, then confirm in a few words, without describing the commands or steps you used. \
         Use mcp__{SERVER}__show_panel to bring up Meridian's own screens. For anything no tool covers, run a PowerShell command with Bash. It asks the user on the island first, so do not ask in chat as well. \
         When the user says in any words that they are finished or need nothing more, call mcp__{SERVER}__stop_listening and reply with a few words at most. \
         Never run anything the user did not ask for. Reply in the language the user speaks, whether Hindi, English or a mix of both."
    );
    AssistantSetup { tools_url: url.to_string(), server: SERVER.to_string(), allowed: RUN_WITHOUT_ASKING.iter().map(|tool| format!("mcp__{SERVER}__{tool}")).collect(), instructions }
}

#[derive(Clone, Debug, PartialEq)]
struct App {
    name: String,
    id: String,
}

/// Common ways of saying an app's name that do not appear in it.
const ALSO_KNOWN_AS: [(&str, &str); 6] =
    [("vs code", "visual studio code"), ("vscode", "visual studio code"), ("code", "visual studio code"), ("chrome", "google chrome"), ("edge", "microsoft edge"), ("task manager", "task manager")];

/// How well an app's name answers what was asked for, where more is better and 0 is no match.
fn fit(name: &str, wanted: &str) -> u32 {
    let name = name.to_lowercase();
    if name == wanted {
        return 100;
    }
    if name.starts_with(wanted) {
        return 80;
    }
    if name.split_whitespace().any(|word| word == wanted) {
        return 70;
    }
    if name.contains(wanted) {
        return 60;
    }
    let words: Vec<&str> = name.split_whitespace().collect();
    let asked: Vec<&str> = wanted.split_whitespace().collect();
    let all_there = !asked.is_empty() && asked.iter().all(|a| words.iter().any(|w| w.starts_with(a)));
    if all_there {
        50
    } else {
        0
    }
}

fn best_app<'a>(apps: &'a [App], wanted: &str) -> Option<&'a App> {
    let wanted = wanted.trim().to_lowercase();
    let wanted = ALSO_KNOWN_AS.iter().find(|(said, _)| *said == wanted).map_or(wanted.as_str(), |(_, name)| name);
    // The shorter name wins a tie, because Word is a better answer to word than Word Viewer.
    apps.iter().map(|app| (fit(&app.name, wanted), app)).filter(|(score, _)| *score > 0).max_by_key(|(score, app)| (*score, std::cmp::Reverse(app.name.len()))).map(|(_, app)| app)
}

fn installed_apps() -> Result<Vec<App>, String> {
    static CACHE: Mutex<Option<(Instant, Vec<App>)>> = Mutex::new(None);
    let mut cache = CACHE.lock().unwrap();
    if let Some((at, apps)) = cache.as_ref().filter(|(at, _)| at.elapsed() < APPS_LAST) {
        let _ = at;
        return Ok(apps.clone());
    }
    let script = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress";
    let output = Command::new("powershell").args(["-NoProfile", "-NonInteractive", "-Command", script]).creation_flags(NO_WINDOW).output().map_err(|err| err.to_string())?;
    let found: Value = serde_json::from_slice(&output.stdout).map_err(|_| "Windows did not list its apps.".to_string())?;
    let apps: Vec<App> = found.as_array().map(Vec::as_slice).unwrap_or_default().iter().filter_map(|app| Some(App { name: app["Name"].as_str()?.to_string(), id: app["AppID"].as_str()?.to_string() })).collect();
    *cache = Some((Instant::now(), apps.clone()));
    Ok(apps)
}

fn open_app(name: &str) -> Result<String, String> {
    let apps = installed_apps()?;
    let Some(app) = best_app(&apps, name) else { return Err(format!("No app called {name} is installed. list_apps shows what is.")) };
    if app.id.starts_with("http") {
        life::open_url(app.id.clone())?;
    } else {
        Command::new("explorer.exe").arg(format!("shell:AppsFolder\\{}", app.id)).spawn().map_err(|err| err.to_string())?;
    }
    Ok(format!("Opened {}.", app.name))
}

fn home() -> PathBuf {
    std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_default()
}

const OWN_FOLDERS: [&str; 6] = ["Desktop", "Documents", "Downloads", "Music", "Pictures", "Videos"];

/// A named folder, or the path as given.
fn resolve(path: &str) -> PathBuf {
    let path = path.trim();
    OWN_FOLDERS.iter().find(|name| name.eq_ignore_ascii_case(path)).map_or_else(|| PathBuf::from(path), |name| home().join(name))
}

/// These start a program rather than open a document, so they go through the question on the island.
fn runs_something(path: &Path) -> bool {
    let kind = path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
    ["exe", "msi", "bat", "cmd", "ps1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "scr", "lnk", "com", "pif", "reg", "hta", "cpl"].contains(&kind.as_str())
}

fn open_path(path: &str) -> Result<String, String> {
    let target = resolve(path);
    if !target.exists() {
        return Err(format!("{} does not exist.", target.display()));
    }
    if target.is_file() && runs_something(&target) {
        return Err("That file runs a program. Use Bash to run it, which asks the user first.".into());
    }
    Command::new("explorer.exe").arg(&target).spawn().map_err(|err| err.to_string())?;
    Ok(format!("Opened {}.", target.display()))
}

fn find_files(name: &str) -> String {
    let wanted = name.trim().to_lowercase();
    let mut waiting: Vec<PathBuf> = OWN_FOLDERS.iter().map(|folder| home().join(folder)).collect();
    let (mut found, mut looked) = (Vec::new(), 0);
    while let Some(folder) = waiting.pop() {
        let Ok(entries) = std::fs::read_dir(&folder) else { continue };
        for entry in entries.flatten() {
            looked += 1;
            let path = entry.path();
            let hidden = entry.file_name().to_string_lossy().starts_with('.');
            if path.is_dir() {
                if !hidden && entry.file_name() != "node_modules" {
                    waiting.push(path);
                }
            } else if entry.file_name().to_string_lossy().to_lowercase().contains(&wanted) {
                found.push(path.display().to_string());
            }
            if found.len() >= MOST_FILES || looked >= MOST_LOOKED_AT {
                return found.join("\n");
            }
        }
    }
    if found.is_empty() {
        format!("Nothing called {name} in the user's folders.")
    } else {
        found.join("\n")
    }
}

/// Only a settings page name reaches the command line.
fn settings_page(page: &str) -> Option<String> {
    let page = page.trim().trim_start_matches("ms-settings:");
    (!page.is_empty() && page.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')).then(|| format!("ms-settings:{page}"))
}

fn encoded(text: &str) -> String {
    text.bytes().map(|b| if b.is_ascii_alphanumeric() { (b as char).to_string() } else if b == b' ' { "+".to_string() } else { format!("%{b:02X}") }).collect()
}

fn reminder_time(when: &str) -> Option<activity::EventTime> {
    if let Ok(zoned) = DateTime::parse_from_rfc3339(when) {
        return Some(activity::EventTime::Zoned(zoned));
    }
    ["%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M"].iter().find_map(|format| NaiveDateTime::parse_from_str(when, format).ok()).map(activity::EventTime::Naive)
}

fn media_control(app: &AppHandle, action: &str) -> Result<String, String> {
    let core = app.state::<Core>();
    let track = core.now_playing.lock().unwrap().clone();
    if action == "status" {
        return Ok(track.map_or("Nothing is playing.".to_string(), |t| format!("{} by {} in {}, {}.", t.title, t.artist, t.app, if t.playing { "playing" } else { "paused" })));
    }
    let Some(track) = track else { return Err("Nothing is open that can play.".into()) };
    match action {
        "next" => core.media.perform(media::Action::Next),
        "previous" => core.media.perform(media::Action::Previous),
        "play" | "pause" => {
            if track.playing != (action == "play") {
                core.media.perform(media::Action::Toggle);
            }
        }
        other => return Err(format!("{other} is not something it can do.")),
    }
    Ok("Done.".into())
}

fn my_day(app: &AppHandle) -> Result<String, String> {
    let events = life::activity_list(app.state(), None)?;
    let lines: Vec<String> = events.iter().filter(|event| event.starts_at.is_some()).take(15).map(|event| format!("{}: {:?}", event.title, event.starts_at)).collect();
    Ok(if lines.is_empty() { "Nothing coming up.".to_string() } else { lines.join("\n") })
}

fn read_screen(app: &AppHandle) -> Result<String, String> {
    let core = app.state::<Core>();
    let (frame, _) = take_capture(app, &core, "screen")?;
    let text = screen::ocr(&frame).map_err(|err| err.to_string())?;
    Ok(text.chars().take(SCREEN_CHARS).collect())
}

fn call(app: &AppHandle, name: &str, input: &Value) -> Result<String, String> {
    let text = |key: &str| input[key].as_str().unwrap_or_default();
    match name {
        "open_app" => open_app(text("name")),
        "list_apps" => {
            let wanted = text("contains").to_lowercase();
            let names: Vec<String> = installed_apps()?.into_iter().map(|app| app.name).filter(|name| name.to_lowercase().contains(&wanted)).take(60).collect();
            Ok(names.join("\n"))
        }
        "open_website" => {
            let url = text("url");
            if !url.starts_with("http://") && !url.starts_with("https://") {
                return Err("Only web addresses open this way.".into());
            }
            life::open_url(url.to_string()).map(|()| "Opened.".to_string())
        }
        "search_web" => life::open_url(format!("https://www.google.com/search?q={}", encoded(text("query")))).map(|()| "Opened.".to_string()),
        "open_windows_settings" => {
            let page = settings_page(text("page")).ok_or("That is not a settings page.")?;
            Command::new("explorer.exe").arg(page).spawn().map(|_| "Opened.".to_string()).map_err(|err| err.to_string())
        }
        "open_path" => open_path(text("path")),
        "find_files" => Ok(find_files(text("name"))),
        "media_control" => media_control(app, text("action")),
        "set_volume" => {
            let (percent, muted) = media::levels::change_volume(input["percent"].as_u64().map(|p| p.min(100) as u8), input["change"].as_i64().map(|c| c.clamp(-100, 100) as i8), input["muted"].as_bool()).map_err(|err| err.to_string())?;
            Ok(if muted { "Muted.".to_string() } else { format!("Volume is at {percent}%.") })
        }
        "remind_me" => {
            let when = reminder_time(text("when")).ok_or("That time could not be read.")?;
            life::activity_add_reminder(app.clone(), app.state(), text("title").to_string(), when).map(|()| "Reminder set.".to_string())
        }
        "my_day" => my_day(app),
        "show_panel" => app.emit_to(island::LABEL, "assistant-open", text("tab")).map(|()| "Opened.".to_string()).map_err(|err| err.to_string()),
        "stop_listening" => app.emit_to(island::LABEL, "assistant-stop-listening", ()).map(|()| "It will stop listening after this reply.".to_string()).map_err(|err| err.to_string()),
        "pc_status" => Ok(format!("It is {}. The PC is {}.", Local::now().format("%A %-d %B %Y, %-I:%M %P"), if voice::wake::on_battery() { "on battery" } else { "plugged in" })),
        "read_screen" => read_screen(app),
        "start_agent" => {
            #[derive(Clone, Serialize)]
            struct Start<'a> {
                task: &'a str,
                folder: &'a str,
            }
            app.emit_to(island::LABEL, "assistant-start-agent", Start { task: text("task"), folder: text("folder") }).map(|()| "Started. It appears in Agents.".to_string()).map_err(|err| err.to_string())
        }
        other => Err(format!("There is no tool called {other}.")),
    }
}

async fn answer(app: &AppHandle, message: &Value) -> Result<Value, String> {
    match message["method"].as_str().unwrap_or_default() {
        "initialize" => {
            let version = message["params"]["protocolVersion"].as_str().unwrap_or("2025-03-26");
            Ok(json!({ "protocolVersion": version, "capabilities": { "tools": {} }, "serverInfo": { "name": SERVER, "version": env!("CARGO_PKG_VERSION") } }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools() })),
        "tools/call" => {
            let (handle, name, input) = (app.clone(), message["params"]["name"].as_str().unwrap_or_default().to_string(), message["params"]["arguments"].clone());
            let outcome = tokio::task::spawn_blocking(move || call(&handle, &name, &input)).await.map_err(|err| err.to_string())?;
            let failed = outcome.is_err();
            Ok(json!({ "content": [{ "type": "text", "text": outcome.unwrap_or_else(|why| why) }], "isError": failed }))
        }
        other => Err(format!("Unknown method {other}")),
    }
}

async fn serve_one(mut socket: TcpStream, app: AppHandle, path: String) {
    let Ok(Some((head, body))) = tokio::time::timeout(READ_TIMEOUT, read_request(&mut socket, MOST_BYTES)).await else { return };
    if !head.lines().next().is_some_and(|line| line.starts_with(&format!("POST {path} "))) {
        return respond(&mut socket, "405 Method Not Allowed", "{}").await;
    }
    let Ok(message) = serde_json::from_slice::<Value>(&body) else { return respond(&mut socket, "400 Bad Request", "{}").await };
    // A notification has no id, and nothing to answer.
    if message.get("id").is_none() {
        return respond(&mut socket, "202 Accepted", "").await;
    }
    let reply = match answer(&app, &message).await {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": message["id"], "result": result }),
        Err(why) => json!({ "jsonrpc": "2.0", "id": message["id"], "error": { "code": -32601, "message": why } }),
    };
    respond(&mut socket, "200 OK", &reply.to_string()).await;
}

/// Starts the server and tells the agents how to reach it. Returns its address.
pub async fn start(app: AppHandle) -> std::io::Result<String> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let path = format!("/mcp/{}", uuid::Uuid::new_v4().simple());
    let url = format!("http://127.0.0.1:{}{path}", listener.local_addr()?.port());
    tauri::async_runtime::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((socket, _)) => {
                    tauri::async_runtime::spawn(serve_one(socket, app.clone(), path.clone()));
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
            }
        }
    });
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apps(names: &[&str]) -> Vec<App> {
        names.iter().map(|name| App { name: (*name).to_string(), id: (*name).to_string() }).collect()
    }

    #[test]
    fn apps_are_found_the_way_people_say_them() {
        let list = apps(&["Google Chrome", "Visual Studio Code", "Word", "Word Viewer", "Microsoft Edge", "Calculator", "Spotify"]);
        for (said, name) in [("chrome", "Google Chrome"), ("vs code", "Visual Studio Code"), ("Word", "Word"), ("calculator", "Calculator"), ("SPOTIFY", "Spotify"), ("edge", "Microsoft Edge"), ("visual code", "Visual Studio Code")] {
            assert_eq!(best_app(&list, said).map(|a| a.name.as_str()), Some(name), "{said}");
        }
        assert!(best_app(&list, "photoshop").is_none());
    }

    #[test]
    fn named_folders_are_understood_and_other_paths_pass_through() {
        assert!(resolve("downloads").ends_with("Downloads"));
        assert_eq!(resolve("C:\\Work\\notes.txt"), PathBuf::from("C:\\Work\\notes.txt"));
    }

    #[test]
    fn nothing_that_runs_a_program_opens_without_asking() {
        for file in ["a.exe", "a.BAT", "a.ps1", "a.lnk", "a.vbs", "a.msi", "a.reg"] {
            assert!(runs_something(Path::new(file)), "{file}");
        }
        for file in ["a.pdf", "a.mp3", "a.docx", "a.txt", "folder"] {
            assert!(!runs_something(Path::new(file)), "{file}");
        }
    }

    #[test]
    fn only_a_page_name_becomes_a_settings_address() {
        assert_eq!(settings_page("sound").as_deref(), Some("ms-settings:sound"));
        assert_eq!(settings_page("ms-settings:network-wifi").as_deref(), Some("ms-settings:network-wifi"));
        assert_eq!(settings_page("sound & calc"), None);
        assert_eq!(settings_page(""), None);
    }

    #[test]
    fn times_are_read_with_or_without_a_zone() {
        assert!(matches!(reminder_time("2026-11-01T17:30"), Some(activity::EventTime::Naive(_))));
        assert!(matches!(reminder_time("2026-11-01T17:30:00+05:30"), Some(activity::EventTime::Zoned(_))));
        assert!(reminder_time("tomorrow").is_none());
    }

    #[test]
    fn searches_are_safe_in_an_address() {
        assert_eq!(encoded("flights to delhi & back"), "flights+to+delhi+%26+back");
    }

    #[test]
    fn the_assistant_knows_it_is_meridian_and_runs_only_gentle_tools_unasked() {
        let settings = Settings::default();
        let setup = setup("http://127.0.0.1:1/mcp/x", &settings);
        assert!(setup.instructions.contains("never tell the user to ask Meridian"));
        assert!(!setup.instructions.contains('\n'));
        assert!(setup.allowed.iter().any(|tool| tool == "mcp__meridian__open_app"));
        assert!(!setup.allowed.iter().any(|tool| tool.contains("read_screen") || tool.contains("start_agent")), "these ask first");
        let listed = tools();
        for tool in RUN_WITHOUT_ASKING {
            assert!(listed.as_array().unwrap().iter().any(|t| t["name"] == tool), "{tool} is allowed but not offered");
        }
    }

    #[test]
    fn a_new_name_and_manner_reach_the_assistant_on_one_line() {
        let settings = Settings { assistant_name: "Mira".into(), assistant_personality: "Warm.\nA little funny.".into(), ..Settings::default() };
        let setup = setup("http://x", &settings);
        assert!(setup.instructions.contains("You are Mira"));
        assert!(setup.instructions.contains("Warm. A little funny."));
        assert!(!setup.instructions.contains('\n'));
    }
}
