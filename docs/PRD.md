# Meridian: Product Requirements Document

Status: Draft for Milestone 1. Date: 2026-10-30.
Meridian is a working title, and it has not been trademark-cleared.

## 1. Vision

Meridian is a universal AI companion that lives at the top of the Windows desktop. It gives one calm, beautiful
surface for every AI a person uses: cloud models, local models, and coding agents such as Claude Code and Codex.
It stays out of the way until it is useful, and it should feel like a natural part of Windows.

Research found that several projects already show agent status in a desktop island, and that all of them only
observe sessions started elsewhere (`docs/research/FEATURE_COMPARISON.md`). Meridian's position is different: it is
where a person **starts, instructs, watches and stops** AI work across every vendor.

### The concept: one line of light

A single luminous line, the Meridian Line, is the product's character. Competing products use mascots, such as Mochi
in Coucou and Robo in TwoCode. Meridian expresses every state through the same line, which keeps the interface
minimal, original, and readable at very small sizes.

## 2. Target users

1. **The multi-agent developer** runs Claude Code, Codex and local models on real projects, and is tired of switching
   terminals to check what each one is doing. This is the primary user for M1 and M2.
2. **The local-first engineer** prefers Ollama or LM Studio and wants assurance that nothing leaves the machine.
3. **The cloud and infrastructure engineer** works across terminals and consoles, and wants help with failures in
   context. This user is served from M3.
4. **The AI power user** uses several subscriptions and API keys and wants one interface for all of them.

## 3. Five defining capabilities

1. **Adaptive Dynamic Island.** An interface that transforms according to current activity, without interrupting.
2. **Multi-Agent Command Center.** One place to manage Claude Code, Codex, local models and other agents.
3. **Contextual Intelligence.** It understands permitted desktop activity and offers useful assistance.
4. **Voice-First Interaction.** Talking to the island is as natural as typing to it.
5. **Personal AI Workspace.** Persistent preferences, project context, custom behaviour and personal workflows.

## 4. Island states

All nine states are in M1 scope as real, animated interface states. The Listening state's speech recognition arrives
in M4. In M1, Listening is a complete visual state, and its waveform must not imply that words are being understood.

| State | Purpose | Meridian Line | Key content |
|---|---|---|---|
| Idle | Available, minimal footprint | Slow breath | Availability indicator |
| Listening | Microphone is active | Audio waveform | Microphone status, voice controls |
| Thinking | Model is preparing a response | Standing wave | Selected engine, short status |
| Working | Agent is executing | Travelling pulse | Task, activity, session controls |
| Notification | Something finished or needs attention | Flare | Message, action, auto-collapse |
| Expanded | Full interaction | Line becomes the panel's header accent | Chat, models, sessions, history |
| Contextual Assistance | A relevant suggestion is available | Soft glint | Accept, dismiss, investigate |
| Multi-task | Several sessions are active | One segment per agent | Session switching, agent status |
| Error | Something failed | Fracture | Reason, retry and recovery |

The Contextual Assistance state is built in M1 as a state and component. Its data source, the context engine, arrives
in M3.

### Behaviour rules

- The island must never take keyboard focus without a user action.
- Automatic expansion must be rare, and it must be configurable.
- A pending decision outranks a notification. An error must not destroy an open conversation.
- Notifications collapse on their own, unless they need a decision.
- Progress is shown only when an agent reports it. Percentages are never invented.

## 5. Scope by milestone

The nine phases of the master plan map to six milestones.

| Milestone | Phases | Outcome |
|---|---|---|
| M1 Foundation | 1, 2, 3, 4, core of 5 | A working island with real providers and managed agent sessions |
| M2 Command Center | Rest of 5 | History, observed sessions, more agents, output comparison |
| M3 Context | 6 | Context engine, assistance modes, privacy dashboard |
| M4 Voice and Workspace | 7 | Voice input and output, project context, profiles |
| M5 Automation | 8 | Workflow engine, approvals, multi-agent workflows |
| M6 Release | 9 | Optimisation, security review, signed installer, updates |

### M1 Foundation, in scope

- Research deliverables and project documents.
- Tauri 2 desktop shell on Windows 11, also expected to run on Windows 10 with the CSS material.
- The island with all nine states, the motion system, and design tokens.
- Always-on-top placement, click-through outside the island, and no focus theft.
- Basic multi-monitor and display-scaling handling.
- System tray and a global shortcut.
- Settings persistence, and credential storage in Windows Credential Manager.
- Provider abstraction with streaming: Anthropic, OpenAI, OpenAI-compatible endpoints, Ollama and LM Studio.
- Model discovery, connection tests, local endpoint discovery, and a local-only setting.
- Claude Code and Codex CLI detection, and managed sessions in a chosen project directory.
- Concurrent sessions with status, output, follow-up instructions and cancellation, where each agent supports them.
- Permission requests surfaced in the island, where the agent's protocol supports them.
- Automated tests for the provider layer, agent event parsing, and the island state reducer.

### M2 and later

- **M2:** SQLite history, opt-in hook relay for observed sessions, Gemini CLI and Aider adapters, side-by-side output
  comparison, usage statistics, autostart.
- **M3:** foreground and process awareness, application exclusions, Manual, Contextual and Proactive modes, privacy
  dashboard, optional on-demand screen capture.
- **M4:** push-to-talk, speech-to-text, text-to-speech, interruptible conversation, optional wake word, persistent
  project context, and application profiles.
- **M5:** workflow templates, approval checkpoints, execution previews, and multi-agent workflows through a controlled
  engine, never through uncontrolled agent-to-agent messages.
- **M6:** performance and memory work, security review, compatibility testing, signed installer, and auto-update.

## 6. Explicit non-goals for M1

- Speech-to-text, text-to-speech and wake word. The Listening state is visual only.
- Desktop awareness of any kind, including foreground detection, clipboard access and screen capture.
- The workflow engine.
- SQLite storage or long-term session history. Sessions are held in memory, and settings are persisted.
- Installers, code signing and auto-update. M1 runs from a development or local release build.
- Hook installation or any edit to the user's agent configuration.
- Agent adapters other than Claude Code and Codex.
- Light theme, localisation, and macOS or Linux builds.
- Plugins, and integrations such as music, messaging or email.

## 7. Privacy requirements

These apply from the first build, and the later milestones add to them.

1. **Local first.** Nothing leaves the machine except requests the user directs to a provider they configured.
2. **No telemetry** by default. Any future diagnostics must be opt-in and inspectable.
3. **Secrets** stay in Windows Credential Manager. They never reach the webview, logs or settings files.
4. **Local-only mode** blocks all non-loopback provider traffic, and the interface must show that it is on.
5. **Address exposure** is visible: the interface distinguishes local, remote over HTTPS, and remote in clear text.
6. **No keylogging, no hidden screenshots, no unauthorised clipboard access, no silent uploads**, at any milestone.
7. **Global input hooks are not used.** Shortcuts use registered hot keys.
8. **Approvals are explicit.** Nothing is approved on the user's behalf, and if the app cannot ask, the agent decides
   through its own default behaviour.
9. **Agent configuration is left alone** in M1. Later edits require a backup, a shown diff and explicit confirmation.
10. **Logs are redacted.** They never contain keys or message content by default.
11. **Choosing a project directory is a trust decision.** Agents may run that project's hooks and tools, so sessions
    start only from an explicit user action.

From M3, the requirements add application exclusion lists, a privacy dashboard, an immediate pause for all monitoring,
a preview of what context will be shared with an external provider, and project-level context isolation.

## 8. Success criteria

Reference machine: Windows 11 Pro build 26300, RTX 3070 Ti, 32 GB RAM, 1080p primary display. Numbers marked
provisional must be confirmed by a baseline measurement during M1 and recorded in `docs/DEVELOPMENT_LEDGER.md`.

| Measure | Target | Method |
|---|---|---|
| Idle CPU | Under 0.5% of one logical core on average over 5 minutes, provisional | Process tree sampling |
| Hidden CPU | Effectively zero, with no animation frames and a parked poll thread | Process tree sampling |
| Memory | Under 250 MB private working set for the whole process tree, provisional | Sum across WebView2 processes |
| Animation | At least 58 fps during state morphs, with under 1% of frames over 33 ms | Frame timing in the webview |
| Time to first token | Under 30 ms added beyond the provider's own latency | Mock SSE server, direct compared to app |
| Click reliability | No click lost on island controls, and no click swallowed outside the island | Scripted input test |
| Focus | Zero focus changes caused by automatic island updates | Foreground change test |
| Resilience | No provider or agent failure crashes the shell | Failure injection tests |
| Concurrency | Two Claude Code and two Codex sessions run at once without blocking the UI | Manual and integration test |

**M1 baseline, release build, measured 2026-10-30 on the reference machine with a 180 Hz display:**

| Measure | Result | Status |
|---|---|---|
| Idle CPU | About 0.37% of one core once the breath ends, over 30 s, not 5 minutes | Meets target over the shorter window |
| Hidden CPU | Not measured | Open |
| Memory | About 166 MB at fresh idle, about 268 MB after the panel has been opened | Meets target |
| Animation | 180 fps, p95 5.7 ms, 0% of frames over 33 ms across six morphs | Meets target |
| Time to first token | Not measured | Open |
| Click reliability | OS-level hit testing correct on and off the shape; no scripted click suite | Partial |
| Resilience | Dead server, expired sign-in, crash, cancel all handled without a shell crash | Meets target |
| Concurrency | Not tested with live agents | Open |

Memory targets deliberately avoid the very low figures quoted online. Research found that WebView2 is Chromium-class on
Windows, so the target will be tightened from measurement, and not from marketing numbers.

The qualitative test matters as much as these numbers: a person should want to leave Meridian running every day, and it
should look like a polished commercial product in a side-by-side comparison with the studied projects.

## 9. Open questions

1. **Glass material.** Resolved: the host backdrop visual works. See `docs/research/TECHNICAL_FINDINGS.md`, section 9.
2. **Windows 10.** Host backdrop brushes need Windows 11. Is a visibly simpler Windows 10 material acceptable?
3. **Claude Code approvals.** Resolved: a per-run `http` hook through `--settings`. See `docs/DECISIONS.md`.
4. **Codex stability.** `codex app-server` is marked experimental. How much version tolerance is needed, and should
   `codex exec --json` remain as a fallback?
5. **Stopping turns on Windows.** Claude Code documents SIGINT for ending a turn cleanly. What is the correct equivalent for
   a child process on Windows?
6. **Licence and distribution.** Will Meridian be open source, free or paid? This affects signing and naming.
7. **Name.** Meridian has not been cleared, and a final name must be chosen before any public release.
8. **Island position.** Should it stay at top centre, or allow user placement along the top edge or in corners?
9. **WebView2 budget.** If the memory target fails, is the Direct2D island contingency acceptable, given that it gives up web
   motion tooling and probably real glass?
