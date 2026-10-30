# Development ledger

## 2026-10-30: Milestone 2, the intelligent island

### Completed

- **Island.** Display selection, left, center and right placement, hide from the tray, hide when idle, clock, animation
  speed, hover detail for agents and media, next meeting, and display-change handling.
- **Claude Code and Codex as chat engines.** One engine picker. General mode (no shell, no edits, no connectors) and Project
  mode. Sign-in status from the CLI, sign-in through the CLI's own flow, conversations, follow-ups, stop, tool activity,
  approvals in chat, file references.
- **Screen awareness.** `crates/screen`: capture, local OCR, on-device signals, exclusions. A Desktop awareness page with a
  preview, region selection and an explicit share step. Optional contextual mode, off by default, with interval, pause and
  always-on exclusions. Images reach Anthropic, OpenAI-compatible providers and Claude Code.
- **Media.** `crates/media` on the Windows system media controls. Island view, hover controls, Media page, player switching,
  recent tracks.
- **Personal activity.** `crates/activity`: unified event model, extraction from JSON-LD, iCalendar and rules, SQLite store,
  notification engine, OAuth with PKCE, and Gmail, Google Calendar and Microsoft Graph connectors. My day, Notifications and
  Connected accounts in the app, plus Paste an email and your own reminders.
- **Global pause** in the tray and Settings.

### Bugs found by running it, all fixed

| Bug | Found by |
|---|---|
| Starting the app took focus from the active window | A capture naming our own process as foreground |
| Previewing a state erased real sessions | Empty state after a test |
| Credential Manager rejected tokens, because its 2560-byte limit is UTF-16 | Real round trip |
| OCR reads `main.tf` as `main. tf`, weakening detection | Live OCR test |
| `--tools` alone left MCP connectors reachable in general mode | Reading `system/init` |
| A test that claimed to interrupt mid-stream was stopping before any output | Reading the log it printed |
| Microsoft sign-in would have failed: the port is ignored only for `localhost`, not `127.0.0.1` | Reading the provider's documentation before first use |
| A forged email could offer a link with no sign of where it went | Reviewing the extraction limits |

### Testing status

| Suite | Result |
|---|---|
| Rust | 296 pass, including 197 for `crates/activity` |
| Vitest | 20 pass |
| Playwright | 31 pass |
| Live, Claude Code chat | Sign-in, no key, context, general mode, mid-stream stop, resume, image |
| Live, screen | Real capture, OCR, detection, crop, island exclusion, discard |
| Live, media | Silent session seen, controls delivered, pause seen |
| Live, activity | Email to event, reschedule in place, promo ignored, reminder fires once, cleanup |

### Measurements, release build, every module running

| Measure | Result |
|---|---|
| Idle CPU, nothing moving | About 0.31% of one core, over 30 s |
| `meridian.exe` | 0% |
| Private memory | About 178 MB fresh |
| Binary | 12.4 MB |
| Follow-up on a live Claude Code process | 1.5 s, against 6.7 s from cold |

### Blockers that need you

- `codex login` to verify Codex.
- A Google and a Microsoft app registration to verify accounts. See `docs/development/CONNECTING_ACCOUNTS.md`.

### Next steps

1. Connect a real account, and fix what real mail reveals.
2. Persist chats and sessions.
3. Test multiple monitors and display scaling.
4. Voice.

## 2026-10-30: Milestone 1

### Completed

- Research of TwoCode, Coucou source, Glint, EchoIsland and Windows APIs, in `docs/research/`.
- PRD, architecture, decisions, plan, design system and threat model.
- Toolchain on this machine: Rust 1.99.1 and Visual Studio Build Tools 2022 with the Windows 11 SDK.
- Tauri 2 shell: fixed transparent window, always on top, never activating, out of Alt-Tab, tray, `Ctrl+Alt+Space`,
  single instance, autostart setting, settings persistence, hide over fullscreen.
- Real desktop blur behind the island through a composition visual, with a tinted fallback.
- All nine island states, with spring morphs, reduced motion, dark and light themes, and a state preview in Settings.
- The Meridian Line, drawn on canvas, resting without frames and answering a live microphone level.
- Expanded panel: Command center, Chat, Agents, Providers, Settings.
- `ai-core`: 15 catalog providers, OpenAI-compatible and Anthropic adapters, streaming, cancellation, model lists, local
  discovery, error classification, local-only enforcement, keys in Credential Manager.
- `agent-adapters`: Claude Code and Codex sessions, detection, approvals, follow-up by resume, cancellation by process
  tree, failure reporting.

### Bugs found by running it, all fixed

| Bug | Found by |
|---|---|
| WebView2's modal microphone dialog blocked the page, and previewing a state opened the mic | Screenshot |
| `NOACTIVATE` and `TOOLWINDOW` silently removed by Tauri, so the island would take focus and appear in Alt-Tab | Reading window flags from outside |
| Dark glass turned grey and illegible over white apps | Screenshot over a white app |
| Endless idle animation cost 13% of a core | Per-process CPU sampling |
| Cursor poll ran at full rate over the whole window, with main-thread round trips | Per-process CPU sampling |
| "Providers ready" counted local servers that were not running | Screenshot |
| Agent events arriving before the session id were dropped, leaving a session stuck on Starting | Reading the code after a test failure |
| A follow-up in the two seconds after completion was lost, and could break a resumed run | Live resume test |
| A second parallel approval overwrote the first, leaving it unanswered | Reviewing the approval path |
| Local discovery trusted any HTTP 200 | Reviewing discovery |
| Raw "error sending request" reached the user | Live failure test |

### Testing status

| Suite | Result |
|---|---|
| Rust unit and real-socket tests | 64 pass |
| Vitest | 18 pass |
| Playwright, real UI on the browser stand-in | 13 pass |
| Live, real app with real Claude Code | Approve, deny, cancel, resume all pass; no process left behind |
| Live, real app with stand-in local server | Discovery, streaming, usage, notice, and a dead server becoming an error all pass |
| Live, Codex | Expired sign-in surfaces as a clear failure. A successful turn is not verified |

The live checks are in `tests/live/`.

### Measurements, release build, 180 Hz display

| Measure | Result |
|---|---|
| Idle CPU, nothing moving | About 0.37% of one core, over 30 s |
| `meridian.exe` | 0.16% of one core |
| Private memory | About 166 MB fresh, about 268 MB after opening the panel |
| Morph frame rate | 180 fps, p95 5.7 ms, none over 33 ms |
| Binary | 7.8 MB, excluding the WebView2 runtime already on Windows 11 |

### In progress

Nothing. M1 is complete apart from the open items in `docs/KNOWN_ISSUES.md`.

### Blockers

- Codex sign-in on this machine has expired, and only the user can renew it.

### Next steps

1. Close the verification gaps in `KNOWN_ISSUES.md`, starting with a real Codex turn and a real cloud chat.
2. Persistence: SQLite history for chats and sessions.
3. A pin for the panel, and a smaller compact window to recover GPU memory.
4. Multi-monitor and display-scale handling.
5. Observed sessions through opt-in hooks.
6. Desktop context engine, from foreground application metadata upward.
