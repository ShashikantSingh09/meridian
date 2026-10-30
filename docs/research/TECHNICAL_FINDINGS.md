# Technical Findings

Date: 2026-10-30. Evidence labels match `REFERENCE_ANALYSIS.md`: VERIFIED, CLAIMED, INFERENCE, UNKNOWN.
Environment used for local checks: Windows 11 Pro 10.0.26300, Claude Code 2.1.314, codex-cli 0.142.4.

## 1. How each project draws its island on Windows

| Project | Surface | Translucency | Click-through |
|---|---|---|---|
| Coucou | WebView2 in a transparent Tauri window | None, opaque black shape | Cursor poll toggles ignore-cursor flag |
| Glint | WebView2 in a transparent Tauri window | CSS only, `rgba(18,18,24,.82)` fill | Pill fills its window |
| EchoIsland | Direct2D and DirectWrite in a layered window | Alpha blended, no blur or backdrop API in its source | Per-pixel layered hit testing |
| TwoCode | Chromium runtime (Electron layout) | UNKNOWN | UNKNOWN |
| Agent Island | WPF (CLAIMED by listings) | UNKNOWN | UNKNOWN |

**No studied project achieves real desktop blur behind a rounded island.**

Glint is explicit about why. A comment in `apps/overlay/src-tauri/src/lib.rs` says native acrylic must
not be applied to the main window, because acrylic fills the whole window rectangle, including the
transparent corners outside the pill, which produces a visible grey rectangle. Its README still
describes a "Win11 acrylic surface", and `Cargo.toml` still declares `window-vibrancy`, but no source
file calls that crate, so the code is authoritative and the surface is CSS only. Glint's stylesheet
also records a useful detail: `box-shadow` leaks slightly square at
the corners of transparent windows, so it uses `filter: drop-shadow` for the outer shadow.

EchoIsland is the most surprising result. Although it is a Tauri app, its default Windows island is not
a webview at all. `apps/desktop/src-tauri/src/windows_native_panel/` creates a window with
`WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED | WS_EX_TOPMOST`, paints with Direct2D and
DirectWrite, and presents through `UpdateLayeredWindow`. Its README lists "Native Direct2D/DirectWrite
island enabled by default".

## 2. Click-through approaches

There are two workable approaches, and they suit different surfaces.

**Cursor polling.** Coucou toggles `set_ignore_cursor_events` from a 16 ms thread (`island.rs`). It works
with any surface, including WebView2, but it spends wakeups whenever the island is visible, and it hides
the window from OLE drag and drop, which forces a workaround while the mouse button is held.

**Native alpha hit testing.** Microsoft documents that hit testing of a layered window "is based on the
shape and transparency of the window", so areas whose alpha is zero let mouse messages through
(https://learn.microsoft.com/en-us/windows/win32/winmsg/window-features). EchoIsland relies on this,
together with `WM_NCHITTEST`, and needs no polling. A comment in its `platform_loop.rs` says toggling
`WS_EX_TRANSPARENT` would make the whole panel ignore input. A test name in `paint_backend.rs` shows the
cost: nearly transparent "hit test blocker" pixels must be painted into gaps that should still catch
the mouse.

**INFERENCE:** the native approach requires content drawn into the layered window, so it does not apply
to a child WebView2 surface. A WebView2 island therefore needs polling or an equivalent. Meridian should
poll adaptively, at a slow rate while the cursor is far from the island and at 60 Hz when it is near.

## 3. Avoiding focus theft

EchoIsland's `technical-notes/window-surface-behavior.en.md` records that automatic card pop-ups once
interrupted typing, and that the cause was a topmost refresh path that also activated the window, not
the animation. Its fix is a named split between `passive` updates, which must never take focus, and
`interactive` updates, which may. This is a good rule to carry over: every window operation should be
declared as passive or interactive, and `set_always_on_top` deserves particular suspicion.

Coucou's equivalent is `make_non_activating` and `set_activating` in `platform/windows.rs`.

## 4. Motion implementation

VERIFIED from `windows/src/core/anim.ts` and `windows/src/island/island.ts` in Coucou:

- Springs follow the SwiftUI model, with natural frequency derived from a response time and a damping
  fraction. Defaults are 0.5 s response and 0.72 damping.
- Integration is sub-stepped at 240 Hz, which keeps it stable after a long frame.
- Shrinking uses a 340 ms curve, `cubic-bezier(.45, 0, .2, 1)`, instead of a spring.
- The animation frame loop stops once width, height and radius settle.

**INFERENCE for Meridian:** the frame loop should also stop in idle. Slow ambient effects should use
compositor-only CSS properties such as `opacity` and `transform`, because these need no JavaScript frame
loop. A spring written in plain TypeScript is about 40 lines, and island geometry needs direct per-frame
access in order to update the hit-test rectangle and any native backdrop. Motion is a good fit for
content transitions inside the island, and it does not need to own the island shape.

## 5. Agent connectivity

Four mechanisms exist. They are complementary, and each project combines them differently.

| Mechanism | Used by | Strength | Weakness |
|---|---|---|---|
| Hook relay | Coucou, Glint, EchoIsland | Sees sessions the user started anywhere | Requires editing global agent config |
| Transcript scanning | EchoIsland, Agent Island (CLAIMED) | No config edits, works as a fallback | Read-only, parses semi-internal files |
| Headless spawn | Coucou's `claude_code.rs` | Simple, one-shot answers | No live session management |
| Managed protocol session | No studied project | Structured events, control, cancellation | Only covers sessions the app started |

Relay transports also differ. Coucou uses a per-user named pipe whose name contains the account SID, and
`pipe.rs` refuses to join a pipe owned by someone else. Glint POSTs to `127.0.0.1:47611` with a 200 ms
fire-and-forget timeout. EchoIsland uses local TCP on `127.0.0.1:37891` with token authentication. The
named pipe is the strongest choice, since no other local account can reach it.

### Claude Code (VERIFIED, https://code.claude.com/docs/en/headless and `claude --help`, v2.1.314)

- `claude -p` with `--output-format stream-json --verbose --include-partial-messages` streams one JSON
  object per line. The last line is a `result` message with the final text, cost and session metadata.
  `--input-format stream-json` and `--session-id <uuid>` are available, and `--resume` continues a
  session by ID.
- The first event is normally `system/init`, which reports the model, tools, MCP servers and plugins, and
  it carries a `capabilities` array for feature detection. `system/api_retry` reports retries.
- **Permissions:** since v2.1.302, a `-p` run starts in Manual mode, and a call that needs approval is
  **denied** unless something approves it, such as a `PermissionRequest` hook or `--permission-prompt-tool`.
  Managed sessions therefore need an approval path, or they will silently be unable to act.
- **Authentication:** `--bare` never reads OAuth credentials or the keychain, so it cannot use a
  subscription login. Meridian must not pass `--bare` for users who rely on their subscription.
- **Trust:** without `--bare`, a `-p` session runs a project's hooks and connects its `.mcp.json` servers
  even in a folder that was never trusted, with no trust dialog. Starting a managed session in a project
  folder must be treated as a trust decision by the user.
- **Stopping:** SIGTERM exits with code 143 and records no result for the turn. SIGINT ends the turn
  properly. Stopping behaviour on Windows, which has no SIGINT for detached processes, needs testing.
- **Hooks:** `PermissionRequest` output carries `hookSpecificOutput.decision.behavior`, either `allow` or
  `deny`. Exit code 2 is not honoured for that event. On Windows, shell-form hooks default to Git Bash.
- **UNKNOWN:** whether `--settings <json>` can inject hooks for one run. The excerpt read only shows it
  disabling hooks. This would avoid touching the user's global settings, so it needs a direct test.

### Codex (VERIFIED, https://learn.chatgpt.com/docs/app-server.md and a locally generated schema)

- `codex app-server` speaks JSON-RPC over newline-delimited JSON on stdio, without the `jsonrpc` header.
  The CLI help marks it `[experimental]`. The schema is generated per installed version with
  `codex app-server generate-json-schema`, which produced 267 files locally for 0.142.4.
- The handshake is `initialize` and then the `initialized` notification. After that come `thread/start`,
  `turn/start`, `turn/interrupt`, `thread/resume` and `model/list`.
- Notifications include `turn/started`, `turn/completed`, `item/started`, `item/completed` (authoritative
  for final item state), `item/agentMessage/delta`, `item/commandExecution/outputDelta`,
  `thread/tokenUsage/updated`, `turn/diff/updated`, `error` and `warning`.
- Approvals are server-initiated requests: `item/commandExecution/requestApproval` and
  `item/fileChange/requestApproval`. Decisions include `accept`, `acceptForSession`, `decline` and `cancel`.
- A third-party crate labels `codex exec --json` as legacy (secondary source, https://docs.rs/crate/codex-codes).
- **Hook support differs between sources.** Coucou writes `.codex\hooks.json`, Glint writes
  `~/.codex/config.toml`, and EchoIsland reports that Windows live hooks "remain limited by upstream Codex
  runtime behavior". **INFERENCE:** the app-server is a sturdier integration path than hooks on Windows.

## 6. AI provider findings

Coucou's split by wire format is the right idea (`windows/src-tauri/src/chat.rs`). Most providers share
the OpenAI chat completions format, and that includes Gemini's compatible endpoint, as `openai_compat.rs`
shows. A single OpenAI-compatible client plus a native Anthropic client covers most of the requested
provider list, and it avoids one adapter per vendor. `local_chat.rs` streams tokens and hides `<think>`
blocks from reasoning models, a detail Meridian should also handle. `providers.ts` classifies a server
address as local, remote over HTTPS, remote in clear text, or invalid, which is a simple and useful
privacy signal to show in the interface.

## 7. Credentials

`keyring` with the `windows-native` feature stores secrets in Windows Credential Manager
(`windows/src-tauri/src/secrets.rs`). `CredentialBlobSize` is capped at `CRED_MAX_CREDENTIAL_BLOB_SIZE`,
which is 5*512 = 2,560 bytes
(https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentiala). That is enough for
API keys, and it is too small for a long token bundle, so such values would need chunking.

## 8. Memory evidence

Real data favours caution. A community comparison in https://github.com/tauri-apps/tauri/issues/5889
found, on Windows 10, Tauri at 370 MB and Electron at 312 MB for vscode.dev, and 399 MB against 318 MB for
postman.com. Those are heavy pages and not a controlled benchmark, but both runtimes are Chromium on
Windows, so a large memory saving should not be assumed. The large savings commonly quoted come from
WKWebView on macOS, or from sources that give no method (https://dev.to/gethopp/tauri-vs-electron-performance-bundle-size-and-the-real-trade-offs-1el4).

EchoIsland CLAIMS under 50 MB, and its README supports this only with a general statement about Tauri
using the system webview. That figure was not tested, and its default Windows island avoids WebView2
anyway. A WebView2 island should not be expected to reach it.

Tauri's concrete advantage on Windows is distribution size and a Rust core. TwoCode's executable alone
is 234 MB, while a Tauri app relies on the WebView2 runtime that Windows 11 already provides.

## 9. Glass material: spike result

**Status: CLOSED. The host backdrop visual works and ships.** Tested on Windows 11 build 26300 with an RTX 3070 Ti
at 100% scale, in the release build. Implementation: `apps/desktop/src-tauri/src/glass.rs`.

| Question | Result |
|---|---|
| Does the visual render behind a transparent WebView2 child in a Tauri window? | Yes, through `CreateDesktopWindowTarget` with `isTopmost = false`. |
| Is the host backdrop already blurred? | Yes. No effect graph is needed. Text behind the panel is unreadable. |
| Is the rounded clip antialiased? | Yes, by inspection of screenshots, using `CompositionRoundedRectangleGeometry` in a geometric clip. |
| Can it track the island during a spring? | No lag was visible in frames grabbed during open and close. Lag was not measured numerically. |
| Inactive window? | Works. The island is never the active window in its compact states. |
| Transparency effects off, battery saver? | **Not tested.** |
| Idle cost? | 0% GPU when nothing on the island changes. Any repaint of this window is the expensive part. |

A tint of 0.5 alpha, which looked right over a dark editor, turned mid-grey and illegible over white applications.
The tint is now 0.78, which is the single most important number in the material.

The original problem statement is kept below.

The problem has three parts:

1. **CSS `backdrop-filter` cannot reach the desktop from a transparent WebView2.** This is an inference,
   supported by Microsoft's documentation: when `DefaultBackgroundColor` is transparent, "WebView will
   render hosting app content as the background", and only alpha values of 0 and 255 are accepted
   (https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2controller2).
   The filter works on what the page's own compositor drew, and the desktop is not part of that.
2. **`window-vibrancy` applies to the whole window rectangle.** Glint's comment, quoted above, records the
   grey rectangle this produces around a pill. The crate's README also flags poor performance during
   resize and drag on several Windows builds (https://github.com/tauri-apps/window-vibrancy).
3. **System backdrops have the same shape limit.** `DWMWA_SYSTEMBACKDROP_TYPE` sets a backdrop material for
   a window, including behind the non-client area, and needs build 22621.

**Candidate:** a `Windows.UI.Composition` sprite visual using `Compositor.CreateHostBackdropBrush()`,
placed behind the webview through a `DesktopWindowTarget`, and clipped to the island's rounded rectangle.
For a Win32 window this needs `DWMWA_USE_HOSTBACKDROPBRUSH`, supported from Windows 11 build 22000
(https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute).

The spike must answer these questions:

- Does the visual render behind a transparent WebView2 child in a Tauri window?
- Is the host backdrop already blurred, or does it need an effect graph?
- Is the rounded clip antialiased?
- Can the visual track island geometry without a visible edge lag during spring animation?
- What happens when the window is inactive, with transparency effects off, and on battery saver?
- What is the idle CPU and GPU cost compared with the CSS fallback?

A Microsoft Q&A thread reports a Win32 composition blur attempt that made the window disappear and the
process exit, so failure is a real possibility
(https://learn.microsoft.com/en-us/answers/questions/1283036/how-to-use-the-compositing-effect-of-winrt-visual).

**Fallback, regardless of the result:** a CSS material with a translucent dark tint, a specular rim, and
ambient gradient light. This fallback is required anyway, because host backdrop brushes do not exist
before Windows 11, and it must stay legible without any blur behind it.

## 10. Open verification items

- RESOLVED: `--settings` can inject an `http` `PermissionRequest` hook for one managed Claude Code run. Verified
  live with both allow and deny on Claude Code 2.1.314, and `~/.claude/settings.json` is never written.
- Graceful turn interruption for `claude -p` on Windows. M1 ends the process tree with `taskkill /T /F`, so the
  turn in progress is not recorded. Also observed: print mode does not exit after its result, even with stdin closed.
- Real WebView2 working set for a minimal island, measured across the whole process tree.
- Idle cost of an adaptive cursor poll.
- Whether WebView2's white flash before first paint needs `WEBVIEW2_DEFAULT_BACKGROUND_COLOR`, which
  Microsoft documents as a fix for that flicker.
