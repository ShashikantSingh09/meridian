# Reference Analysis

Date: 2026-10-30. Working product name: Meridian (working title, not trademark-cleared).

This document records what was learned from the two reference products and from three adjacent
projects, and what Meridian should adopt, improve, avoid, or do differently.

## Method and evidence labels

Coucou, Glint and EchoIsland were studied from shallow clones of their public repositories. TwoCode
is closed source, so it was studied from its website, its privacy policy, and a read-only inspection
of its public installer. The installer was never executed.

- **VERIFIED** means the fact was read directly in source code, a config file, official documentation,
  or the bytes of a downloaded file.
- **CLAIMED** means a project states it about itself, and it was not independently tested.
- **INFERENCE** means a conclusion drawn from verified facts.
- **UNKNOWN** means the question could not be answered with the available evidence.

## TwoCode (https://twocode.nl/)

### Product concept (CLAIMED, from the website)

TwoCode describes itself as "A small island for Claude Code and Codex." It runs on Windows 10 and 11
only and is in public beta. A character called Robo lives inside the island and has named animated
states: Happy, Curious, Focused, Wink, In love and Dizzy.

Its feature set is narrow and focused. It shows live agent activity (files read, files changed,
commands run), lets the user allow or deny permission requests from the island, raises completion
alerts through sound, colour and a Windows notification, and shows progress and history when opened.
Dragging Robo onto a window lets the user ask a question about that window. The site says agent status
is read locally, and that Robo questions and screenshots go to the AI the user connected.

Pricing is free during the beta, and the site says it will change afterwards. The privacy policy
(https://twocode.nl/privacy/) describes a periodic update check that sends the app version, Windows
version, language, country and a random code, and an anonymous statistics option that can be disabled
under Settings. The policy does not describe how Codex status is read.

### Architecture (VERIFIED from the installer, read-only)

The download is `TwoCode-Setup.exe`, version 1.2.0.6, 158.8 MB, and it is not code-signed. The outer
file is a 32-bit Windows Forms setup stub, identified by the strings `Installer.SetupForm`,
`mscorlib` and `System.Windows.Forms.Form`, with an embedded ZIP archive. Reading the ZIP's central
directory, without extracting anything, shows 170 entries, including:

- `TwoCode/TwoCode.exe` at 234 MB uncompressed
- `chrome_100_percent.pak`, `chrome_200_percent.pak`, `resources.pak`, `icudtl.dat`,
  `v8_context_snapshot.bin`, `snapshot_blob.bin`, `ffmpeg.dll`, `vk_swiftshader.dll`,
  `d3dcompiler_47.dll` and `LICENSES.chromium.html`
- `TwoCode/resources/app/package.json`, in an unpacked `resources/app` folder of about 1.6 MB
- `TwoCode/resources/app/vscode-editor/package.json`

**INFERENCE:** this is the standard Electron distribution layout, so TwoCode is almost certainly an
Electron app. The application code is small compared with the runtime it ships. No `.node` native
modules were found, which suggests its native desktop integration, if any, is done some other way.

### Gaps

The master prompt asks for a study of TwoCode's animation, window behaviour and glass effects. None of
that could be observed, because the website gives no technical detail and the unsigned installer was
deliberately not run. **UNKNOWN:** its motion design, window technique, and how it reads agent status.
A person could run it in a sandbox and record the behaviour if that comparison matters.

## Coucou (https://github.com/louis-cfm/coucou)

### Repository and licensing (VERIFIED)

Coucou has 6,782 stars and 1,192 tracked files, split across a native macOS app (`NotchBuddy/`, Swift),
an Android app (`android/`), and a Tauri app for Windows and Linux (`windows/`, 251 files). Rust and
TypeScript in `windows/` are the most relevant parts for Meridian.

The source code is MIT. `LICENSE-ASSETS.md` reserves the names Coucou and Mochi, the Mochi character,
the icons, the sounds, and the images and videos. **Meridian reuses no assets and no character.** The
MIT code was read to learn patterns, and no code is copied.

### Window model (VERIFIED, `windows/src-tauri/src/island.rs`, `tauri.conf.json`)

There is one borderless, transparent, always-on-top window that never takes focus. The island is a
shape drawn inside that window, glued to the top edge and horizontally centred. The window itself
switches between only two sizes: a 240×6 logical pixel invisible wake strip when hidden, and a fixed
720×320 panel otherwise. The island's visible size never resizes the OS window. Animation happens
entirely inside the webview, which avoids the jitter of resizing a native window on every frame.

Click-through is decided by a background thread. The front end pushes the island's rectangle to Rust,
and a thread polls the cursor every 16 ms and toggles `set_ignore_cursor_events` when the cursor
crosses a 14 logical pixel margin around the shape. A code comment explains why the decision lives in
Rust: an IPC round trip per decision loses clicks. The same thread parks on a condition variable while
the island is hidden, and checks for monitor changes about twice a second.

The module also handles three problems that any Windows overlay meets. It identifies displays by a
composite of logical origin, name and size, because Tauri exposes no stable monitor ID. It corrects
WebView2 zoom when the device pixel ratio disagrees with the window scale. And while a mouse button is
held, it lets the whole panel take the mouse, because click-through hides the window from OLE drag and
drop.

### Focus and Win32 details (VERIFIED, `windows/src-tauri/src/platform/windows.rs`)

`WS_EX_NOACTIVATE` keeps clicks from stealing focus, and `WS_EX_TOOLWINDOW` keeps the island out of
Alt-Tab. Activation is toggled on only while a text field needs typing. Other details worth recording:
walking process ancestors to find the terminal window of a session, walking `%PATH%` and `%PATHEXT%`
manually to find CLIs (with npm, Volta, pnpm, Bun and `.local\bin` fallbacks), and detecting shortcuts
that collide with AltGr characters on the user's installed keyboard layouts.

### Motion and state (VERIFIED, `windows/src/core/anim.ts`, `windows/src/island/fsm.ts`,
`windows/src/core/layout.ts`, `windows/src/island/island.ts`)

Coucou has no animation library. A small spring integrator, sub-stepped at 240 Hz so that a dropped
frame cannot destabilise it, is parameterised by response and damping fraction. Its most useful idea is
asymmetry: growth uses a spring, and shrinking uses a timed 340 ms curve with no overshoot. The frame
loop runs on `requestAnimationFrame` only while something is animating, and stops itself otherwise. A
comment records an earlier bug where looping character animations kept the loop alive while hidden.

Island open and close logic is a four-state machine with no DOM or Tauri dependency, which makes it
testable. It has timers for each collapse, a `pinned` flag so that a pending alert keeps the island
open, and a hover-open mode. Geometry lives in a table of view layouts with explicit pixel sizes.

A search of `island.ts`, `style.css`, `main.ts` and `views.ts` found no `prefers-reduced-motion`
handling and no `backdrop-filter`. The island is an opaque black shape, so Coucou makes no attempt at
real glass.

### AI and agent integration (VERIFIED)

Chat is split by wire format: `claude.rs` for Anthropic, `openai_compat.rs` for OpenAI, Gemini's
compatible endpoint and OpenRouter, and `local_chat.rs` for Ollama, LM Studio and any OpenAI-compatible
server. API keys stay in Rust and never reach the webview, and `secrets.rs` enforces an allowlist of
key names. When no Anthropic key exists, `claude_code.rs` answers through the user's own `claude -p`,
isolated from their settings, hooks and project folders.

Agent monitoring is hook-based. `windows/hook/src/main.rs` is a small relay executable that each agent
runs on each hook event. It normalises event names, sends the event over a per-user named pipe, and
obeys one hard rule: it must never block the agent. It allows 300 ms to connect, 2 seconds for
fire-and-forget events, and 110 seconds only for a permission decision, and any failure means the
agent asks in its own terminal. `pipe.rs` adds an 800 ms acknowledgement so that a hidden island cannot
leave an agent waiting for nobody. `hooks.rs` never writes `settings.json` without a dated backup, a
shown diff, and a fingerprint check that the file is unchanged since the user reviewed it.

Coucou supports many agents this way (`windows/README.md`, "Supported agents"), and it maps each one
onto Claude Code's event vocabulary. Most of them only receive monitoring, with approvals limited to
Claude Code, Codex, Copilot CLI and Muse Code.

### Scope beyond agents (VERIFIED)

Coucou also carries dictation and a notetaker with on-device speech recognition (sherpa-onnx with
Parakeet, audio through `cpal`), a wake phrase (`src-tauri/src/voice/wake.rs`), integrations with
Spotify, WhatsApp and GitHub, a phone link, and a weekly recap. That breadth is useful as proof of what
is possible, and it is also a warning about scope.

## Adjacent projects

Glint and EchoIsland are analysed in `TECHNICAL_FINDINGS.md` and compared in `FEATURE_COMPARISON.md`.
The short version is that Glint confirms the acrylic limitation, and that EchoIsland took a
fundamentally different route by drawing its Windows island with Direct2D in a layered window.

## What to adopt, improve, avoid, or do differently

| Topic | Decision | Reason |
|---|---|---|
| Fixed transparent window, shape inside it | Adopt | Proven, avoids per-frame native resize jitter |
| Rust owns the click-through decision | Adopt | Coucou's comment records lost clicks from IPC round trips |
| 16 ms cursor poll at all times while visible | Improve | Poll slowly when the cursor is far from the island |
| Spring to grow, curve to shrink | Adopt the idea | Feels right and avoids overshoot on close |
| Pure state machine with no DOM dependency | Adopt | Testable, and island state is the core of the product |
| Keys only in Rust, allowlisted | Adopt | A compromised webview must not reach credentials |
| Backup, diff, fingerprint before editing agent config | Adopt | Respects the user's configuration |
| Agents must never be blocked | Adopt as a rule | The companion is optional, and the agent's work is not |
| Hook-only monitoring | Do differently | Managed sessions give structured output with no config edits |
| Black opaque island | Do differently | Glass is a primary requirement of this product |
| Mascot character | Do differently | The Meridian Line is the character, see below |
| No reduced-motion support | Improve | It is an explicit requirement here |
| Wide integrations (Spotify, WhatsApp) | Avoid for now | Product quality outranks feature count |
| Unsigned installers | Avoid | Both references ship unsigned on Windows, which harms trust |

## The Meridian concept

Coucou has Mochi and TwoCode has Robo. Both express state through an animated mascot. Meridian takes a
different path called "one line of light". A single luminous line, the Meridian Line, is the product's
character, and it expresses every state: a slow breath when idle, a waveform when listening, a standing
wave when thinking, a travelling pulse when working, one segment per agent when several are running, a
flare for a notification, and a fracture for an error. This is original, it reads at very small sizes,
it needs no artwork, and it scales from a compact pill to a full panel.
