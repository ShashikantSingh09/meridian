# Meridian

A universal AI companion for the Windows desktop. A small island of real glass sits at the top of your screen, and one
line of light tells you what your AI is doing. Chat with any model, run Claude Code and Codex side by side, and approve
what they want to do without leaving your work.

Meridian is a working title. This is milestone 1: a real, running app, not the finished product. See
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
| See every island state | Settings, Preview island states |

To use a model, open Providers and add an API key, or start a local server such as Ollama or LM Studio and choose Find
local servers. To run an agent, open Agents, pick a folder you trust, and describe the task. Its permission requests
appear on the island.

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

**Working, and verified in the real app:** real desktop blur, all nine island states, click-through, tray, global shortcut,
settings, Claude Code sessions with approve, deny, cancel and resume, local server discovery and streaming, clean failure
when a server dies.

**Built, but not yet proven against the real thing:** a full Codex turn (the sign-in here has expired), live cloud APIs,
real Ollama or LM Studio.

**Not built yet:** speech, desktop context awareness, workflows, saved history, installer.

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
packages/design-system Tokens for colour, surface and motion
docs/                  Research, PRD, architecture, decisions
tests/live/            Checks against the real app and CLIs
```

## Documents

[Architecture](docs/ARCHITECTURE.md) · [Decisions](docs/DECISIONS.md) · [Design system](docs/design/DESIGN_SYSTEM.md) ·
[PRD](docs/PRD.md) · [Plan](docs/IMPLEMENTATION_PLAN.md) · [Ledger](docs/DEVELOPMENT_LEDGER.md) ·
[Known issues](docs/KNOWN_ISSUES.md) · [Security](docs/security/THREAT_MODEL.md) · [Research](docs/research/)

## Privacy

This build reads no screen, clipboard, keyboard or window content, and has no telemetry. Keys stay in Windows Credential
Manager. See the [threat model](docs/security/THREAT_MODEL.md).
