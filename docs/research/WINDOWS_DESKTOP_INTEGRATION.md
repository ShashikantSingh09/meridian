# Windows Desktop Integration

Date: 2026-10-30. Items marked **Doc** were read from Microsoft documentation in this research pass. Items
marked **Source** were read in a reference project. Items marked **Prior** come from general Win32 knowledge
and were not re-read in this pass, so they should be confirmed during implementation.

## Framework decision

The table rates each option on the criteria from section 13 of the master prompt. Ratings are judgements
that draw on the evidence below, and memory is deliberately not scored as a Tauri win.

| Criterion | Tauri 2 | Electron | WinUI 3 | WPF |
|---|---|---|---|---|
| Native integration | Strong, direct Rust access to Win32 and WinRT | Medium, needs native modules | Strong | Strong |
| Per-pixel transparent overlay | Proven (Coucou, Glint) | Proven as a category | Weak, see below | Possible, cost unverified |
| Real rounded blur | Needs native visual, spike open | Likely same limit, unverified | Unverified | Unverified |
| Always-on-top, no focus | Proven (Coucou) | Available (Prior) | Possible through Win32 | Possible through Win32 |
| Multi-window | Good | Good | Good | Good |
| Background lifecycle and tray | Good, tray in `tauri` | Good | Manual | Manual |
| Global shortcuts | Plugin, `RegisterHotKey` based | Built in (Prior) | Manual | Manual |
| Process management | Excellent, `tokio::process` | Good, Node | Good, .NET | Good, .NET |
| Animation iteration speed | Excellent, web tools | Excellent, web tools | Medium, Composition APIs | Medium |
| Memory on Windows | Chromium-class | Chromium-class | Likely lower, unmeasured | Likely lower, unmeasured |
| Distribution size | Small, relies on system WebView2 | Large, TwoCode exe is 234 MB | Medium, runtime dependency | Medium, runtime dependency |
| Auto update | Official plugin | Mature | Manual or MSIX | Manual |
| Security model | Capabilities, CSP, Rust core | Careful configuration needed | Native trust | Native trust |
| Path to macOS and Linux | Yes, Coucou ships Linux | Yes | No | No |
| Maintainability for this team | High, web plus Rust | High | Medium | Medium |

**Decision recommendation: Tauri 2.** The deciding factors are that Coucou proves this exact product shape on
Windows, that credentials and process control live in a memory-safe core, that the shipped size is small, and
that a path to other platforms remains. Memory is not a deciding factor, as explained below.

WinUI 3 and WPF were rejected mainly on transparency and portability. A Windows App SDK community reference
says the WinUI XAML compositor does not compose cleanly with classic `WS_EX_LAYERED` rendering, and it lists
a true transparent XAML window as something not offered as a first-class API
(https://microsoft.github.io/microsoft-ui-reactor/windowing-advanced/). A community project also reports that
its transparent window technique stopped working after Windows App SDK 1.1
(https://github.com/IcySnex/WinUI3-Transparent-Mica-Acrylic-Blurred). WPF's `AllowsTransparency` cost could
not be verified from a current source. Listings report that Agent Island uses WPF, which suggests it is
workable, but WPF offers no path to macOS or Linux.

A fifth option exists, drawn from EchoIsland: a Tauri host with a Direct2D island in a layered window. It is
treated as a contingency in `ARCHITECTURE_RECOMMENDATIONS.md`.

### Memory expectation

No trustworthy Windows benchmark for a small WebView2 island was found. Community measurements in
https://github.com/tauri-apps/tauri/issues/5889 put Tauri at or above Electron on Windows for heavy pages (370
MB against 312 MB, and 399 MB against 318 MB), and the commenter's explanation is that both are Chromium. The
widely quoted savings are macOS results or have no method. Meridian should therefore measure its own private
working set across the whole WebView2 process tree, and should not repeat those figures.

## Window composition

### Transparency

**Doc:** WebView2 `DefaultBackgroundColor` accepts only alpha 0 or 255. With alpha 0, WebView2 "will render
hosting app content as the background". A semi-transparent value fails with `E_INVALIDARG`. A known issue can
leave a white flicker before the colour applies, and setting the `WEBVIEW2_DEFAULT_BACKGROUND_COLOR` environment
variable avoids it
(https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2controller2).

### DWM attributes

**Doc:** from https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute:

| Attribute | Purpose | Minimum build |
|---|---|---|
| `DWMWA_USE_HOSTBACKDROPBRUSH` | Lets a non-UWP window use host backdrop brushes from `Windows.UI.Composition` | Windows 11 22000 |
| `DWMWA_SYSTEMBACKDROP_TYPE` | Sets a system-drawn backdrop material, including behind the non-client area | Windows 11 22621 |
| `DWMWA_WINDOW_CORNER_PREFERENCE` | Sets the rounded corner preference | Windows 11 22000 |
| `DWMWA_BORDER_COLOR` | Sets or suppresses the window border | Windows 11 22000 |
| `DWMWA_REDIRECTIONBITMAP_ALPHA` | Uses the alpha channel of the redirection bitmap | Windows 11 26100 |

The consequence is that any host backdrop path is **Windows 11 only**. On Windows 10, Meridian must use the
CSS material.

### Composition from a Win32 window

**Doc:** `Compositor.CreateHostBackdropBrush` creates a brush that samples the area behind the visual, before
the window is drawn. The brush is translucent by default and hit-tests as opaque, and its pixels cannot be read
back (https://learn.microsoft.com/en-us/uwp/api/windows.ui.composition.compositor.createhostbackdropbrush). Win32
access to a `Compositor` target goes through `ICompositorDesktopInterop.CreateDesktopWindowTarget`, and that
requires a `DispatcherQueue` on the calling thread (community source plus
https://learn.microsoft.com/en-us/windows/windows-app-sdk/api/winrt/microsoft.ui.composition.systembackdrops.desktopacryliccontroller.settarget).

Interaction with WebView2 is unverified, and it is the subject of the open spike in `TECHNICAL_FINDINGS.md`.
The Zed editor's GPUI commit enabling per-pixel GPU composited transparency on Windows is a useful external
reference for layered, composited windows
(https://git.secluded.site/zed/commit/94b75f3ad95eadc29b76218696fbd054642ace45).

### `window-vibrancy`

The crate offers acrylic, Mica and blur for Tauri windows (https://github.com/tauri-apps/window-vibrancy). It
applies to the whole window, so it does not suit the island, as Glint found. It remains a reasonable choice for
a separate rectangular settings window, where the shape limit does not matter.

## Extended window styles

| Style | Role here | Evidence |
|---|---|---|
| `WS_EX_NOACTIVATE` | Clicks do not take focus from the user's app | Source, Coucou and EchoIsland |
| `WS_EX_TOOLWINDOW` | Hides the island from Alt-Tab | Source, Coucou |
| `WS_EX_TRANSPARENT` | Passes mouse input through | Doc, with layered-window note below |
| `WS_EX_LAYERED` | Per-pixel alpha through `UpdateLayeredWindow` | Source, EchoIsland |
| `WS_EX_TOPMOST` | Always on top | Source, EchoIsland |

**Doc:** hit testing of a layered window is based on its shape and transparency, so alpha-zero areas let mouse
messages through. With `WS_EX_TRANSPARENT`, the shape is ignored and mouse events pass to windows underneath
(https://learn.microsoft.com/en-us/windows/win32/winmsg/window-features).

**Source:** click-through hides a window from `WindowFromPoint`, so OLE drag and drop finds no target. Coucou
works around this while the left button is held (`windows/src-tauri/src/island.rs`).

## Input

### Global shortcuts

**Source:** Coucou uses `tauri-plugin-global-shortcut`, and a comment notes that `RegisterHotKey` works in every
Windows session. Coucou also found a real trap: Windows reads Ctrl+Alt as AltGr, so a Ctrl+Alt shortcut can stop
a user typing a character on their layout. Its `ctrl_alt_types` check uses `ToUnicodeEx` across installed layouts
(`windows/src-tauri/src/platform/windows.rs`). Meridian's default shortcut should avoid Ctrl+Alt combinations.

**Prior:** `RegisterHotKey` fails if another application holds the combination, so the settings UI must surface
that failure instead of silently doing nothing.

### Keyboard and mouse hooks

Low-level global hooks (`WH_KEYBOARD_LL`, `WH_MOUSE_LL`) must not be used. They add latency to all input, and a
keyboard hook is indistinguishable from a keylogger, which the product forbids. Coucou's dictation key does use a
keyboard hook, according to a comment in `Cargo.toml`, and Meridian should find a different design for
push-to-talk, using a registered shortcut as the first choice.

## Desktop awareness (M3)

### Foreground changes

**Doc:** `SetWinEventHook` with `EVENT_SYSTEM_FOREGROUND` and `WINEVENT_OUTOFCONTEXT` delivers events asynchronously
but in sequence, on the thread that called it, and that thread must have a message loop. A hook function can be
re-entered, so it should only enqueue work. `WINEVENT_SKIPOWNPROCESS` excludes our own events
(https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwineventhook). This gives foreground
changes with no polling, which suits the idle CPU goal.

### Window and process metadata

**Source:** `GetWindowThreadProcessId`, `GetWindowTextW` and `CreateToolhelp32Snapshot` provide owner process,
title and process tree (`platform/windows.rs`). Window titles can contain sensitive text, such as document names
and email subjects, so they must pass through exclusion rules before being stored or sent anywhere.

### UI Automation

**Prior:** UI Automation can read control text from other applications, which makes it powerful and sensitive. It
is out of scope for the first context milestone, and any later use must be per-application and opt-in. Application
metadata comes first, as the master prompt requires.

## Screen capture (M3, optional)

**Doc:** `GraphicsCaptureSession.IsBorderRequired` controls the coloured capture border. Removing it needs user
consent through `GraphicsCaptureAccess.RequestAccessAsync` with `Borderless`, and a `graphicsCaptureWithoutBorder`
capability in the package manifest. If the user denies access, the setting is ignored and the border still shows
(https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession.isborderrequired).

Meridian should **keep the border on**. It is a free, system-drawn indicator that a capture is happening, and it
directly serves the requirement for clear screen-access indicators. Capture should be on demand, and limited to a
window or display the user selects. **Prior:** `GraphicsCapturePicker` provides that user selection.

## Credentials

**Doc:** `CredentialBlobSize` cannot exceed `CRED_MAX_CREDENTIAL_BLOB_SIZE`, 5*512 bytes (2,560). Generic credential
target names may be up to 32,767 characters, and `CRED_PERSIST_LOCAL_MACHINE` keeps a credential on this machine
across logon sessions (https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentiala).

**Source:** Coucou's `secrets.rs` uses `keyring` with an allowlist of key names, and its IPC exposes only a
presence check, so that the webview can never read a key back.

## Audio (M4)

**Source:** Coucou uses `cpal` for the microphone and for WASAPI loopback capture of system audio, with on-device
speech recognition through `sherpa-onnx` and Parakeet models downloaded on user request (`windows/src-tauri/Cargo.toml`,
`windows/README.md`). This confirms that a local speech path is practical in Rust on Windows. Microphone activity must
always be visible in the island. **Prior:** Windows also shows its own microphone-in-use indicator, and that does not
replace the app's own.

## Packaging and lifecycle

**Source:** Coucou builds NSIS and MSI through Tauri, installs per user, and uses `tauri-plugin-single-instance` and
`tauri-plugin-autostart`. It bundles its relay executable as a resource (`tauri.conf.json`). Its Windows installer is
unsigned, and it checks a published SHA-256 for updates (`windows/README.md`).

Meridian should plan for code signing in M6, since an unsigned always-on-top app that spawns processes will be treated
with suspicion by both SmartScreen and careful users.

**Local environment note:** on the development machine, Rust's MSVC toolchain requires Visual Studio Build Tools and a
Windows SDK, and installing them needs administrator approval. WebView2 runtime 156.0.4314.50 is already present.
