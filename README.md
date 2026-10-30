# Meridian

A universal AI companion for the Windows desktop. A black notch hangs from the top of your screen, and one line of light
tells you what your AI is doing. Follow your Claude Code sessions from any terminal and answer them from the island, chat
with any model, see what your connected services have for you, ask about what is on your screen, and control your music.

Meridian is a working title. This is milestone 3: a real, running app, close to a first customer but not there yet. See
[what works](#status) below.

## Run it

Needs Windows 11, Node 22 or later, Rust, and the Visual Studio C++ Build Tools.

```powershell
npm install
npm run dev
```

The island appears at the top of your screen.

| To | Do |
|---|---|
| Open the panel | `Ctrl+Alt+Space`, click the island, or click the tray icon |
| Close it | `Esc`, or click anywhere else |
| Quit | Tray icon, Quit |
| Ask about your screen | `Ctrl+Alt+S`. You see a preview, and nothing leaves your PC until you share it |
| Pause all monitoring | Tray icon, or Settings |
| See every island state | Settings, Preview island states |

To follow Claude Code, turn on Settings, Coding agents, Follow my Claude Code sessions. Sessions from any terminal then
appear on the island, and permission requests can be answered there. It makes no model request of its own.

To connect a service, open Settings, Providers, choose one and connect. Most need no setup. To connect mail and calendars,
see [Connecting accounts](docs/development/CONNECTING_ACCOUNTS.md).

To use a model, open Settings, AI models, and add an API key, or start a local server such as Ollama or LM Studio and choose
Find local servers. To chat with Claude Code, pick it as the engine in Chat. It uses your own installed CLI and sign-in, so
no API key is needed.

**Before giving this to anyone else,** read [the licensing note](docs/KNOWN_ISSUES.md#licensing-read-before-distributing)
and [Shipping](docs/KNOWN_ISSUES.md#shipping-to-customers).

## Test it

```powershell
npm test              # Rust and unit tests
npm run test:e2e      # the real interface, on a browser stand-in for the core
```

`tests/live/` drives the real app against the real CLIs. See its header.

## Build it

```powershell
cd apps/desktop
npx tauri build
```

This makes the app and an NSIS installer. Releases are in [Releasing](docs/development/RELEASING.md).

## Status

**Working, and verified in the real app:** the notch island in every state, click-through, tray, global shortcuts,
following a real Claude Code run through hooks with an answer from the app, Claude Code as a chat engine and as task
sessions with approve, deny, stop and resume, screen capture with local OCR and error detection, media detection and
controls, reading bookings from a pasted email, reminders, and local server streaming.

**Built, but not yet proven against the real thing:** every provider sign-in (no real account was connected), Gmail, Google
Calendar and Outlook, updates, a full Codex turn, live cloud APIs, real Ollama or LM Studio.

**Not built yet:** speech, workflows, following Codex.

The full list is in [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md).

## Layout

```
apps/desktop/          The app
  src/island/          The morphing island and the line of light
  src/panel/           The expanded command center
  src/lib/             Store, and the bridge to Rust
  src-tauri/           Window, tray, providers, following, commands
crates/ai-core/        Providers: catalog, streaming, discovery
crates/agent-adapters/ Claude Code and Codex sessions, approvals
crates/screen/         Capture, local OCR, error signals
crates/media/          Windows media sessions and controls
crates/activity/       Events, extraction, notifications, accounts
packages/design-system Tokens for colour, surface and motion
docs/                  Research, PRD, architecture, decisions
tests/live/            Checks against the real app and CLIs
```

## Documents

[Architecture](docs/ARCHITECTURE.md) · [Decisions](docs/DECISIONS.md) · [Design system](docs/design/DESIGN_SYSTEM.md) ·
[PRD](docs/PRD.md) · [Plan](docs/IMPLEMENTATION_PLAN.md) · [Ledger](docs/DEVELOPMENT_LEDGER.md) ·
[Known issues](docs/KNOWN_ISSUES.md) · [Security](docs/security/THREAT_MODEL.md) · [Research](docs/research/)

## Privacy

Your screen is read only when you ask, or in contextual mode if you turn it on, and always on this PC. Nothing is shared
until you approve a preview. Mail and calendars are read-only and read locally. Keys and tokens stay in Windows Credential
Manager. No keystrokes, no clipboard, no telemetry. See the [threat model](docs/security/THREAT_MODEL.md).
