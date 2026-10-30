# Meridian

A universal AI companion for the Windows desktop. A small island of real glass sits at the top of your screen, and one
line of light tells you what your AI is doing. Chat with any model or with Claude Code, ask about what is on your screen,
control your music, and see your day, all from one place.

Meridian is a working title. This is milestone 2: a real, running app, not the finished product. See
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

To use a model, open Providers and add an API key, or start a local server such as Ollama or LM Studio and choose Find
local servers. To chat with Claude Code, pick it as the engine in Chat. It uses your own installed CLI and sign-in, so no
API key is needed. To run a task, open Agents, pick a folder you trust, and describe it. Permission requests appear on the
island.

To connect mail and calendars, see [Connecting accounts](docs/development/CONNECTING_ACCOUNTS.md).

**Personal use only for now.** Anthropic does not permit third-party apps to offer Claude.ai login or to route requests
through subscription plans on behalf of their users, so read [the licensing note](docs/KNOWN_ISSUES.md#licensing-read-before-distributing)
before giving this to anyone else.

## Test it

```powershell
npm test              # Rust and unit tests
npm run test:e2e      # the real interface, on a browser stand-in for the core
```

`tests/live/` drives the real app against the real CLIs. See its header.

## Build it

```powershell
npm run build -w apps/desktop
npx --prefix apps/desktop tauri build --no-bundle
```

## Status

**Working, and verified in the real app:** real desktop blur, every island state, click-through, tray, global shortcuts,
placement, Claude Code as a chat engine and as task sessions with approve, deny, stop and resume, screen capture with local
OCR and error detection, media detection and controls, reading bookings from a pasted email, reminders, and local server
streaming.

**Built, but not yet proven against the real thing:** Gmail, Google Calendar, Outlook and Microsoft Calendar (they need your
own app registration), a full Codex turn, live cloud APIs, real Ollama or LM Studio.

**Not built yet:** speech, saved chat history, workflows, installer.

The full list is in [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md).

## Layout

```
apps/desktop/          The app
  src/island/          The morphing island and the line of light
  src/panel/           The expanded command center
  src/lib/             Store, and the bridge to Rust
  src-tauri/           Window, tray, glass, commands
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
