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

Replaced in part by D40: sound now decides whether something is playing. Every player that publishes to Windows' media controls works with no per-service code, and each control is enabled only if
that player says it is. Per-app volume is not implemented. One thread sleeps until the system reports a change, and playback
position runs on locally only while the hover card is open, so a compact track costs no repaints.

## D26. No third-party logos

Replaced by D39 on the owner's request. The island itself still uses an original spark for Claude Code, as D34 describes.

## D27. The island is a black notch, and the glass is gone

The island hangs flush from the top edge of the display, with a flat top, round bottom corners and two small inward curves
where it meets the edge. It is opaque black in every state. This follows what TwoCode does, and macOS notch apps before it.
See `docs/research/TWOCODE_TEARDOWN.md`.

This replaces D-series glass work. The composition backdrop in `glass.rs` was removed, along with the light theme, which only
existed to tint that glass. Reasons: a backdrop drawn by a separate visual fell behind the webview during a morph and showed
as a halo at the edges; a rounded-rectangle clip cannot follow a notch; and black needs no per-frame geometry pushed to native
code. This is a deliberate removal of working functionality, at the user's request for a macOS-like island. The theme setting
is gone from Settings and from the settings file, which ignores the old key on load.

The curves are two small radial gradients beside the shape, not a `clip-path`, so nothing is re-rastered per frame.

## D28. The click-through flag is the only style that changes

`WS_EX_LAYERED` now stays set, and only `WS_EX_TRANSPARENT` toggles. Taking layering off and on resets the window's surface,
which is a flicker risk each time the pointer crosses the island, and Electron's own implementation also keeps it for
transparent windows.

## D29. Follow the sessions people already run

Customers already run Claude Code in their terminals. With one opt-in toggle, Meridian adds hooks to their Claude Code
settings file, and follows every session from a loopback server. Permission requests can be answered on the island, and the
terminal's own dialog stays live, so whichever answers first wins.

This is now the main route for customers. It makes no model request and touches no Claude credential, so it does not depend
on the D19 question. Chat through Claude Code remains, for the person's own use, under D19's limits.

The toggle changes a file the user owns, so it is explained where it is offered, keeps one backup, and turning it off removes
exactly our entries. Sessions from the watcher can be followed and answered, not steered, because the app holds no process
for them.

## D30. Providers are read through MCP, with read-only tools only

Vendors now publish remote MCP servers, and most accept dynamic client registration, so a customer can connect them with no
setup and no client ID from us. Anonymous discovery on 2026-10-30 confirmed 16 such services. Discovery needs no account, and
results are recorded in the catalog.

`crates/mcp` is a small client: Streamable HTTP, the full authorization discovery chain, PKCE S256 required, RFC 8707 resource
indicators, and registration. stdio and arbitrary server URLs were left out: nothing here needs them yet.

- Only tools that are read-only by annotation or by a catalogued name are ever called, and a name containing a write verb is
  refused whatever its annotation says. Annotations are hints from an untrusted server.
- Catalog scopes ask for read access where a vendor offers it. Without such a list, scopes that sound like writing or
  administration are dropped. Where a vendor has one catch-all scope, the token can do more than this app will ever ask of it.
  The tool rule is what holds in that case, so the interface says the app calls read-only tools, not that the sign-in is
  read-only.
- Results are untrusted. They are rendered as text, stay in memory, and are never sent to a model.
- Gmail, Calendar and Outlook stay on the direct connectors, which feed My day. Google's MCP servers are in developer preview
  and need the same registered client.

Vendor logos are not used, per D26. Rows carry a letter on a tile.

## D31. Hover has intent, and old content leaves first

A pointer must rest on the island for 180 ms to open it, and be away for 240 ms to close it. Without this the island reacted
to every pass towards a browser tab. Content fades out in 70 ms before new content fades in, so two lines of text are never
readable on top of each other. Filters are gone from these transitions, because a blur re-rasters text on every frame.

## D32. History lives in the webview's storage

Finished sessions and the chat survive a restart through `localStorage`, capped at 30 sessions and 200 messages. A restored
session is read-only because its process is gone. Images are never kept. SQLite would be the choice for search across history,
and nothing needs that yet. History is plain text on disk, like Claude Code's own transcripts, and Privacy can clear it.

## D33. Updates install on a click, from a channel set at build time

Replaced by D52. Installing only on a click still holds.

`tauri-plugin-updater` verifies an Ed25519 signature. The public key and address come from `MERIDIAN_UPDATE_PUBKEY` and
`MERIDIAN_UPDATE_URL` at build time. A build without them says it does not update itself, rather than pretending to check.
Nothing installs on idle, because a restart ends running agents. See `docs/development/RELEASING.md`.

## D34. A face on the island, chosen by the user

The line of light is replaced as the lead by a face, after the owner reviewed six designs and picked Soft eyes. It blinks at
random, looks at the pointer, falls asleep after ten minutes, and takes a shape and colour for each mood. Faces live in one
registry, `island/faces.tsx`. Adding one in an update means drawing it there, and it appears in Settings, Island. A face id
this version does not know falls back to the default, so a downgrade cannot leave the island blank.

Rest stays cheap: blinks and looks are short, event-driven repaints, not a loop. The line remains only for the listening view,
where it draws the real microphone level.

The mark shown while Claude Code works is our own spark, drawn in `island/marks.tsx`, not Anthropic's logo. D26 still stands:
a public release showing the real logo would need Anthropic's permission. The owner asked for an animated Claude icon, and a
spinning spark in the same colour gives that without using a mark that is not ours.

## D35. Live activities come from what the source stated

Flights, parcels, meetings and tickets are followed on the island, using Apple's Live Activity pattern: a small view with one
fact on each side, and an expanded view on hover. `island/live.ts` is pure, so each stage is tested.

Times come from email and calendars. There is no flight data feed, so a delay after the booking email is not seen, and an
in-flight countdown is an estimate from the schedule. The interface says so. Live delays and gates would need a paid service.
Food and cab apps publish no live position to a desktop, so those are not faked: a parcel shows only what its emails say, and
appears only on the day it arrives, because Apple's limit of about eight hours is a good rule for what deserves the island.
Bills stay as reminders rather than sitting on the island all day.

## D36. Nobody using the app types a key

Providers connect with one click and a login on the service's own page. Services that accept only registered apps are
registered once by the publisher, and their IDs go in at build time. Until then their rows say they are not available yet,
rather than asking a customer for a client ID. API keys remain, folded away, only for model providers with no browser sign-in.
AI sign-in is a chooser: Claude and ChatGPT through their own CLI's browser login, OpenRouter through its PKCE flow, which
needs no registration, and local models.

## D37. Music is small until it is clicked

Sizes replaced by D43. Closed, it is 196 by 36: artwork and bars, as on a Mac. A click opens 372 by 150 with the album and controls, and it closes when
the pointer leaves. Those sizes sit inside Apple's Live Activity range of 84 to 160 tall and about 371 to 408 wide.

## D38. Every page sets its own size

The panel morphs between pages, so moving around is itself motion, and a small page never fills the screen for no reason.

## D39. Real logos for services you connect

Replaces D26. The owner asked for icons, because letters on tiles read as unfinished. Providers, AI sign-in and the Chat picker
now show each company's own logo on a light tile, like an app icon. A logo here names the service a person is about to connect
to, and Meridian is not affiliated with any of them.

The logos are copied into `src/lib/brand-marks.ts` by `scripts/brands.mjs`, from CC0 and MIT icon sets, so no icon set is a
dependency and only the logos in use ship (64 KB). The licence on those sets covers the drawings, not the trademarks. Slack,
OpenAI, Canva and Microsoft have asked the largest open set to remove their marks, so **before a public release each logo
should be checked against that company's brand rules**. Granola, Jan and llama.cpp have no open logo and keep their initial.

## D40. Sound decides what is playing

Windows' media controls are not reliable enough to be the only source. JioSaavn holds two sessions under one app id. One answers
`0x80070015, the device is not ready` when asked for details, and when a second session starts playing, Windows can drop it from
its list while the idle one stays. VLC, iTunes and Winamp publish nothing.

So the watcher now listens per session, not per app id, and a session that will not give details is kept. It also asks Windows
which apps are making sound, using the same per-app meter as the volume mixer. An app named in `PLAYERS` that is audible counts
as playing whatever its session says, and one with no session is added, with its title read from its window. The list is a
list of names so that a game or a call never shows as music, which means a new player has to be added to it. No audio is read,
only its level. Everything else is unchanged: what a session reports is still used for titles, artwork and controls.

The cost is a look every 3 seconds, in place of sleeping until told.

## D41. The island is one drawn path

The notch used to be four pieces: a grey rectangle, a black face inset by a pixel, and two gradient curves placed beside it. The
grey hairline ran straight up between each curve and the rectangle, and the shadow followed only the rectangle, so the owner could
see the curves and the body as separate parts. Tuning the pieces could not fix that, because the join was built in.

The shape is now one line, `notchPath` in `island/notch.ts`, driven by the same spring values as before. There is no hairline at
rest, only black, which is what a hardware notch looks like. Its shadow follows the whole outline, and it is only ever a black
shadow: the owner found a coloured glow around the shape too much, and neither TwoCode nor Coucou has one. While something is
happening the outline shows a very faint rim in the state colour, and a thin light runs along the same path, so it follows the curves too. The light is a
CSS animation on the path, and it replaces a spinning 1100 pixel gradient. Morphs still measure 180 frames a second, with a worst
frame of 11 ms.

## D42. Releases come from a tag

`npm run release 0.2.0` sets the version in all four places, commits, tags and pushes. The tag starts
`.github/workflows/release.yml`, which tests the app, builds it on a clean Windows machine and publishes a GitHub release with
the setup exe, an MSI, a portable exe and checksums. The same workflow run by hand from the Actions tab builds those files without
publishing.

The shape follows Coucou's Windows workflow, which is also Tauri. Checking that the tag matches every version file is theirs too.
Actions are pinned to commits, since this workflow can hold signing keys. Optional secrets are passed on only when they have a
value: the app reads them with `option_env!`, where an empty string counts as set, and a blank client ID would otherwise offer a
sign-in that can only fail.

## D43. Every small state is one height, and music shows the song

The owner found the music bar too small beside the other states, and it hid the song. So every small active state, music, live
activities, working, thinking, listening and screen reading, is now 46 tall with the same corners. Moving between them changes only
the width, which is what makes the island feel like one thing. Music is 340 wide, with the cover, the song and the artist always
showing. This goes past Apple's compact Live Activity size, on purpose: the song's name matters more here than matching a phone.

Music looks the same everywhere it appears. The island and the Music page share one set of controls: solid white symbols with no
circle behind them and play the largest, as on an iPhone and in TwoCode. The bars take the album's colour, using its hue at a fixed
brightness, because the average of a dark cover is close to black.

## D44. Plans and questions are answered on the island

Claude Code's permission hook also covers two tools a bare Allow cannot answer. Anthropic's documentation says AskUserQuestion and
ExitPlanMode need `updatedInput` with the allow. A plan now shows in full and goes back unchanged on approval. A question shows its
options and goes back with the user's answers added, joined with commas for a multiple choice, and only if every answer is one that
was offered. Any other tool's input can never be changed from here. If a question gets no valid answer, the reply is no decision,
which leaves it to the terminal's own dialog. These replies have not been tried against a live session, because Claude Code offers
neither tool without a terminal, so no scripted run can reach them.

## D45. Changes to the user's own files are shown first

PRD rule 9 asks for a backup, a shown diff and explicit confirmation before changing agent configuration, and following Claude Code
had only the backup. The switch now shows the exact lines, the file and the backup's path, and writes nothing until confirmed, in
both directions and during onboarding. The access token is replaced with a label in what is shown.

## D46. Chat is where you look at the screen

Screen awareness had its own page, with a review step that sent you to Chat afterwards. TwoCode has one surface, and that is why it
feels natural: you point at something, a small pill shows what was seen, and you ask. So Look now lives in Chat. The eye in the message
box, the hotkey and the two buttons on an empty chat all put a pill with a thumbnail above the conversation, and Explain, Summarize,
Translate and Check spelling appear as one-click questions. Answers are plain text, with no bubbles.

Nothing about consent changed. Nothing leaves the PC until a message is sent, that message says what goes with it, and the pill opens to
show the exact text and picture, to narrow them, or to leave the picture out. The modes and the never-capture list moved to Settings,
Screen. Nothing was removed.

## D47. The face shows how it feels by its shape

Soft eyes stay white. Colour alone says nothing to someone glancing up, while shape reads at once: arcs when pleased, slanted lids when
sad, wide when it needs you, narrowed and reading from side to side when concentrating, one eye larger when thinking, a wink, hearts,
dizzy rings. `feel()` shows one for a moment when something happens, so a finished task is a smile and an approved request is hearts.
Faces other than Soft eyes use the nearest mood they have.

It gets drowsy after 45 seconds and sleeps after two minutes, and is startled awake by the pointer. Asleep, it snores a z now and then.
Glances, double blinks and snores run on the same random timer as blinks, so being alive still costs a short repaint every few seconds
and not one every frame.

## D48. Designs held for review

Voice, charging, volume and brightness, and the next features from Coucou were put on the design canvas before any were built. A first
volume display was started and taken out again when the owner asked to review it first. The owner has since approved voice, voice setup,
and the volume, brightness and charging display (D50, D51). The Coucou board is still waiting and stays unbuilt.

## D49. Claude Code is seen with no setup

Following was the only way to see Claude Code, it was off by default, and nothing said so, so to the owner the app simply missed a
running session. Hooks also cannot be the whole answer, because Claude Code reads them when it starts, so a session already running
never picks them up. Claude Code keeps a small record of each running session, saying whether it is busy, and its transcript names the
tool in use. Reading those shows any session at work with nothing changed on the user's machine.

So the app now watches those records, every 2 seconds. Hooks remain, because only they can answer a request. A session they report is
left to them. Records are checked against a live process, because one can outlive a crash, and runs started by tools are skipped, which
includes this app's own. Key files beside the records are never opened. These are Claude Code's own files and not a promised format,
so if they change, sessions simply stop showing, and following still works.

## D50. Volume, brightness and charging are one display

Built as one display because they behave as one: something changes, it shows for a moment, and it leaves. A tap of the volume key must
not wait for a poll, so volume comes from Windows' own change callback and brightness from its WMI event. Battery has no event worth
using, so it is read every 2 seconds. That is cheap, and only a change that means something is shown: plugging in, unplugging, and
crossing 20, 10 or 5 percent. Everything else stays quiet, so a draining battery does not keep waking the island.

The choice of what is worth showing is a pure function with tests, `worth_showing` in `crates/media/src/levels.rs`.

## D51. Voice keeps a single audio format, and the choice of voice stays with the user

Every voice, cloud or local, ends as raw 16-bit audio at a known rate, so playback has one path and adding a voice is one match arm. The
default is the Windows voice, because it needs no key and no download. Hearing defaults to the local engine, because a microphone should
not leave the PC unless the user chooses a cloud service, and Local only blocks cloud voices and hearing as it does cloud chat.

The local engine and its models are not in the installer. They would add about 350 MB that many people never use. They download on
request, from sherpa-onnx's own releases, and each must match a checksum pinned in `crates/voice/src/pack_list.rs`. Unpacking happens
beside the final folder, so a half-finished pack never looks installed.

A turn ends on meaning, not only silence. A sentence that sounds finished ends after 750 ms, and one that trails off gets 1,900 ms. Speech
is cut off only after 200 ms of the user talking over it, so a cough does not stop a reply.

Two items from the board are left out. Wake by name needs a microphone that is always open, which goes against the rule that the island
always shows when it is listening. The Windows speech recognizer is below the quality the rest of the feature needs.

The call that speaks ends before its audio arrives, because audio crosses over a separate channel. Waiting on the call made the app
believe it had finished, and reopened the microphone over its own voice. An empty last message on the channel now means all the audio is
in. Only a run on the real app showed this. The browser stand-in has no such gap.

The engine stays at sherpa-onnx v1.13.8. Version 2.0.0 removed espeak-ng and now ignores `data_dir`, so on v2.0.1 Kokoro and Piper could
never speak: every sentence came back empty. A review of the code found this, because nothing here has run the engine. Going past 1.13.8
needs a lexicon or a phonemizer of our own. A pack now counts as installed only if its pinned build is there, and an older engine folder is
removed at startup, so a change of version cannot leave structs and DLL out of step.

## D52. Updates come from the private repository through the GitHub CLI

The owner chose to keep everything private. Release files in a private repository need a login, so `tauri-plugin-updater`, which fetches a
public address, cannot reach them. D33's plugin, its signing keys and the `latest.json` feed were removed, because they could never run.

Settings, Updates now uses the owner's existing `gh` sign-in, with no token stored by the app. Before installing, the setup file must
match `SHA256SUMS.txt` from the same release. That catches a damaged download only. The real protection is that the release came over
GitHub's TLS from a repository only the owner can write to.

This cannot reach customers. For them, restore the plugin and its signature check on a public host. The removed code is in the git history
before this decision.

## D53. Every window in view has to pass the capture exclusions

A capture copies the screen, so checking only the window asked for let a password manager beside it, or on top of it, into the picture. The
exclusions now run over every visible window in the captured area, just before the pixels are read. A window capture stops at the target,
because only what is in front of it can show. A whole-screen capture lists the whole display, so a password manager behind other windows
also blocks it. That is strict on purpose, and subtracting covered windows is the way to loosen it if it gets in the way.

## D54. No change without an approved design

The owner asked for this on 2026-10-31: every change to the app needs a design they have approved first. They also said the boards looked
nothing like what was built. Two causes: boards drew full screens while real tabs are mostly empty, and each tab had its own size.

So boards now cover empty states, use the real words and controls, and show one size. After building, each tab is compared with its board
side by side in the real window before it counts as done.

Apple-style glass, themes, limits and models, the assistant's name and personality, and wake words are on the canvas and held for review.
Wake words would reverse the part of D51 that left them out, and only because the owner asked for them.

## D61. Notes use the hearing service, not a model on the PC

Coucou's Notetaker runs Parakeet and a diarizer on the PC. Parakeet has no Hindi, Hindi is required here, and it is a 670 MB download. Meridian's local hearing is English only and has
no speakers. So a call goes to the hearing the user chose, and ElevenLabs Scribe gives every word a time and a speaker. The cost is that a call leaves the PC, so the first screen says
so before anything records, local only refuses it, and the audio is deleted once the transcript is safe.

The microphone and the PC's sound stay two recordings, each sent on its own. That is what makes You certain and the others separable, and it means a call is billed twice its length.
Both are written as raw 16-bit files, with no header to finish, so a crash loses at most a moment. Windows mixes the PC's sound down to 16 kHz by itself, which keeps resampling out of this
code, and anything it does not deliver is filled with silence by the clock, so the two stay in step. Live words are left out, because they would be paid for a second time.

Summaries go to the engine chosen for Chat, in a run with no tools, no hooks and no session history. A transcript is other people's words, so it is marked as content. Starting is a click
and nothing else, and the island shows it for as long as it runs, so nothing here can run unseen.

## D60. Gmail and Calendar can go through the user's Claude account

Reading Google directly needs one app registration, and the owner has no Google Cloud console access. Their Claude account already has a Gmail
connector, and Claude Code can use it. Taking the token from Claude Code is ruled out, so the one way in is to ask Claude Code itself. The
connectors stay out of the assistant's own run, which stays strict and fast. Two tools start a separate run for each question instead.

That run is the safety boundary, because Gmail's connector can send and delete. `allowedMcpServers` loads only that service's address, so the
user's plugins and other servers never start. `dontAsk` refuses anything not allowed, the allow list is tools named get, list, search or find,
and write verbs are refused by name, because a refusal beats a tool the user allowed everywhere. Tools are empty, so there is no shell, file or
web access. Hooks are off, or a memory plugin would keep the mail, and so is session history. Rules follow names rather than a list of tools
because Calendar's tools cannot be seen until it is connected, and this also refuses tools added later.

The price is that mail goes through Claude, each answer takes seconds, and each uses plan usage. So it reads only when asked, and the
direct route stays for any build with a registered app.

## D59. Wake words learn the user's voice, and the Windows recognizer is gone

Replaces D55 and D57. The Windows recognizer could not be made reliable on the owner's PC. Over a day of traces it heard them in some runs and nothing in others,
with their voice reaching every audio stream at full strength, with Windows' voice filter on and off, alone and beside other streams, and fresh or long running.
No cause was found, and a recognizer that cannot be fed its sound cannot be fixed from outside.

Wake words now use rustpotter, which is Apache-2.0, written in Rust, and needs no download or separate library. The user says a word four times, and it compares
the microphone against those recordings on this PC.

- It listens to the microphone chosen in Meridian, which the Windows recognizer could never do, so the same stream goes on to the conversation with nothing lost.
- A word can be in any language, and this works on a Mac too.
- Recordings stay in memory for the lesson. Only a pattern of them is kept, and removing a word deletes it.
- It knows the voices that taught it and no others, which is what keeps other people out, but every user has to teach it.
- A lesson is only as good as its recordings, and one bad take spoils it. A 60 ms blip in a lesson matched any noise at all, and takes that were not alike missed the
  real word. A lesson now keeps asking until four takes are the right length and sound alike.
- The comparison ignores loudness, so noise can still match. Voice detection and a rule that a word must be voice-level for 360 ms keep that out.
  Requiring two recordings to agree at one moment does not work, because recordings differ in length and never line up.
- Nothing proves the name before speech goes to the hearing any more. D57's proof depended on the recognizer's own timing, and missed commands were the worse failure.
  Someone's own speech that sounds close can wake it, and what they say next is then treated as a request.
- candle 0.2, which rustpotter depends on, does not compile with newer versions of `half`, so `Cargo.lock` holds `half` at 2.3.1.
- Its licence text has to ship with a public release.

## D55. Wake words are heard by the recognizer in Windows, and only on this PC

Replaced by D59.

The owner asked for wake words on 2026-10-31 and accepted a microphone that stays open, as a switch that is off until they turn it on. This
reverses the part of D51 that left them out, which is the only reason the microphone may open with no click or key.

The recognizer built into Windows does the listening, held to a fixed list of phrases. It needs no download, it runs on this PC, and it has
an Indian English model on the reference machine, which it picks from the user's own language list. D51 ruled it out for writing down speech.
A short list is a much smaller job. sherpa-onnx has a keyword spotter too, but it needs the downloaded engine, which cannot be loaded during
development, so it could never have been tested here.

No cloud service hears the wake word, because that would mean streaming the room. Nothing leaves this PC until the name is heard, and from
then on it is the same as pressing the key, so words go to the hearing chosen under Voice.

The microphone closes for a conversation, for Pause all monitoring, and if the user keeps those options on, while the screen is locked,
while another app is using the microphone, and on battery. Windows records which apps are using the microphone, so that is read from there.

Phrases are English letters only, because the recognizer works out how a word sounds from its spelling. A Hindi name works when written that
way, such as Suno Mira, and it cannot be written in Devanagari.

The board's dot pulsed, and the built one is still. Anything that moves redraws the whole window, and this dot can stay for hours. The
board's Paused pill was left out too, because a pill that stays for a whole call is louder than what it reports. The dot goes, and Settings
says why. The board's Hey Mira needs the assistant's name, which is not built, so the first wake word is Hey Meridian.

Listening costs about 1.2% of one core and 52 MB, in Windows' own SpeechRuntime process.

## D56. The assistant acts on this PC through the app's own tools

The owner said an assistant that only talks is no use: it told them to ask Meridian, and could not open an app. So the assistant now knows it is
Meridian and can do what Meridian can do. This reverses D33's general mode, which had no shell and no edits.

General runs of Claude Code connect to a small MCP server inside the app, on a loopback port with a random token in the path, and get a system
prompt that says who they are. Only this app's own runs get the address, and `--strict-mcp-config` keeps the user's other connectors out.

Tools that are easy to undo and send nothing anywhere run without asking: opening apps, websites, documents, folders and Windows Settings pages,
finding files, media controls, volume, reminders, reading the day, opening Meridian's tabs. Anything else stops on the island for a yes, by
click or by voice, through the permission hook every run already has. That covers reading the screen, because the text goes to the AI, and
starting an agent, and any command or file edit. A file that would run a program cannot be opened by the open tool at all, so it has to go
through a command and that question.

Other chat engines do not get these tools yet, because they have no tool loop. Claude Code is the owner's engine.

## D58. Glass is a lit sheet, not a hole in the window

The boards drew frosted glass over the wallpaper. A webview can only blur its own content, and Windows' own backdrop fell back to flat grey when
tested, so the panel is an opaque sheet carrying its own light, with frosted layers floating on it. Each theme sets that sheet and the accent. The
island stays black in every theme. It looks the same over any app, and it is always readable.

## D57. Wake words need more proof the longer the speech

Replaced by D59.

The first wake grammar matched exact phrases, so a command in the same breath was refused, and it missed quiet names. A grammar that finds the
name inside speech fixed that, and accepting Low confidence fixed the misses, but together they fired on people talking near the microphone,
sent that to the AI and answered out loud. That was caught in testing on 2026-10-31, from two sentences nobody had aimed at it.

So a name on its own may be faint, but inside longer speech it has to be High confidence. Then, before anything goes to the AI, the words the
hearing wrote down have to contain the name, allowing for spelling and for Hindi script. If they do not, it is dropped silently. One utterance
can still reach the hearing service before that check, which is the price of a command in one breath.

While listening, the last 12 seconds of microphone audio stay in memory, are never saved, and are replaced as they age. That is what makes one
breath possible without a gap to reopen the microphone.

