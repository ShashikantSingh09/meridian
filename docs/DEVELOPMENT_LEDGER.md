# Development ledger

## 2026-11-01: Wake words that heard nothing, and dropdowns that ignored the theme

The owner chose their microphone and saw its level move, but the wake test said it heard nothing, and the device lists opened as black system boxes.

- **Why wake words were deaf.** The chosen microphone was the Windows default, so the choice was not the problem. Its Windows slider sat at 26%. Windows'
  Voice Clarity filter sits on that microphone and removes what it does not take for clear speech, and the recognizer gets no gain of its own. Measured on the
  owner's voice: about 0.15 on the meter at 26% and nothing recognized, about 0.6 at 100% and five of six phrases recognized, with raw scores from 0.28 to 0.88.
  Conversations go through the browser's gain, which is why Meridian's bar moved and made the microphone look fine.
- **The test now says why.** It reports the microphone, its slider and how loud it held, ignoring clicks, and offers to raise a low slider. Only that button
  touches the setting. The bar under Try them now shows the real level, with no gain.
- **The webview may no longer move the slider.** `WebRtcAllowInputVolumeAdjustment` is off. It is a guard: nothing tonight caught it moving the slider, and
  what set it to 26% is unknown.
- **Every system dropdown is gone.** A system list cannot follow a theme, so all of them use the app's own menu, which opens upward when there is no room below.
  The pills and the fields on the Agents page no longer stay dark in light themes.

### Not proved

- Wake words in the installed app on the owner's voice with the slider at 100%. The trace ran with the recognizer alone.
- One run at 100% recognized nothing during loud sound, with a test stream open that was never read. The cause is not known.
- Whether the bar under Try them is free of gain while wake words hold the same microphone open.

## 2026-10-31: A real assistant, and every board built

The owner's verdict was that the app was a show-off: it told them to ask Meridian, could not open an app, and the designs were not in it.

- **The assistant acts.** See `docs/DECISIONS.md`, D56. Through the real app it opened Calculator from English and from Hindi, changed the volume,
  set and read a reminder, opened a tab, found a file, and said who it was. Screen reading, starting an agent and a command each stopped to ask.
- **Wake words catch a name inside speech**, take a command in one breath, and were tightened after they fired on people talking nearby. See D57.
- **Every board is built:** glass and six themes with custom themes, Settings with search, Assistant, Microphone and headphones, Home, Chat, Agents with
  stages, Changes and All at once, Media, My day, Notifications, Welcome, and the finished, failed and to-do cards on the island.
- **Found by running it for real, not by the mock tests:** the wake word answering room talk, raw tool names on the island, a note from the CLI in command
  output, and Chat stuck on a provider that had gone away.
- **All tabs are one size now**, 820 by 600, so moving between them never resizes the window.

### Proved on the real app

Every live mode: local chat, approvals allowed and denied, cancel, resume, images, the assistant asking first, reminders, screen capture, and a Codex
failure. Every island state and tab with no exceptions. 583 Rust tests, 168 unit tests and 128 interface tests.

### Not proved

- How often the wake word catches the owner's own voice after tightening. It needs them, and the Test button shows it in seconds.
- A to-do list from a real run. The live test agent used a memory plugin's list instead, so `TodoWrite` and `TaskCreate` are proved by tests on real transcript shapes only.
- Codex limits, because its sign-in here has expired.

## 2026-10-31: Agents as the boards drew them, and real plan usage

The owner reported sessions piling up, no sign of how much of their plan was used, and media controls sitting too high.

- **The Agents list** now reads Needs you, Running and Finished, with what each is doing and when. Conversations stay in Chat, where they
  belong, which was most of the noise. Finished work folds into Earlier after a day or past four, and Clear empties it.
- **Plan usage was never wired up.** `rate_limit_event` was being ignored. It now reaches a card under the list and a Limits and models page,
  with a notice once at 80% and once at the limit. One real report carried only the seven-day window, so reports are merged, not replaced.
- **Sessions in the user's own terminal do not report plan usage**, because hooks do not carry it. Codex limits are parsed but untested, because
  its sign-in here has expired.
- **Each session** shows its model, how full its memory is, tokens and cost in the header.
- **The media controls** sat above the middle of the room left under the progress bar. They are centred now, with a test, in one raised
  capsule as on the board, with times beside the progress bar.
- **Wake words were proved by the owner.** They turned them on, added Meridian, and talked to it.

## 2026-10-31: Wake words

Built from the owner's approved board, with a switch for the always-on microphone. See `docs/DECISIONS.md`, D55.

- **Settings, Wake words.** The switch, the word list, Test, how easily it wakes, what happens after, when it listens, and the pauses.
- **The island** shows a still dot while listening, and answers Yes? when woken. From there it is the same as pressing the key.
- **`crates/voice/src/wake.rs`** holds the listener and the rules, and `src-tauri/src/wake.rs` keeps it open only when it should be.

### Proved

| Check | Result |
|---|---|
| The recognizer runs from an ordinary app, in Indian English | Yes, on the real microphone |
| It keeps running | 15 s and 120 s with no audio problem |
| It hears speech and refuses what is not on the list | Two rejected results in 28 s, no false wake |
| The app opens it and shows the dot | Listening within 2 s of Test |
| Rules for each pause, sensitivity and word | 7 tests |
| A person saying the phrase | Yes. The owner added Meridian as a word and talked to it, on 2026-10-31 |
| Cost while listening | 1.2% of a core and 52 MB |

## 2026-10-31: Voice failed until Chat had been opened

The owner reported that voice did not work. Each layer was tested in the installed app, with their own recordings standing in for the microphone.

- **Voice had no AI to ask.** Only the Chat tab chose an engine, so after every start or update a spoken turn ended on "No AI provider ready",
  even with Claude Code signed in. Home's ask box and sharing a capture had the same hole. The choice now lives in the store as `pickEngine`.
- **Talk in Chat gave no sign of listening.** The panel outranked the voice view, so the microphone opened with nothing on screen and no Stop
  button. An open microphone now always shows, and the panel returns when the turn ends.
- **Proved after the fix, with Chat never opened:** hold and tap, a Hindi question answered and spoken in Hindi through ElevenLabs. A page reload
  during testing removed the stand-in clip, so the real microphone was used for about 30 s and answered a real question, with talking over the reply working too.
- **What is new now always shows** under the version, and releases carry only what changed. See `docs/research/voice-hindi-test.md` for the hearing results.

## 2026-10-31: End-to-end pass on v0.4.1

Run through the real app, with real Claude Code sessions, on the reference machine with a 180 Hz display.

### Proved

| Area | Result |
|---|---|
| Update | 0.4.0 to 0.4.1 through the app's own Update now button. It came back on its own with no errors, and packs survived |
| Approvals | Waits for an answer, Deny blocks the command, Allow runs it. The run's transcript shows the decision comes from the app's hook |
| Sessions | Cancel, resume with context, images, follow-up on a live process, stop mid-turn |
| Screen | A rule naming a window on top refuses a whole-screen capture, and capture works again without the rule |
| Media | Silent live tests pass 10 runs in 10 in parallel |
| Interface | 28 island states, 7 tabs, 10 Settings pages, no exceptions or layout faults |

### Found

- **Idle cost was 6.26% of one core, against a target of 0.5%.** A sleeping face drew a z for 2.4 s every 5 to 8 s, and each one redraws the
  whole 860 by 660 window at 180 Hz. It now makes six and stops. GPU time asleep went from 4.05% to 0.00%, and the total to 1.26% on a dev
  build. The release figure is not measured yet.
- **What is new showed install instructions.** Releases now list commit subjects above a `---` line, and the Updates page stops at that line.
- **Harness bugs, not app bugs.** `tests/live/e2e.mjs` read `sessions[0]`, which is a followed session once one starts, so it now looks up by id.
  Two media tests published the same track from one process and collided, so they take turns.
- **The one 404 is the browser asking for `/favicon.ico`.** Harmless. The IPC warning came only from reloading the page by hand, which the app never does.

### Corrected along the way

A test approval was allowed with no answer from the harness, which looked like a bypass. Recording real pointer events showed the owner had
clicked Allow on the island while the test ran. Allow's only other route is a spoken yes.

## 2026-10-31: Bug review, v0.4.1

Four separate reviews read the voice stack, the Rust app, the interface and the backend crates, and found about 70 problems. Each was checked
against the code before it was fixed, and logic with any weight got a test.

### The ones that mattered

- **Kokoro and Piper could never speak** (D51). The pinned engine had removed what reads text aloud. Hand-written structs matched its header
  perfectly, so only reading its changelog showed it.
- **A bad calendar invite or a date in forged mail could stop reminders and sync on every launch**, through a panic in date arithmetic.
- **Screen capture could include a password manager** beside the window asked for (D53).
- **The Claude Code hook token could reach the webview** in the preview of the settings change.
- **A queued instruction could be killed** by the idle timer while its turn was running.
- **Pause could reach the wrong player** when the one shown was not the one Windows had chosen.
- **Local-only mode did not stop mail sync.**
- **A cancelled flight could still fire reminders** when the mail arrived newest first.
- **Previews of island states could not be left** without a restart, and hid real sessions meanwhile.
- **Voice:** a double tap left the microphone open, and several paths stuck on Speaking or Thinking.
- **The greeting opened with a wink,** one eye shut, which looked wrong.

### Tests

| Suite | Result |
|---|---|
| Rust | 551 passed, 13 ignored |
| Unit | 88 passed |
| UI | 85 passed |

The local engine has still never run. See `docs/KNOWN_ISSUES.md`.

## 2026-10-31: Voice, levels, and updating from inside the app

### Completed

- **Volume, brightness and charging** (D50). Approved from the board, and built as one display.
- **Voice** (D51). Hold, tap or tap twice on Ctrl Alt V, or the microphone in Chat. Speaks through ElevenLabs, OpenAI, Cartesia, Deepgram,
  Kokoro, Piper or the Windows voices. Hears on this PC, or through ElevenLabs or Deepgram.
- **Updates** (D52). Settings has an Updates page that checks and installs from the private releases through `gh`. The updater plugin and
  its signing setup are gone.

### Found by testing

- **The app thought it had finished talking before it started.** The call that speaks ended before any audio arrived, so the microphone
  would have reopened over its own voice. The browser stand-in cannot show this. It took counting bytes on the real app: 0 when the call
  ended, then 6.7 seconds of audio. An empty last message now marks the end, and a spoken line takes 6.87 s for 6.73 s of audio.
- **A detached install script** would have opened a console window. Reading the code caught it, before any installed copy could run it.
- Chromium's fake microphone beeps about every 500 ms, so a turn never ended. The test now uses a real recording.
- `gh release view` with no tag says "release not found". The latest-release API works.

### Not proved

The local engine has never run. Loading its downloaded DLL here was refused by a safety check, so Kokoro, Piper and local hearing are
unproven. No cloud voice has been used. See `docs/KNOWN_ISSUES.md`.

### Proved on the real app

| Check | Result |
|---|---|
| Update, end to end | A 0.3.9 build of this code pressed Update now, fetched v0.4.0 from the private repository, passed the checksum, quit, installed silently and restarted on 0.4.0, in about a minute |
| Volume keys | Real key presses reached the installed island, which showed the level view |
| Windows voice | 6.73 s of 16 kHz audio through the real channel, and the Hear button in the installed app, with nothing played aloud |
| Microphone path | The audio worklet loads under the release build's security policy |
| Claude Code session | Shows as working on the installed island with no setup |
| v0.4.0 installer | Defender found no threats |
| Tests | 533 Rust, 65 unit, 61 UI |

## 2026-10-31: Chat that really continues, and eyes with feelings

### Completed

- **Chat follow-ups.** A chat from before a restart failed with "No session with that id", because history came back but the engine had
  forgotten it. The agent's own id is now saved, and the app resumes the real conversation. The stand-in engine used by tests accepted
  anything, so no test could have caught it. It now refuses as the real one does.
- **Chat and screen are one surface** (D46).
- **Expressions** (D47).
- **Long song names** slide while the pointer is on them. The browser's own tooltip is gone from the bar.
- **Claude Code with no setup** (D49). A running session shows on the island with nothing changed on the machine.

### Proved on the real app

| Check | Result |
|---|---|
| A session already running in a terminal, with no hooks | Shown as working, with its live activity |
| A chat after the app was fully stopped and started | Told a word, restarted, then asked: it answered MANGO |
| Tests | 518 Rust, 46 unit, 55 UI |

## 2026-10-31: Real music end to end, a calmer island, and ideas from Coucou

### Completed

- **Music, for real this time.** Checked against JioSaavn actually playing, which found two bugs every test had missed. Its sound
  comes from `Windows.Media.BackgroundPlayback`, not `Saavn.exe`, so no name could match it. Package identity does, with no list
  needed for Store apps. And its image is labelled with a comma-separated list of types, which made a data URL no browser would
  load. That was the missing album art. Image types now come from the image's own first bytes.
- **Music bar.** 340 by 46, with the song and artist always showing (D43).
- **Island.** Every small state is one height. The coloured glow is gone, leaving a faint rim and a thin moving light (D41).
- **Controls.** Solid iPhone-style symbols, shared by the island and the Music page.
- **From Coucou.** Plans and questions on the island, Markdown in chat, and a shown diff before changing Claude Code's settings.
  See `docs/research/COUCOU_REVIEW.md`.

### Found by testing

- All suites passed while JioSaavn was still invisible. Only listing the system's audio sessions while it played showed why.
- A test image passed while real art failed, because its label was clean. Tests of this kind cannot stand in for the real player.
- Claude Code run with `-p` has neither AskUserQuestion nor ExitPlanMode, so those replies cannot be proved by a script.

### Testing status

| Check | Result |
|---|---|
| Rust | 513 passed |
| Unit | 46 passed |
| UI, Playwright | 52 passed |
| Real player | JioSaavn playing: title, artist, playing state and a 150 by 150 cover in the real window |
| GitHub | Release workflow passed on a clean machine in 23 minutes |
| Idle | 0.26% of one core with the webview, measured over 30 seconds |
| Not tried | Questions and plans in a live session, Spotify, Apple Music, VLC |

## 2026-10-31: One-path island, album art, release automation

### Completed

- **Island.** Rebuilt as one drawn path, after the owner saw the curves and body as separate shapes (D41).
- **Album art.** The session chosen was often JioSaavn's one with no details, so it had no art. Fixed by preferring a session with
  a title. Art is now read once per track rather than on every 3 second look.
- **Releases.** `npm run release` and a GitHub workflow that builds and publishes installers (D42).

### Testing status

| Check | Result |
|---|---|
| Live | Three media tests, one sending a real picture through Windows and reading it back |
| Real window | That picture loaded in the real app under its content policy, closed and open. Island checked in magnified crops of the real screen |
| Morphs | 180 frames a second, worst frame 11 ms |

## 2026-10-31: Music in any player, logos, Chat and Desktop

### Completed

- **Music.** JioSaavn was missed for three separate reasons, all fixed. The watcher listened once per app id, and JioSaavn has
  two sessions. It dropped any session that would not give details, and JioSaavn's first one will not. And the first state was
  sent before the interface was listening. Sound now decides what is playing (D40), which also covers VLC, iTunes and Winamp.
- **Logos.** Real logos on Providers, AI sign-in and the Chat picker (D39).
- **Chat.** Native dropdowns replaced by a row of AI buttons, as in TwoCode, and the app's own menus for models and conversations.
  Chat opens on an AI, so there is no longer an empty choice.
- **Desktop awareness.** Rebuilt: what the app is doing, three modes as cards, two clear actions, and the never-capture list as chips.

### Found by testing

- A test built on two players in one process failed even after the first fix. It turned out to be testing Windows, which drops
  the second session when it starts playing. That is what led to using sound.
- JioSaavn's failing session answers `0x80070015`, seen by reading its real sessions.
- With both sessions paused the watcher could pick the one with no details, which showed "JioSaavn" as the title. Caught in a
  real capture, and fixed by preferring a session that has a title.

### Testing status

| Check | Result |
|---|---|
| Rust | 507 passed |
| Unit | 35 passed |
| UI, Playwright | 50 passed |
| Live, ignored by default | 2 media tests passed, one using a stream too quiet to hear |
| Real window | Chat, Desktop, Providers and AI sign-in captured from WebView2 with no console errors |
| Not tried | JioSaavn while audibly playing |

## 2026-10-31: Milestone 4, a living island

### Completed

- **Reviewed design first.** A Claude Design canvas, revised with the owner's feedback, then approved.
- **Faces.** Six, with Soft eyes as the default, in a registry that takes more in updates. They blink at random, follow the
  pointer, sleep after ten minutes and change with mood. Picker in Settings, Island.
- **Island.** Light running round the edge while work happens, colour rising from the bottom, a greeting at start, a peek card
  on hover, sparks when something finishes, and an animated spark while Claude Code works.
- **Music.** 196 by 36 until clicked, then album and controls at 372 by 150.
- **Live activities.** Flights through every stage, with a plane moving along the route, plus parcels, meetings, tickets and a
  focus timer. A second activity sits in a bubble beside the island.
- **Panel.** Bottom dock, a size for each page, and Home rebuilt as live cards.
- **Sign-in.** No key fields. Providers are one click and a browser login. An AI chooser for Claude, ChatGPT and OpenRouter.
- **Real work shown.** Edits and command output appear in Agents as they happen.

### Found by looking at the real window

- The first review was done in a test browser. The real app's idle island was a 96 by 6 sliver, because Hide when idle was on.
  Real-window capture is now part of checking anything visual.
- Clearing old styles removed the provider tiles' layout. Caught in a real capture.

### Testing status

| Check | Result |
|---|---|
| Rust | 502 passed |
| Unit | 35 passed |
| UI, Playwright | 48 passed |
| Real window | Every state captured from WebView2 with no console errors, and the release build checked on the real desktop |
| Not tried | A real flight email, any real provider sign-in, real album art |

### Measurements

| Measure | Result |
|---|---|
| Idle CPU, release, face alive | 0.63% of one core over 30 s |
| Installer | 4.4 MB |
| `meridian.exe` | 15 MB |

## 2026-10-30: Milestone 3, towards customers

### Completed

- **TwoCode teardown.** REA static analysis and a reading of the shipped code. See `docs/research/TWOCODE_TEARDOWN.md`. The
  app was never run.
- **Notch island.** Flush with the top of the screen, flat top, inward curves, round bottom, opaque black, hairline edge in the
  state colour. Native glass and the light theme were removed. Softer springs, hover intent, birth from the screen's edge,
  bundled Inter.
- **Panel.** Navigation moved to the top, with a sliding indicator. Settings is now sections.
- **Providers column.** `crates/mcp`: a read-only MCP client with OAuth discovery, dynamic registration, PKCE and resource
  indicators. 22 services in the catalog, plus Gmail, Calendar and Outlook on the direct connectors. Rows arrive one by one, a
  beam runs during a fetch, and the count rises. A fetch runs every 15 minutes, and new items reach the island.
- **Following Claude Code.** Opt-in hooks and a loopback watcher, with allow and deny on the island.
- **Shipping work.** First-run steps, history across restarts, update path, redacted crash log, chimes, built-in sign-in
  clients for release builds.

### Rendering bugs found, all fixed

| Symptom | Cause | Fix |
|---|---|---|
| Halo at the edge during a morph | A separate native visual fell behind the webview | Removed the visual |
| Two lines of text on top of each other | Exit and enter fades ran together | Exit in 70 ms, enter after it |
| Text swimming on each change | `filter: blur` on content | No filters |
| Possible flicker on pointer crossing | `WS_EX_LAYERED` toggled | Only `WS_EX_TRANSPARENT` toggles |
| Unreadable popup menu | Dark text forced on a dark list | Fixed colours |
| Island twitching as a pointer passed | Hover applied at once | 180 ms in, 240 ms out |

### Bugs found by testing

- The Stop button still showed for sessions in another terminal. Found by a UI test.
- `echo` needs no permission, so the first live hook test proved nothing about approvals. The test now writes a file and
  asserts it exists.
- GitHub answers token requests in form encoding unless asked for JSON.
- Token requests followed redirects, which could carry a code anywhere.
- Three hand-picked tools were refused by the read-only rule.
- A UI test polled so coarsely that the slower spring pushed it over its time limit.

### Independent security review

A separate review of the new code found 12 issues, all fixed:

| Severity | Issue | Fix |
|---|---|---|
| High | A server's metadata could name another service's sign-in, and the token granted there would go to that server | The `resource` must match the server, or sign-in is refused before the browser opens |
| High | Any build with an update key crashed at launch, because the plugin read a config block that did not exist | Added the block, and proved a keyed build starts |
| Medium | A huge `expires_in` panicked, leaving a provider row stuck | Treated as no known expiry |
| Medium | A lookalike slash could read as one host and open another, through the handler's ANSI code page | Links are parsed, and only the ASCII form goes on |
| Medium | Approvals for a file showed only its name, hiding a Startup or .ssh folder | The whole path shows, and hidden input points at the terminal |
| Medium | A session already running at startup lost its first event, so its approvals never appeared | A missing session is created from any event |
| Medium | A double click could approve the next request, which appears under the button | Answers within 400 ms of the last are ignored |
| Medium | With no read list, sign-in asked for every scope, including write and admin | Broad scopes are dropped, and copy no longer says read-only sign-in |
| Medium | Token replies and tool pages had no byte limit | 1 MiB for tokens, a total for tool pages, 120 s for a fetch |
| Low | Terminal session labels were saved in history | Watched sessions are never saved |
| Low | A byte order mark in the settings file was read as invalid, and a symlinked file would be replaced | Both handled |

Also fixed: a second row for a session that came back, no host on Home's links, and an update check in local-only mode.

### Testing status

| Check | Result |
|---|---|
| Rust | 498 passed, 5 ignored because they need real services |
| Unit | 20 passed |
| UI, Playwright | 47 passed |
| Live, real Claude Code through hooks | Session, activity, a held permission, an allow from the app, and the file written |
| Live, real app | claude, deny, cancel, engine, resume, activity, chat all pass |
| Vendor discovery | 24 services probed anonymously. No account used |
| Installer | 4.4 MB NSIS. Silent install, launch from the installed path, silent uninstall, no files left, settings kept |
| Build with an update key | Starts. It crashed at launch before the fix below |
| Not rerun | screen, vision, media, because they capture the desktop in use and the code did not change |

### Measurements, 180 Hz display

| Measure | Result |
|---|---|
| Eight morphs in a row, debug build | 180 fps, p99 5.7 ms, longest frame 5.7 ms, none over 33 ms |
| Hit test | Over the island the app receives the mouse. Beside it, the window underneath does |
| `meridian.exe` | 14.9 MB, up from 12.4 MB with the MCP client and updater |

### Blockers that need you

See Shipping in `docs/KNOWN_ISSUES.md`: a signing certificate, a public update host, a real name and bundle ID, the Claude
subscription decision, Google verification, and a privacy policy.

### Next steps

See M4 in `docs/IMPLEMENTATION_PLAN.md`.

## 2026-10-30: Milestone 2, the intelligent island

### Completed

- **Island.** Display selection, left, center and right placement, hide from the tray, hide when idle, clock, animation
  speed, hover detail for agents and media, next meeting, and display-change handling.
- **Claude Code and Codex as chat engines.** One engine picker. General mode (no shell, no edits, no connectors) and Project
  mode. Sign-in status from the CLI, sign-in through the CLI's own flow, conversations, follow-ups, stop, tool activity,
  approvals in chat, file references.
- **Screen awareness.** `crates/screen`: capture, local OCR, on-device signals, exclusions. A Desktop awareness page with a
  preview, region selection and an explicit share step. Optional contextual mode, off by default, with interval, pause and
  always-on exclusions. Images reach Anthropic, OpenAI-compatible providers and Claude Code.
- **Media.** `crates/media` on the Windows system media controls. Island view, hover controls, Media page, player switching,
  recent tracks.
- **Personal activity.** `crates/activity`: unified event model, extraction from JSON-LD, iCalendar and rules, SQLite store,
  notification engine, OAuth with PKCE, and Gmail, Google Calendar and Microsoft Graph connectors. My day, Notifications and
  Connected accounts in the app, plus Paste an email and your own reminders.
- **Global pause** in the tray and Settings.

### Bugs found by running it, all fixed

| Bug | Found by |
|---|---|
| Starting the app took focus from the active window | A capture naming our own process as foreground |
| Previewing a state erased real sessions | Empty state after a test |
| Credential Manager rejected tokens, because its 2560-byte limit is UTF-16 | Real round trip |
| OCR reads `main.tf` as `main. tf`, weakening detection | Live OCR test |
| `--tools` alone left MCP connectors reachable in general mode | Reading `system/init` |
| A test that claimed to interrupt mid-stream was stopping before any output | Reading the log it printed |
| Microsoft sign-in would have failed: the port is ignored only for `localhost`, not `127.0.0.1` | Reading the provider's documentation before first use |
| A forged email could offer a link with no sign of where it went | Reviewing the extraction limits |

### Testing status

| Suite | Result |
|---|---|
| Rust | 296 pass, including 197 for `crates/activity` |
| Vitest | 20 pass |
| Playwright | 31 pass |
| Live, Claude Code chat | Sign-in, no key, context, general mode, mid-stream stop, resume, image |
| Live, screen | Real capture, OCR, detection, crop, island exclusion, discard |
| Live, media | Silent session seen, controls delivered, pause seen |
| Live, activity | Email to event, reschedule in place, promo ignored, reminder fires once, cleanup |

### Measurements, release build, every module running

| Measure | Result |
|---|---|
| Idle CPU, nothing moving | About 0.31% of one core, over 30 s |
| `meridian.exe` | 0% |
| Private memory | About 178 MB fresh |
| Binary | 12.4 MB |
| Follow-up on a live Claude Code process | 1.5 s, against 6.7 s from cold |

### Blockers that need you

- `codex login` to verify Codex.
- A Google and a Microsoft app registration to verify accounts. See `docs/development/CONNECTING_ACCOUNTS.md`.

### Next steps

1. Connect a real account, and fix what real mail reveals.
2. Persist chats and sessions.
3. Test multiple monitors and display scaling.
4. Voice.

## 2026-10-30: Milestone 1

### Completed

- Research of TwoCode, Coucou source, Glint, EchoIsland and Windows APIs, in `docs/research/`.
- PRD, architecture, decisions, plan, design system and threat model.
- Toolchain on this machine: Rust 1.99.1 and Visual Studio Build Tools 2022 with the Windows 11 SDK.
- Tauri 2 shell: fixed transparent window, always on top, never activating, out of Alt-Tab, tray, `Ctrl+Alt+Space`,
  single instance, autostart setting, settings persistence, hide over fullscreen.
- Real desktop blur behind the island through a composition visual, with a tinted fallback.
- All nine island states, with spring morphs, reduced motion, dark and light themes, and a state preview in Settings.
- The Meridian Line, drawn on canvas, resting without frames and answering a live microphone level.
- Expanded panel: Command center, Chat, Agents, Providers, Settings.
- `ai-core`: 15 catalog providers, OpenAI-compatible and Anthropic adapters, streaming, cancellation, model lists, local
  discovery, error classification, local-only enforcement, keys in Credential Manager.
- `agent-adapters`: Claude Code and Codex sessions, detection, approvals, follow-up by resume, cancellation by process
  tree, failure reporting.

### Bugs found by running it, all fixed

| Bug | Found by |
|---|---|
| WebView2's modal microphone dialog blocked the page, and previewing a state opened the mic | Screenshot |
| `NOACTIVATE` and `TOOLWINDOW` silently removed by Tauri, so the island would take focus and appear in Alt-Tab | Reading window flags from outside |
| Dark glass turned grey and illegible over white apps | Screenshot over a white app |
| Endless idle animation cost 13% of a core | Per-process CPU sampling |
| Cursor poll ran at full rate over the whole window, with main-thread round trips | Per-process CPU sampling |
| "Providers ready" counted local servers that were not running | Screenshot |
| Agent events arriving before the session id were dropped, leaving a session stuck on Starting | Reading the code after a test failure |
| A follow-up in the two seconds after completion was lost, and could break a resumed run | Live resume test |
| A second parallel approval overwrote the first, leaving it unanswered | Reviewing the approval path |
| Local discovery trusted any HTTP 200 | Reviewing discovery |
| Raw "error sending request" reached the user | Live failure test |

### Testing status

| Suite | Result |
|---|---|
| Rust unit and real-socket tests | 64 pass |
| Vitest | 18 pass |
| Playwright, real UI on the browser stand-in | 13 pass |
| Live, real app with real Claude Code | Approve, deny, cancel, resume all pass; no process left behind |
| Live, real app with stand-in local server | Discovery, streaming, usage, notice, and a dead server becoming an error all pass |
| Live, Codex | Expired sign-in surfaces as a clear failure. A successful turn is not verified |

The live checks are in `tests/live/`.

### Measurements, release build, 180 Hz display

| Measure | Result |
|---|---|
| Idle CPU, nothing moving | About 0.37% of one core, over 30 s |
| `meridian.exe` | 0.16% of one core |
| Private memory | About 166 MB fresh, about 268 MB after opening the panel |
| Morph frame rate | 180 fps, p95 5.7 ms, none over 33 ms |
| Binary | 7.8 MB, excluding the WebView2 runtime already on Windows 11 |

### In progress

Nothing. M1 is complete apart from the open items in `docs/KNOWN_ISSUES.md`.

### Blockers

- Codex sign-in on this machine has expired, and only the user can renew it.

### Next steps

1. Close the verification gaps in `KNOWN_ISSUES.md`, starting with a real Codex turn and a real cloud chat.
2. Persistence: SQLite history for chats and sessions.
3. A pin for the panel, and a smaller compact window to recover GPU memory.
4. Multi-monitor and display-scale handling.
5. Observed sessions through opt-in hooks.
6. Desktop context engine, from foreground application metadata upward.
