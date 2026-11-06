//! Knowledge in the running app: reading new items from the sources the user turned on, asking the
//! AI they chose for the assistant to write them up, and updating by itself while the PC is idle
//! and plugged in. The pages, and every rule about what an update may change, are in crates/knowledge.
//!
//! Nothing here shows on the island. The Knowledge tab follows `knowledge-changed`.

use std::collections::BTreeMap;
use std::os::windows::process::CommandExt;
use std::sync::Mutex;
use std::time::Duration;

use ::knowledge::{Fact, Hit, Index, Item, Kind, PageView, Source, Store};
use agent_adapters::google::{self, Copied, Service};
use agent_adapters::AgentKind;
use chrono::{DateTime, Local, TimeDelta, TimeZone};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;

use crate::commands::Core;
use crate::island;
use crate::notetaker::{ask_chosen, NoteTaker};

const NO_WINDOW: u32 = 0x0800_0000;
/// The first read of Gmail goes back this far. Later reads start a day before the last one ended.
const FIRST_MAIL_DAYS: i64 = 14;
/// The calendar is read over the last 90 days and the next 30.
const CALENDAR_BACK_DAYS: i64 = 90;
const CALENDAR_AHEAD_DAYS: i64 = 30;
const LOOK_EVERY: Duration = Duration::from_secs(15);
/// While an idle update runs, the user coming back stops it within this.
const LOOK_WHILE_RUNNING: Duration = Duration::from_secs(1);
const MOST_CHATS: usize = 200;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatus {
    id: Source,
    /// "waiting", "reading", "read", "done" or "skipped".
    state: &'static str,
    /// New items it had.
    found: usize,
    /// Why it was skipped.
    why: String,
    /// Signing Claude Code in again would fix it.
    sign_in: bool,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    running: bool,
    done: usize,
    total: usize,
    /// What it is reading, "the call with Asha, 4 Nov".
    now: String,
    sources: Vec<SourceStatus>,
    /// Why the last update stopped short.
    failed: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeState {
    pages: Vec<PageView>,
    status: Status,
    updated_at: Option<i64>,
    folder: String,
    /// Finished call notes on this PC.
    calls: usize,
}

/// One turn of a chat with the assistant, as the page keeps it.
#[derive(Deserialize, Debug)]
pub struct Chat {
    text: String,
    /// When it was said, in ms, when known.
    at: Option<i64>,
}

struct Run {
    cancel: CancellationToken,
    idle: bool,
}

pub struct Knowledge {
    store: Store,
    /// Held while a page is read and written, so an update and the user's Save never cross.
    index: Mutex<Index>,
    run: Mutex<Option<Run>>,
    status: Mutex<Status>,
}

pub fn state(app: &tauri::App) -> tauri::Result<Knowledge> {
    let store = Store::new(app.path().document_dir()?.join("Meridian").join("Knowledge"));
    let index = Mutex::new(store.index());
    Ok(Knowledge { store, index, run: Mutex::default(), status: Mutex::default() })
}

fn tell(app: &AppHandle) {
    let _ = app.emit_to(island::LABEL, "knowledge-changed", ());
}

fn day(ms: i64) -> Option<String> {
    Local.timestamp_millis_opt(ms).single().map(|time| time.format("%-d %b").to_string())
}

fn day_of(rfc3339: &str) -> Option<String> {
    DateTime::parse_from_rfc3339(rfc3339.trim()).ok().map(|time| time.with_timezone(&Local).format("%-d %b").to_string())
}

impl Knowledge {
    /// What the assistant's my_knowledge tool returns.
    pub fn about(&self, words: &str) -> String {
        ::knowledge::answer(&self.store.pages(), words)
    }

    fn change(&self, app: &AppHandle, change: impl FnOnce(&mut Status)) {
        change(&mut self.status.lock().unwrap());
        tell(app);
    }

    fn source(&self, app: &AppHandle, id: Source, change: impl FnOnce(&mut SourceStatus)) {
        self.change(app, |status| {
            if let Some(source) = status.sources.iter_mut().find(|s| s.id == id) {
                change(source);
            }
        });
    }

    /// Writes one batch's facts into their pages, each after the user's own changes are marked.
    fn write(&self, pages: &[PageView], facts: &[Fact], batch: &[Item]) -> Result<(), String> {
        let mut by_page: BTreeMap<String, (Kind, String, Vec<&Fact>)> = BTreeMap::new();
        for fact in facts {
            let Some(kind) = fact.kind else { continue };
            let path = self.store.find(pages, kind, &fact.page);
            let title = pages.iter().find(|p| p.path == path).map_or_else(|| fact.page.clone(), |p| p.title.clone());
            by_page.entry(path).or_insert((kind, title, Vec::new())).2.push(fact);
        }
        let mut index = self.index.lock().unwrap();
        for (path, (kind, title, facts)) in by_page {
            let book = index.books.entry(path.clone()).or_default();
            let before = self.store.read(&path).ok();
            let marked = before.as_deref().map(|text| ::knowledge::reconcile(text, book));
            let merged = ::knowledge::merge(marked.as_deref(), kind, &title, &facts, batch, book);
            match (merged, marked) {
                (Some(text), _) => self.store.write(&path, &text)?,
                (None, Some(text)) if before.as_deref() != Some(text.as_str()) => self.store.write(&path, &text)?,
                _ => {}
            }
        }
        for item in batch {
            index.mark_seen(item);
        }
        self.store.save_index(&index)
    }
}

fn note_text(note: &notes::Note) -> String {
    let mut text = format!("{}\n", note.title);
    if let Some(summary) = &note.summary {
        text.push_str(&format!("Summary: {summary}\n"));
    }
    for point in &note.key_points {
        text.push_str(&format!("- {point}\n"));
    }
    for todo in &note.todos {
        let who = [todo.owner.as_deref(), todo.due.as_deref()].into_iter().flatten().collect::<Vec<_>>().join(", ");
        text.push_str(&format!("To do: {}{}\n", todo.text, if who.is_empty() { String::new() } else { format!(" ({who})") }));
    }
    format!("{text}\nTranscript:\n{}", note.transcript())
}

fn call_items(app: &AppHandle) -> Vec<Item> {
    app.state::<NoteTaker>()
        .ready()
        .iter()
        .map(|note| {
            // People the user named, as against the numbers the hearing service gives.
            let with: Vec<&str> = note.speakers.iter().filter(|s| !s.you && !s.name.starts_with("Person ")).map(|s| s.name.as_str()).collect();
            Item::call(&note.id, &day(note.started_at).unwrap_or_default(), Some(with.join(" and ")).as_deref(), &note_text(note))
        })
        .collect()
}

fn chat_items(chats: &[Chat]) -> Vec<Item> {
    chats.iter().rev().take(MOST_CHATS).filter_map(|chat| Item::chat(&chat.text, chat.at.and_then(day).as_deref())).collect()
}

fn google_items(service: Service, copies: Vec<Copied>) -> Vec<Item> {
    copies
        .into_iter()
        .filter_map(|copy| match service {
            Service::Gmail => Item::mail(&copy.id, &copy.from, day_of(&copy.date).as_deref(), &format!("From: {}\nSubject: {}\nDate: {}\n\n{}", copy.from, copy.subject, copy.date, copy.text)),
            // An event that moves is new again, so what changed gets noted.
            Service::Calendar => Item::event(&format!("{}@{}", copy.id, copy.date), &copy.link, day_of(&copy.date).as_deref(), &format!("Event: {}\nWhen: {}\nOrganiser: {}\n{}", copy.subject, copy.date, copy.from, copy.text)),
        })
        .collect()
}

/// Gmail and the calendar are read through the user's Claude account, so that has to be signed in.
async fn read_google(service: Service, since: i64) -> Result<Vec<Item>, (String, bool)> {
    let name = if service == Service::Gmail { "Gmail" } else { "Google Calendar" };
    match agent_adapters::auth_status(AgentKind::ClaudeCode).await {
        None => return Err((format!("Claude Code is not installed on this PC, so {name} could not be read."), false)),
        Some(auth) if auth.signed_in == Some(false) => return Err((format!("Claude Code is signed out, so {name} could not be read."), true)),
        Some(_) => {}
    }
    let date = |ms: i64| Local.timestamp_millis_opt(ms).single().map(|t| t.format("%Y-%m-%d").to_string()).unwrap_or_default();
    let until = date((Local::now() + TimeDelta::days(CALENDAR_AHEAD_DAYS)).timestamp_millis());
    let copies = google::recent(service, &date(since), &until).await.map_err(|why| (why, false))?;
    Ok(google_items(service, copies))
}

/// Where a cloud source's read starts: a day before the last one ended, or the first window.
fn since(index: &Index, source: Source, now: i64) -> i64 {
    let first = now - TimeDelta::days(if source == Source::Gmail { FIRST_MAIL_DAYS } else { CALENDAR_BACK_DAYS }).num_milliseconds();
    index.read_to.get(&source).map_or(first, |last| (last - TimeDelta::days(1).num_milliseconds()).max(first))
}

struct Engine {
    agent: Option<String>,
    provider: Option<String>,
    model: Option<String>,
}

async fn run(app: &AppHandle, k: &Knowledge, on: &[Source], engine: &Engine, chats: &[Chat], cancel: &CancellationToken) -> Result<(), String> {
    let core = app.state::<Core>();
    let local = core.settings.lock().unwrap().local_only;
    let started = Local::now().timestamp_millis();
    let (mut items, mut read_to) = (Vec::<Item>::new(), Vec::new());
    for &source in on {
        if cancel.is_cancelled() {
            return Ok(());
        }
        k.source(app, source, |s| s.state = "reading");
        let start = since(&k.index.lock().unwrap(), source, started);
        let found = match source {
            Source::Notes => Ok(call_items(app)),
            Source::Chats => Ok(chat_items(chats)),
            Source::Gmail | Source::Calendar if local => Err(("Local-only mode is on, so it is not read.".to_string(), false)),
            Source::Gmail | Source::Calendar => {
                let service = if source == Source::Gmail { Service::Gmail } else { Service::Calendar };
                tokio::select! {
                    found = read_google(service, start) => found,
                    () = cancel.cancelled() => return Ok(()),
                }
            }
        };
        match found {
            Ok(found) => {
                let index = k.index.lock().unwrap();
                let fresh: Vec<Item> = found.into_iter().filter(|item| index.is_new(item) && !items.iter().any(|i: &Item| i.source == item.source && i.id == item.id)).collect();
                drop(index);
                // Done once everything it had is written, which with nothing new is now.
                k.source(app, source, |s| (s.state, s.found) = (if fresh.is_empty() { "done" } else { "read" }, fresh.len()));
                if matches!(source, Source::Gmail | Source::Calendar) {
                    read_to.push((source, started));
                }
                items.extend(fresh);
            }
            // A source that fails is skipped and says why. The rest still update.
            Err((why, sign_in)) => k.source(app, source, |s| (s.state, s.why, s.sign_in) = ("skipped", why, sign_in)),
        }
    }
    k.change(app, |s| s.total = items.len());
    let mut pages = k.store.pages();
    ::knowledge::note_deleted(&mut k.index.lock().unwrap(), &pages);
    let today = Local::now().format("%A %-d %B %Y").to_string();
    let mut written: Vec<Source> = Vec::new();
    for batch in ::knowledge::batches(items) {
        if cancel.is_cancelled() {
            return Ok(());
        }
        let now = match batch.len() {
            1 => batch[0].reading.clone(),
            n => format!("{} and {} more", batch[0].reading, n - 1),
        };
        k.change(app, |s| s.now = now);
        let request = ::knowledge::request(&today, &batch, &pages);
        let reply = ask_chosen(&core, engine.agent.as_deref(), engine.provider.clone(), engine.model.clone(), ::knowledge::INSTRUCTIONS, request, cancel).await;
        if cancel.is_cancelled() {
            return Ok(());
        }
        let facts = ::knowledge::facts_in(&reply.map_err(|why| format!("The pages could not be written. {why}"))?, &batch)?;
        k.write(&pages, &facts, &batch)?;
        pages = k.store.pages();
        written.extend(batch.iter().map(|item| item.source));
        k.change(app, |s| {
            s.done += batch.len();
            for source in s.sources.iter_mut().filter(|s| s.state == "read") {
                if written.iter().filter(|&&w| w == source.id).count() >= source.found {
                    source.state = "done";
                }
            }
        });
    }
    // Only a read that was written up in full moves on, so nothing it found is lost.
    let mut index = k.index.lock().unwrap();
    for (source, at) in read_to {
        index.read_to.insert(source, at);
    }
    index.updated_at = Some(Local::now().timestamp_millis());
    k.store.save_index(&index)?;
    Ok(())
}

/// Reads what is new and writes it up with the AI the page names, which is the one Chat is on.
#[tauri::command]
pub async fn knowledge_update(app: AppHandle, agent: Option<String>, provider: Option<String>, model: Option<String>, chats: Vec<Chat>, idle: bool) -> Result<(), String> {
    let k = app.state::<Knowledge>();
    let prefs = app.state::<Core>().settings.lock().unwrap().knowledge.clone();
    let on: Vec<Source> = [(prefs.notes, Source::Notes), (prefs.chats, Source::Chats), (prefs.gmail, Source::Gmail), (prefs.calendar, Source::Calendar)].into_iter().filter(|(on, _)| *on).map(|(_, source)| source).collect();
    if on.is_empty() {
        return Err("Turn on a source first.".into());
    }
    let cancel = {
        let mut run = k.run.lock().unwrap();
        if run.is_some() {
            return Err("Knowledge is already updating.".into());
        }
        let cancel = CancellationToken::new();
        *run = Some(Run { cancel: cancel.clone(), idle });
        cancel
    };
    let sources = on.iter().map(|&id| SourceStatus { id, state: "waiting", found: 0, why: String::new(), sign_in: false }).collect();
    k.change(&app, |s| *s = Status { running: true, sources, ..Status::default() });
    let chats = if prefs.chats { chats } else { Vec::new() };
    let outcome = run(&app, &k, &on, &Engine { agent, provider, model }, &chats, &cancel).await;
    *k.run.lock().unwrap() = None;
    let stopped = cancel.is_cancelled();
    k.change(&app, |s| {
        s.running = false;
        s.now.clear();
        s.failed = match (&outcome, stopped) {
            (_, true) if idle => Some("Stopped when you came back. It carries on next time.".into()),
            (_, true) => Some("Stopped. It carries on next time.".into()),
            (Err(why), _) => Some(why.clone()),
            _ => None,
        };
    });
    if stopped { Ok(()) } else { outcome }
}

#[tauri::command]
pub fn knowledge_stop(k: State<'_, Knowledge>) {
    if let Some(run) = k.run.lock().unwrap().as_ref() {
        run.cancel.cancel();
    }
}

#[tauri::command]
pub fn knowledge_state(k: State<'_, Knowledge>, taker: State<'_, NoteTaker>) -> KnowledgeState {
    KnowledgeState {
        pages: k.store.pages(),
        status: k.status.lock().unwrap().clone(),
        updated_at: k.index.lock().unwrap().updated_at,
        folder: k.store.folder().display().to_string(),
        calls: taker.ready().len(),
    }
}

#[tauri::command]
pub fn knowledge_search(k: State<'_, Knowledge>, query: String) -> Vec<Hit> {
    ::knowledge::search(&k.store.pages(), &query)
}

#[tauri::command]
pub fn knowledge_read(k: State<'_, Knowledge>, path: String) -> Result<String, String> {
    k.store.read(&path)
}

/// Saves the user's own text. Every line they wrote or changed is marked as theirs, and every line
/// of Meridian's they took out is remembered, so no update writes it again. `base` is the text the
/// editor opened with: if an update changed the page since, nothing is saved.
#[tauri::command]
pub fn knowledge_save(app: AppHandle, k: State<'_, Knowledge>, path: String, text: String, base: String) -> Result<(), String> {
    let mut index = k.index.lock().unwrap();
    if k.store.read(&path)? != base {
        return Err("This page changed while you were editing it, so nothing was saved. Copy what you wrote, then press Cancel and edit again.".into());
    }
    let book = index.books.entry(path.clone()).or_default();
    let text = ::knowledge::reconcile(&text, book);
    k.store.write(&path, &text)?;
    k.store.save_index(&index)?;
    drop(index);
    tell(&app);
    Ok(())
}

/// Ticks a promise as kept, or back to open.
#[tauri::command]
pub fn knowledge_tick(app: AppHandle, k: State<'_, Knowledge>, path: String, line: usize, done: bool) -> Result<(), String> {
    let _index = k.index.lock().unwrap();
    let text = ::knowledge::tick(&k.store.read(&path)?, line, done).ok_or("That promise has moved. Open the page again.")?;
    k.store.write(&path, &text)?;
    drop(_index);
    tell(&app);
    Ok(())
}

/// Opens the page's file with the user's own Markdown app.
#[tauri::command]
pub fn knowledge_open(k: State<'_, Knowledge>, path: String) -> Result<(), String> {
    let (_, file) = k.store.path_of(&path)?;
    if !file.is_file() {
        return Err("That page is gone.".into());
    }
    std::process::Command::new("explorer.exe").arg(file).creation_flags(NO_WINDOW).spawn().map(|_| ()).map_err(|err| err.to_string())
}

/// How long since the last key press or mouse move anywhere. A question Windows answers, so no hook is needed.
pub(crate) fn idle_for() -> Duration {
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    if !unsafe { GetLastInputInfo(&mut info) }.as_bool() {
        return Duration::ZERO;
    }
    Duration::from_millis(u64::from(unsafe { GetTickCount() }.wrapping_sub(info.dwTime)))
}

/// Starts an update once each time the user is away for 10 minutes with the PC plugged in, and
/// stops it the moment they are back. The page brings the AI to use and the chats, so it is asked to start.
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let mut idle = ::knowledge::Idle::default();
        loop {
            let k = app.state::<Knowledge>();
            let away = idle_for();
            let plugged = !voice::wake::on_battery();
            let running = k.run.lock().unwrap().as_ref().map(|run| (run.idle, run.cancel.clone()));
            if let Some((true, cancel)) = &running {
                if ::knowledge::must_stop(away, plugged) {
                    cancel.cancel();
                }
            }
            let core = app.state::<Core>();
            let (prefs, paused) = {
                let settings = core.settings.lock().unwrap();
                (settings.knowledge.clone(), settings.monitoring_paused)
            };
            let ready = prefs.when == "idle" && prefs.any() && plugged && !paused && running.is_none();
            if idle.start(away, ready) {
                let _ = app.emit_to(island::LABEL, "knowledge-idle", ());
            }
            std::thread::sleep(if matches!(running, Some((true, _))) { LOOK_WHILE_RUNNING } else { LOOK_EVERY });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mail_and_events_become_items_that_say_where_they_came_from() {
        let copy = |id: &str, link: &str| Copied { id: id.into(), from: "Asha Rao <asha@northwind.example>".into(), subject: "Photos".into(), date: "2026-11-03T09:00:00+05:30".into(), text: "4:5 please.".into(), link: link.into() };
        let mail = google_items(Service::Gmail, vec![copy("18c2", ""), copy("../x", "")]);
        assert_eq!(mail.len(), 1, "an id that is not plain is dropped");
        assert!(mail[0].label.starts_with("mail from Asha, "));
        assert!(mail[0].text.contains("Subject: Photos"));
        let events = google_items(Service::Calendar, vec![copy("e1", "https://calendar.google.com/event?eid=1")]);
        assert_eq!(events[0].id, "e1@2026-11-03T09:00:00+05:30");
        assert!(events[0].label.starts_with("meeting on "));
    }

    #[test]
    fn each_read_starts_a_day_before_the_last_and_never_before_its_window() {
        let now = 1_000 * TimeDelta::days(400).num_milliseconds();
        let mut index = Index::default();
        assert_eq!(since(&index, Source::Gmail, now), now - TimeDelta::days(FIRST_MAIL_DAYS).num_milliseconds());
        index.read_to.insert(Source::Gmail, now - TimeDelta::hours(2).num_milliseconds());
        assert_eq!(since(&index, Source::Gmail, now), now - TimeDelta::hours(26).num_milliseconds());
        index.read_to.insert(Source::Calendar, now - TimeDelta::days(365).num_milliseconds());
        assert_eq!(since(&index, Source::Calendar, now), now - TimeDelta::days(CALENDAR_BACK_DAYS).num_milliseconds());
    }

    #[test]
    fn only_the_latest_chats_are_read() {
        let chats: Vec<Chat> = (0..MOST_CHATS + 5).map(|n| Chat { text: format!("You: {n}"), at: None }).collect();
        let items = chat_items(&chats);
        assert_eq!(items.len(), MOST_CHATS);
        assert!(items[0].text.ends_with(&(MOST_CHATS + 4).to_string()));
    }
}
