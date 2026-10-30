# Implementation plan

Status of each phase from the master brief. Every milestone must end in something that runs.

| Phase | Scope | Status |
|---|---|---|
| 1. Research and definition | References, Windows technology, PRD, architecture | Done |
| 2. UI and visual prototype | Island, all states, glass, motion, settings | Done |
| 3. Windows foundation | Shell, positioning, tray, shortcut, lifecycle, settings | Done, except multi-monitor and sleep handling |
| 4. Universal AI | Provider abstraction, Anthropic, OpenAI-compatible, local, streaming | Done; conversation persistence open |
| 5. Multi-agent command center | Claude Code, Codex, sessions, controls | Core done, and agents work as chat engines; history and comparison open |
| 6. Desktop context engine | Foreground detection, events, suggestions, modes | Screen awareness and unified events done; app profiles open |
| 7. Voice and workspace | Speech, profiles, project context | Mic level only |
| 8. Automation | Workflow engine, agent collaboration | Not started |
| 9. Release | Optimization, security review, installer, updates | Baseline measured only |

M2 added the top-center island work, Claude Code as a chat engine, screen awareness, media, personal activity and unified
notifications. See `docs/DEVELOPMENT_LEDGER.md`.

## Next milestone: M3, a companion you can trust all day

**Goal.** Everything works against real accounts, and nothing is lost on restart.

1. Verify the open items: real accounts, real Codex turn, real cloud chat, real local server, real media players.
2. Persist chats and agent sessions in SQLite, with retention controls.
3. Verify multiple monitors, and 125%, 150% and 200% scaling.
4. Handle sleep and resume, and a WebView2 process crash.
5. Add a panel pin, Markdown rendering and file attachments.
6. Shrink the window while compact, and measure the memory recovered.
7. Build an NSIS installer.

## M4: observe everything

Opt-in, previewed, backed-up global hooks for sessions started outside the app, then adapters for Gemini CLI and Aider.
Foreground application context through `SetWinEventHook` and application profiles.

## M5: voice

Push to talk first, with a local engine by default. Then text to speech with interruption, then voice commands. Wake word
is last and strictly opt-in.

## M6: workflows

A controlled engine with templates, approval checkpoints and execution history. Agent collaboration runs through it, and
never through direct agent-to-agent messaging.

## M7: release

Security review, compatibility testing, signing, auto-update, diagnostics and user documentation.
