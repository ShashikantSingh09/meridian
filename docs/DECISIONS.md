# Architectural decisions

Each entry records what was decided, why, and what was given up. Newest last. Evidence lives in `docs/research/`.

## D1. Tauri 2 with React and a Rust core

**Why.** Coucou proves the exact product shape works on Tauri on Windows. Rust gives direct Win32 and WinRT access and a
safe place for keys and process control. The binary is 7.8 MB, against TwoCode's 234 MB executable.
**Gave up.** Memory is not an advantage: WebView2 is Chromium-class, and measured 166 to 268 MB.
**Rejected.** Electron (no gain over WebView2 and a far larger download), WinUI 3 and WPF (weaker motion tooling and no
path to macOS or Linux), and a Direct2D island like EchoIsland (no web motion stack, kept as a contingency).

## D2. One fixed transparent window that never resizes

The window is 860 by 660 at the top of the display, and the island is drawn inside it. Resizing a native window every
frame is the classic source of flicker and tearing, and a fixed window removes the whole class of problem. Only the
island's shape takes the mouse.
**Gave up.** Some GPU memory for a mostly empty surface. A smaller window while compact could recover it.

## D3. Real desktop blur through a composition visual

A `Windows.UI.Composition` sprite with a host backdrop brush sits below the webview, clipped to the island's rounded
rectangle, and follows it frame by frame. CSS `backdrop-filter` cannot reach the desktop, and DWM acrylic fills the
whole window rectangle. No studied product has real blur in a shaped island. Verified: see `TECHNICAL_FINDINGS.md`,
section 9. On any failure the UI falls back to a dense tint.
**Gave up.** One message per frame to Rust during morphs. Windows 11 only.

## D4. The line of light is the product's character

One luminous line expresses every state, instead of a mascot. It is original, it scales down to a 128 px pill, and it
stays calm in a professional setting. Coucou's Mochi and TwoCode's Robo are mascots, and Coucou's character is reserved
by its licence regardless.

## D5. Hand-written CSS on design tokens, not Tailwind

The UI is a small set of bespoke surfaces, and utility classes would add a build dependency without saving code. Tokens
are CSS variables in `packages/design-system`. Fonts are Segoe UI Variable and Cascadia, already on Windows 11, so none
ship with the app.

## D6. Motion springs drive one element's size

Width, height and radius are motion values on a single element, so an interrupted transition keeps its velocity. Growth
has slight overshoot and shrinking has none. Content cross-fades at the target size, so text never reflows mid-morph.

## D7. Rust owns keys, network and processes

No key ever enters the webview. Commands can set a key, clear it, or report that one exists. Provider and agent logic
lives in crates with no Tauri dependency, so it tests without a window.

## D8. Two wire protocols plus a catalog

Almost every provider speaks OpenAI-style chat, including Google's documented compatibility endpoint. So a provider is a
catalog row, and only Anthropic has its own adapter. Each row declares real capabilities, and the UI shows only those.
**Gave up.** Provider-specific features. The `Provider` trait leaves room for a native adapter when one earns its place.

## D9. Managed sessions, with no writes to any agent's config

Sessions the app starts use each agent's documented protocol:

- **Claude Code:** print mode with stream-json both ways. The prompt goes over stdin, so it never appears on a command
  line. Approvals use an `http` `PermissionRequest` hook injected for that run through `--settings`, pointing at a
  loopback server with a random per-session token.
- **Codex:** `codex app-server` JSON-RPC. Upstream marks it experimental, so unknown messages are ignored and unknown
  server requests get an error reply so a turn can never hang.

This gives island approvals without touching `~/.claude/settings.json`, and without a helper binary like Coucou's.
**Gave up.** Sessions started in the user's own terminal are not visible. That needs opt-in global hooks, planned later.
**Not used.** `--bare`, because it ignores subscription sign-in.

## D10. One writer for the window's extended style

Tauri's `set_ignore_cursor_events` rebuilds the whole style and silently drops `WS_EX_NOACTIVATE` and
`WS_EX_TOOLWINDOW`. Found by reading the flags from outside the process, not from any visible symptom. `island.rs` now
owns all of these bits in `apply_style`.

## D11. A cursor poll, not a mouse hook

Click-through needs to know where the cursor is. A low-level mouse hook would add latency to all mouse input on the
machine, and would look like the keylogging this product promises not to do. The poll runs at 20 Hz, rising to 60 Hz
within 80 px of the shape, and costs about 0.16% of a core.

## D12. The idle line breathes for about 25 seconds, then rests

An endless fade measured 13% of a core on a 180 Hz display. A stepped fade measured 2.5 to 4%, and so did a once-a-second
timer: any repaint of this window is the cost, not the animation clock. With nothing moving the app measures about 0.4%.
So the line breathes when the island comes to rest, which is when someone may be looking, and then stops.

## D13. The webview may use the microphone and nothing else

A `PermissionRequested` handler allows the microphone, which the app opens only on a click, and denies every other kind.
Without it, a request raises WebView2's own modal dialog, which blocked the page in testing.

## D14. Hide over fullscreen

`SHQueryUserNotificationState` is checked about every 2 s, and the island hides over games, video and presentations.
This is the first and cheapest form of knowing when not to interrupt.

## D15. Anthropic API version 2026-10-21, no fallbacks

Raw HTTP, as there is no official Rust SDK. This version rejects sampling parameters, and none are sent. `max_tokens` is
64,000 for streaming. A `refusal` stop reason becomes a visible error. Server-side `fallbacks` are not sent, because the
model is whatever the user picked and the parameter is model-specific.

## D16. Sessions in memory for M1

Settings persist as JSON through an atomic write, and a corrupt file is set aside. Conversation and session history wait
for SQLite in the persistence milestone. Finished sessions can be resumed while the app is running.

## D17. Repository layout

`apps/desktop`, `crates/ai-core`, `crates/agent-adapters` and `packages/design-system`. The suggested structure had a
package for each subsystem. Empty packages are not modularity, so voice, context and workflow get their crate when they
get their code. Provider and agent logic went to Rust crates rather than `packages/`, because keys must stay out of the
webview.

## D18. Working name: Meridian

A meridian is a line across the top of the sky, which suits a line of light at the top of the screen. It has not been
trademark-cleared. Choosing the final name means changing the bundle identifier, which is the Credential Manager
service name too, so do that before any public release.

## D19. Claude Code as a chat engine, through the user's own CLI

Chat drives the installed `claude` CLI in print mode with stream-json, under whatever sign-in that CLI already has. The app
never logs in itself, never reads a credential, and never handles a token. `claude auth status --json` reports sign-in, and
`claude auth login` opens Anthropic's own flow in its own window. The account's email and organization are dropped before
anything reaches the interface. Verified live: chat with no Anthropic API key, on a Max plan.

**Licensing, read this before distributing.** From Anthropic's documentation, retrieved 2026-10-30:

> OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription
> plans and is designed to support ordinary use of Claude Code and other native Anthropic applications.

> Developers building products or services that interact with Claude's capabilities, including those using the Agent SDK,
> should use API key authentication through Claude Console or a supported cloud provider. Anthropic does not permit
> third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or
> Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai
> credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow.

> Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for
> their products, including agents built on the Claude Agent SDK.

What this means here: one person running the app on their own machine, against their own installed CLI and their own plan,
fits the design above, but this note is an engineering reading and not legal advice. Shipping this app to other people so
their usage runs on their plans is a different case, and needs Anthropic's approval or an API-key path first. The design
keeps that door open, because the app holds no Claude credential of any kind.

The Agent SDK was not used: it needs a JavaScript or Python runtime in the app, and its documentation directs developers to
API keys. The CLI's documented print mode gives the same streaming and session control.

## D20. Keep the agent's process between turns

Print mode accepts further messages on stdin after a result. A follow-up on the live process took 1.5 s, against 6.7 s from
cold, so a session keeps its process for 3 minutes and then falls back to `--resume`, which the user notices only as a slower
reply. Each idle process holds about 300 MB, which is why the window is short. An
interrupt uses the stream-json `control_request`, which keeps the conversation alive, and falls back to ending the process
tree after 4 s. This control message is what the Agent SDK uses and is not separately documented for direct use, so it
carries more risk of changing than the rest of the protocol. The fallback covers that.

## D21. General mode is restricted, not just relocated

A dedicated empty folder is not enough: `--tools` alone still exposed the user's MCP connectors in testing, which include
real accounts. General mode passes `--tools WebSearch,WebFetch,Read` and `--strict-mcp-config`. Project mode has the full
tool set, and asks before acting through the approval hook.

## D22. Screen capture by BitBlt, not Windows.Graphics.Capture

`BitBlt` reads what is shown, is a few lines, and needs no Direct3D device. Graphics Capture would add a system capture
border, which is a real privacy benefit, and handles occluded windows, which is not needed here because the app reads only
what the user can see. It can replace this later behind the same functions. The island is kept out of its own captures with
`WDA_EXCLUDEFROMCAPTURE`, held only for the moment of capture so the user's own screenshot tools still see it. Verified by
painting the island magenta and sampling the capture.

## D23. Screen content leaves the machine at exactly one point

`crates/screen` has no network code. Capture and OCR are local. `shareCapture` in the store is the only path out, and it
runs only on a click on a preview that names the engine and says what will be sent. Contextual mode raises local suggestions
with the matched line; acting on one opens that same preview rather than sending anything. Frames are dropped immediately in
contextual mode, and a discarded capture is dropped from the core too.

## D24. Signals are observed, never inferred

`screen::detect` matches text that is on screen: an IAM denial, a build failure, a traceback. It says "seen 3 times", and
never "you seem stuck". Word lists require context, so a novel called Terror does not trigger anything. OCR reads `main.tf`
as `main. tf`, so matching closes that gap without changing what the user sees.

## D25. Media through the system transport controls

Every player that publishes to Windows' media controls works with no per-service code, and each control is enabled only if
that player says it is. Per-app volume is not implemented. One thread sleeps until the system reports a change, and playback
position runs on locally only while the hover card is open, so a compact track costs no repaints.

## D26. No third-party logos

The island shows Claude Code and Codex by name, with original iconography. Product logos are their owners' marks, and
Meridian is not affiliated with them.
