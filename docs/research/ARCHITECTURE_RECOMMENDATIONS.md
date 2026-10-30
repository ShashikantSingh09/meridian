# Architecture Recommendations

Date: 2026-10-30. These are recommendations from research. Final decisions belong in `docs/DECISIONS.md`,
and the implemented design belongs in `docs/ARCHITECTURE.md`.

## Summary

Build Meridian on Tauri 2 with a Rust core and a React island in WebView2. Keep all credentials, network
calls and process control in Rust, and treat the webview as an untrusted renderer. Use a fixed transparent
window with click-through decided in Rust. Integrate coding agents through their structured protocols
first, and add hook relays later for sessions started outside the app.

## Recommended stack

| Layer | Recommendation | Basis |
|---|---|---|
| Desktop shell | Tauri 2 | Proven for this product shape by Coucou and Glint |
| Island rendering | WebView2 with React and TypeScript | Fast iteration on motion and design |
| Island geometry motion | A small TypeScript spring | Needs per-frame access for hit rectangle and backdrop |
| Content motion | Motion | Good for transitions inside the island |
| Styling | Tailwind CSS with design tokens as CSS variables | Tokens stay usable outside React |
| Glass material | Host backdrop visual if the spike passes, CSS otherwise | See `TECHNICAL_FINDINGS.md`, section 9 |
| Native integration | Rust with the `windows` crate | Same language as the core |
| Secrets | Windows Credential Manager through `keyring` | Coucou's pattern, works well |
| Settings | A JSON file in the app data directory | SQLite is not needed until history exists |
| History, later | SQLite | Fits session and task queries |
| Testing | Vitest and `cargo test`, Playwright for the web layer | Requested stack |

Current stable versions seen on 2026-10-30: `tauri` 2.12.5, `@tauri-apps/cli` 2.12.4, `react` 19.3.1,
`motion` 14.8.0, `vite` 8.3.5, `typescript` 7.0.2, `vitest` 5.0.5, `tailwindcss` 4.3.3, `windows` 0.62.2,
`window-vibrancy` 0.8.1, `keyring` 4.2.0, `reqwest` 0.13.5. Coucou pins older majors of `windows`,
`keyring` and `reqwest`, so its code is not a safe API reference for these versions.

## Process and trust model

Three layers keep responsibilities and trust separate.

1. **Webview, untrusted.** It renders state and sends typed intents. It never receives an API key, and it
   never makes a provider request or starts a process. A strict CSP with no remote content applies, as in
   Coucou's `tauri.conf.json`. Tauri capabilities should expose only the commands the island needs.
2. **Rust core, trusted.** It owns settings, credentials, provider clients, agent processes, the
   permission decision queue, and the single source of truth for island state inputs.
3. **External processes, untrusted output.** Agent CLIs and local model servers run as child processes or
   remote endpoints. Their output is data, never instructions. It must be parsed defensively, bounded in
   size, and treated as attacker-controllable text when rendered.

## Separation by crate and package

The master prompt lists twelve independent concerns. Separation should be real, but it should not be
speculative, so each boundary should appear when its first implementation arrives.

- `crates/ai-core`: provider contract and provider clients, with no Tauri dependency, so it can be tested
  with `cargo test` against a mock server.
- `crates/agent-adapters`: coding agent detection and session protocols, also with no Tauri dependency.
- `apps/desktop/src-tauri`: the shell, including windows, tray, shortcuts, IPC commands, and the bridge
  from core events to the webview.
- `apps/desktop/src`: React island, panel and settings.
- `packages/design-system`: tokens, material CSS and motion tokens.

Voice, context engine and workflow engine should become crates in their own milestones. Creating empty
packages for them now would add structure with nothing inside to protect.

## Provider abstraction

Providers should describe what they can actually do, and the interface should adapt from that
description, as the master prompt requires. A provider exposes a capability set (streaming, tools, vision,
model listing) and a small set of operations: list models, stream a chat, health check, and cancel.

Most of the requested vendors use the OpenAI chat format. One configurable OpenAI-compatible client,
driven by a table of presets that holds base URLs and capability flags, covers OpenAI, Gemini's compatible
endpoint, xAI, DeepSeek, OpenRouter, Groq, Together, Mistral, Ollama, LM Studio and llama.cpp. Anthropic
gets its own native client. A per-vendor adapter is justified only when a vendor needs something the shared
client cannot express.

Errors must be typed (authentication, rate limit, unreachable, cancelled, protocol) so the Error state can
offer a meaningful recovery action. A failing provider must return an error value and never panic the shell.

## Coding agent integration

Support two modes, and be explicit in the interface about which mode a session uses.

**Managed sessions (M1).** The app starts the agent and speaks its structured protocol, which requires no
changes to the user's configuration.

- Claude Code: `claude -p` with `stream-json` output and input.
- Codex: `codex app-server` over stdio JSON-RPC.

**Observed sessions (M2).** For sessions the user started in a terminal, install an opt-in hook relay,
following Coucou's safety rules: dated backup, shown diff, fingerprint check, and removal of only our own
entries. Add transcript scanning as a read-only fallback if needed.

Each adapter translates its agent's events into one normalised session event type, with fields for status,
text delta, tool activity, approval request, usage and error. Status values should be Running, Waiting for
input, Completed, Failed and Cancelled, and the UI must show an indeterminate indicator instead of inventing
a progress percentage.

Rules to adopt from Coucou, for both modes:

- Never block an agent. If the app cannot act, the agent must fall back to its own behaviour.
- Never approve anything without an explicit user action.
- Pin nothing to one CLI version. Detect capabilities, for example from the `capabilities` field in Claude
  Code's `system/init`, and tolerate unknown event types by ignoring them.

Three findings need specific handling in the Claude Code adapter:

- A `-p` run in Manual mode denies calls needing approval unless a host or hook approves them, so a managed
  session needs an approval channel.
- `--bare` disables subscription login, so it must not be used for subscription users.
- A `-p` run executes project hooks and MCP servers with no trust prompt, so choosing a folder for a managed
  session must be a deliberate user action, and the UI must not start one automatically.

## Window and input

- Use one fixed transparent window for the island, sized for its largest state, with a smaller invisible
  strip if a hidden state is added.
- Let the webview report the island rectangle to Rust, and let Rust own the click-through decision.
- Poll the cursor adaptively. Park the thread when the island is hidden.
- Declare every window operation as `passive` or `interactive`, following EchoIsland's rule, and never
  activate the window in a passive path.
- Apply `WS_EX_NOACTIVATE` and `WS_EX_TOOLWINDOW`, and enable activation only while text input has focus.
- Re-place the island when the display layout changes, and identify displays by a composite key.
- Correct WebView2 zoom when the device pixel ratio and window scale disagree.

## State model

Island state should be a pure reducer with no DOM or Tauri dependency, so it can be unit tested. Inputs
should be events: session updates, voice state, notifications, hover, click, and explicit user actions. The
output is the current state among the nine island states, plus its content. Priority must be explicit, so
that, for example, an approval request outranks a completion notification, and an error does not replace an
open conversation. The reducer is also the right place to enforce "do not constantly expand or interrupt".

## Performance

- Stop the animation frame loop when geometry settles.
- Use compositor-only CSS for ambient idle animation, and allow it to be turned off.
- Keep expensive blur out of the webview. Do not use large `backdrop-filter` areas.
- Batch streaming text updates to the frame rate instead of rendering once per token.
- Bound the size of stored agent output per session.

## Contingency

If WebView2 cannot meet the memory or idle CPU targets, EchoIsland's design is the known alternative: a
Direct2D island in a layered window, with the webview loaded only for the expanded panel. It trades the speed
of web motion design for a much lighter idle surface and native click-through. **INFERENCE:** a layered window
of that kind is unlikely to combine with a host backdrop visual, so this path would give up real glass. It
should be held in reserve, and revisited only with measurements from the M1 baseline.

## What to avoid

- Per-frame resizing of the native window.
- Acrylic or Mica applied to the whole island window.
- Parsing human-readable terminal output when structured output exists.
- Reading credentials from an agent's internal files.
- Global low-level keyboard or mouse hooks, which would conflict with the no-keylogging requirement.
- Editing `~/.claude/settings.json` or other agent configuration without explicit review.
- Building a plugin system, package splits, or a workflow engine before a second real use case exists.
