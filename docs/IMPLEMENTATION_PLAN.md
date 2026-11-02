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

## Notes: call notes, built

**Goal.** Press Record on a call. Afterwards there is a transcript of who said what, in Hindi, English or a mix, with a summary and the to-dos, and the assistant can
answer from it. What Coucou does is in `docs/research/NOTETAKER_REVIEW.md`. The boards were approved on 2026-11-02 and built. What is left to prove is in `docs/KNOWN_ISSUES.md`.

**The same as Coucou.** A click starts it and nothing starts by itself. Microphone and system sound are recorded apart, the audio is deleted once the transcript is written, a
failure keeps the audio for Try again, and a crash is recovered at the next launch. Lines break on a pause, echo is dropped by comparing words, and summaries invent
nothing. Rename, tick to-dos, Copy as Markdown, Export, and Delete with a confirmation.

**Different on purpose.**

| Coucou | Meridian | Why |
|---|---|---|
| Parakeet on the PC | The hearing already chosen in Voice: ElevenLabs or Deepgram | Parakeet has no Hindi, and it is a 670 MB download |
| Diarizer model on the PC | The service gives each word a speaker | No model to ship |
| Words live while recording | Level meters and a clock | Live words would be paid for twice, about $0.44 more per hour |
| Claude only | The engine chosen for Chat | Same rule as everything else here |
| `cpal` for system sound | WASAPI through `windows-rs`, already in `crates/media` | No new dependency, and silence can be filled to keep one clock |
| A pill | The island, with a red dot that stays over every view | The island is this app. Recording must never be hidden |
| Nothing for the assistant | A read-only `my_notes` tool | "What did we decide on that call?" is the point of an assistant |

**Left out, and when to add it.** AI correction of misheard words and a learned vocabulary, once real transcripts show how often they are wrong. Editing one line. Voice to start or
stop, which needs a thought about consent. Local hearing, which is English only and has no speakers. Call detection, which Coucou does not have either.

**Build order.** Each step ends in something tested.

1. `crates/notes`, pure logic: the model, words to lines, echo, speakers, Markdown, the summary request and reply, the store on disk.
2. System sound in `crates/media`: 16 kHz mono, with silence filled in by the clock. Measure what loopback delivers in silence.
3. `transcribe_words` in `crates/voice`: word times and speakers from both services, with a timeout that suits a long file.
4. `src-tauri/notes.rs`: start, stop, microphone chunks from the page, crash recovery, a four-hour limit, wake words paused, and refusal in Local only or with monitoring paused.
5. Summaries through the Chat engine, with the transcript marked as content from other people.
6. The Notes tab, the island's red dot and clock, and the Notes ready notice.
7. `my_notes` for the assistant.
8. Threat model, privacy page, known issues, a decision, and the ledger.

**Proof before it counts as done.** Unit tests on all of step 1. A silent run and a run with sound through the real loopback. A short real recording, with the owner's say-so
because it spends their ElevenLabs balance. Each tab compared with its board in the real window.

## M5: voice

Push to talk first, with a local engine by default. Then text to speech with interruption, then voice commands. Wake word
is last and strictly opt-in.

## M6: workflows

A controlled engine with templates, approval checkpoints and execution history. Agent collaboration runs through it, and
never through direct agent-to-agent messaging.

## M7: release

Security review, compatibility testing, signing, auto-update, diagnostics and user documentation.
