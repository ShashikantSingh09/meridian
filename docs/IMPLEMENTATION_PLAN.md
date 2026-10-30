# Implementation plan

Status of each phase from the master brief. Every milestone must end in something that runs.

| Phase | Scope | Status |
|---|---|---|
| 1. Research and definition | References, Windows technology, PRD, architecture | Done |
| 2. UI and visual prototype | Island, all states, notch shape, motion, settings | Done |
| 3. Windows foundation | Shell, positioning, tray, shortcut, lifecycle, settings | Done, except multi-monitor and sleep handling |
| 4. Universal AI | Provider abstraction, Anthropic, OpenAI-compatible, local, streaming | Done; conversation persistence open |
| 5. Multi-agent command center | Claude Code, Codex, sessions, controls | Core done, and agents work as chat engines; history and comparison open |
| 6. Desktop context engine | Foreground detection, events, suggestions, modes | Screen awareness and unified events done; app profiles open |
| 7. Voice and workspace | Speech, profiles, project context | Mic level only |
| 8. Automation | Workflow engine, agent collaboration | Not started |
| 9. Release | Optimization, security review, installer, updates | Installer and update path built. Signing and hosting open |

M2 added the top-center island work, Claude Code as a chat engine, screen awareness, media, personal activity and unified
notifications. M3 added the notch island, the providers column, following Claude Code from any terminal, history, first run
and the update path. See `docs/DEVELOPMENT_LEDGER.md`.

## Next milestone: M4, ready for a first customer

**Goal.** A stranger can install it, connect something real, and trust it.

1. Verify the open items: real accounts, real MCP services, real Codex turn, real cloud chat, real media players.
2. Decide the name and bundle ID, then sign the installer and host updates. See `docs/development/RELEASING.md`.
3. Resolve the Claude subscription question for chat, see D19. Following sessions does not depend on it.
4. Verify multiple monitors, and 125%, 150% and 200% scaling.
5. Handle sleep and resume, and a WebView2 process crash.
6. Add a panel pin, Markdown rendering and file attachments.
7. Follow Codex the same way as Claude Code, then Gemini CLI and Aider.

## M5: voice

Push to talk first, with a local engine by default. Then text to speech with interruption, then voice commands. Wake word
is last and strictly opt-in.

## M6: workflows

A controlled engine with templates, approval checkpoints and execution history. Agent collaboration runs through it, and
never through direct agent-to-agent messaging.

## M7: release

Security review, compatibility testing, signing, auto-update, diagnostics and user documentation.
