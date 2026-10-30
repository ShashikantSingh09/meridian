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
