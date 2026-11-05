# Known issues and limitations

Honest state of M4. "Not verified" means the code exists and has tests where noted, but the behaviour has not been seen
working against the real service.

## Acceptance criteria

The 20 criteria from the enhancement brief, as they stand.

| # | Criterion | State | Evidence |
|---|---|---|---|
| 1 | Island at top center | Done | Real app |
| 2 | Stays above other apps | Done | Real app; hides over fullscreen, not exercised |
| 3 | Fluid expand and collapse | Done | 180 fps, none over 33 ms |
| 4 | Claude Code selectable in chat | Done | Live |
| 5 | No separate Anthropic key | Done | Live, on a Max plan. See the licensing note |
| 6 | Sessions created, continued, managed | Done | Live. Chat and finished sessions now survive a restart, read-only |
| 7 | Analysis of the current screen | Done | Live: capture, OCR, and an image read by Claude Code |
| 8 | Identifies visible errors | Done | Live on a real terminal and a test window |
| 9 | Screen awareness pausable | Done | Settings, tray, tests |
| 10 | Media sessions detected | Done | Seen in the real app with JioSaavn really playing, with its title, artist and album art. Spotify, Apple Music and VLC not tried |
| 11 | Media controls | Done | Live: controls reached the session |
| 12 | Connect email accounts | Gmail done, through the Claude account | Live on 2026-11-01: a real question to the real assistant. The direct route is tested against canned servers and needs an app registration |
| 13 | Booking and delivery extraction | Done | Live from a pasted email, plus fixtures. Not from a real mailbox |
| 14 | Connect calendars | **Not verified** | Built like Gmail, but no calendar has been connected. Direct route as 12 |
| 15 | Meetings and dates on the island | Done, from local events | Live with a reminder. Not from a real calendar |
| 16 | Activity timeline | Done | Live and UI tests |
| 17 | Prioritized and deduplicated | Done | Unit tests on the engine and store, live reschedule |
| 18 | Permissions and disconnect | Done in code, with one edge case | Unit tests. Not with a real account. See below |
| 19 | No data sent without authorization | Done by design | One share path; no network code in `screen` |
| 20 | Existing features still work | Done | 518 Rust, 46 unit and 55 UI tests pass. Live claude, deny, cancel, engine, resume, activity and chat pass on the M3 code. Screen, vision and media were not rerun: this code did not change, and they would capture the desktop in use |

## Milestone 3 brief

| Request | State | Evidence |
|---|---|---|
| Reverse engineer TwoCode and compare | Done | `docs/research/TWOCODE_TEARDOWN.md`. Static only, the app was never run |
| macOS-style notch, not a pill | Done | Real app on this desktop, UI tests for shape and edge |
| Providers column under Settings, MCP vendors, animated results | Done, against a local server | 144 tests, 56 of them over real sockets, plus UI tests. **No real vendor account was used** |
| Gmail in that column | Shows connected through the Claude account. My day reads it when it opens, at most every half hour | Same state as criterion 12 |
| Rendering problems | Fixed the ones found. See below | Screenshots of every state, no console errors |
| Shippable to customers | Not yet. See Shipping | Installer built and tested: installs, runs, uninstalls cleanly, keeps settings |

**Rendering problems found and fixed.** Native blur lagged the webview during a morph. Two lines of text overlapped while
content changed, because exit and enter fades ran together. Text blurred on every change through a filter. The window's
layered flag was toggled on every pointer crossing. Popup menus had dark text on a dark list. Hover reacted to every passing
pointer. Tool names were capitalised. A button stretched across My day.

## Milestone 4 brief

| Request | State | Evidence |
|---|---|---|
| Design first, reviewed by the owner | Done | Claude Design canvas |
| Soft eyes, and a face picker that can grow | Done | Six faces, UI tests, unknown faces fall back |
| Music small, album and controls on click | Done | UI test on both sizes |
| Animated Claude icon while it works | Done, with our own spark | D34. The official logo needs Anthropic's permission |
| Flight countdown and time to landing | Done, from the schedule | 18 unit tests on the stages. **No real flight email tried** |
| Other live notifications | Parcels, meetings, tickets, focus timer | Unit tests |
| Browser sign-in, no keys | Reaches the real sign-in page for 15 services, plus Claude, ChatGPT, OpenRouter | **No real account has signed in through it.** Outlook and six others wait on registration. Gmail and Calendar connect through the Claude account |

**Designed but not built.** Food and cab tracking, because those apps publish no live position to a desktop. The 5-hour usage
ring, because it needs a status line script installed in Claude Code. Trains, because the extractor does not read them yet.

## Licensing: read before distributing

**The local speech engine contains GPL code.** Kokoro and Piper need espeak-ng to read plain text, and sherpa-onnx took it out in v2.0.0 to
become GPL-free, so the engine stays pinned at v1.13.8. Its DLL contains espeak-ng, which is GPL. It is a separate download, made only on
request, but it loads into the app's own process. That is fine for the owner's own use. Before giving the app to customers, take legal
advice, or move Kokoro and Piper to a lexicon or an outside process. See `docs/DECISIONS.md`, D51.

Chatting through Claude Code uses your own installed CLI and your own sign-in. Anthropic's terms do not permit third-party
developers to offer Claude.ai login in their own apps, or to route requests through Free, Pro or Max credentials on behalf
of their users. Using this yourself on your machine is the case this design serves. Giving it to other people is a
different one, and needs Anthropic's approval or an API-key path first. See `docs/DECISIONS.md`, D19. This is an engineering
reading, not legal advice.

**Following sessions is a separate case.** It only receives hook events from a CLI the customer runs themselves, and makes
no model request. That reading is also not legal advice, and it does not cover the Claude Code chat engine, which still
needs a decision before a public release. Removing that engine from a customer build is one line in `selectEngine`.

## Shipping to customers

What stands between this build and a stranger installing it. Only the owner can do these.

| Blocker | Why it matters |
|---|---|
| **Code-signing certificate** | Without one, SmartScreen warns on the installer, and customers cannot tell it from a tampered copy |
| **A signing key for updates** | Updates now come from the public GitHub releases with no sign-in, checked only against a checksum published beside them. Customers need a signed update. See `docs/DECISIONS.md`, D52 and D62 |
| **Name and bundle ID** | Meridian is a working title with no clearance, and `dev.meridian.companion` is a placeholder. Changing the ID later orphans settings and stored tokens |
| **Claude subscription decision** | See above |
| **Google verification** | `gmail.readonly` is a restricted scope. A published app needs Google's verification and a security assessment, which takes weeks. Until then Gmail needs each user's own registration |
| **Microsoft publisher verification** | Needed for a smooth consent screen outside your own tenant |
| **Privacy policy and terms** | Required by Google and by most vendor marketplaces |
| **Support and crash reports** | Crashes are logged locally. Nothing reaches you |

## Not verified end to end

| Area | State | To close it |
|---|---|---|
| All MCP providers | Discovery was checked anonymously against each vendor on 2026-10-30. No account was connected, so sign-in, tool names and result shapes are unproven. Tool preferences are educated guesses, and the user can pick another tool | Connect one |
| Terminal dialog while a request waits | Real Claude Code in print mode was followed and answered from the app. In an interactive terminal, the docs do not say if the dialog shows while the hook is held. At worst it is delayed up to 295 s | Run `claude` in a terminal with following on, and trigger a request |
| Gmail, Google Calendar, Outlook, Microsoft Calendar | No real account has been connected. OAuth and all four connectors are tested against canned responses, so real-world quirks may remain. | Follow `docs/development/CONNECTING_ACCOUNTS.md` |
| Codex full turn | Handshake, thread start and failure path ran for real. A successful turn, streaming, approvals and usage did not, because the sign-in here has expired. | Run `codex login`, then `node tests/live/e2e.mjs codex` |
| Cloud chat APIs | No live call was made to any cloud API. Adapters are tested against a real local socket. An OpenRouter key was added here, but it was not used, to avoid spending it. | Send a message |
| Ollama, LM Studio, llama.cpp | Not installed here. Tested through the real app against a stand-in server. | Run a real server |
| Local voices and hearing | The owner downloaded the engine and hearing through the app on 2026-10-31, and no crash was recorded. The engine is now v1.13.8, so it needs downloading again, at about 8 MB. Nobody has confirmed it works, because loading the downloaded DLL during development was refused by a safety check. Kokoro's speaker names are from memory | Press Ctrl Alt V and talk, or run `cargo test -p voice --test live_local -- --ignored` with `MERIDIAN_SPEECH_DIR` set |
| Cloud voices and hearing | ElevenLabs speaking and hearing are proved in the real app, in English and Hindi. OpenAI, Cartesia and Deepgram are written from their docs and tested on pure parts only | Add a key and talk |
| Talking with a real microphone | Worked for about 30 s in a dev build on 2026-10-31, including talking over a reply, but that was unplanned, and it is not confirmed who was speaking. The global key was held by the app, but only its event was sent in tests | Hold Ctrl Alt V and talk |
| Brightness and battery | Only a desktop was available, so neither has fired for real. Volume keys were proved on the installed app | Try on a laptop |
| Real media players | Tested with a silent session of its own. Spotify, browsers and VLC not tried, so artwork in particular is unproven. | Play something |
| Focus return after Esc | Implemented. The check is unreliable while someone else is using the machine. | Try it |
| Concurrent live agents | Multitask view is tested with sample data only. | Start two sessions |

## Notes: real limits

- **Not tried on a real call.** It was tested on a made-up call in English Windows voices. Speaker separation on real voices, and Hindi, are unmeasured.
- **A call leaves the PC.** Audio goes to the hearing service and the transcript to the AI chosen for Chat. Local only refuses both, so Notes do not work in it.
- **Hearing on this PC cannot do this.** It is English only and has no speakers, so Notes need ElevenLabs or Deepgram.
- **Cost.** Both recordings are billed in full, about $0.44 per hour of call at ElevenLabs' list price. A side with no sound is not sent.
- **Deepgram has never been run.** Its reply is parsed from documented examples.
- **No words while recording.** They would cost a second pass.
- **Summaries need Claude Code or an AI model.** With Codex chosen in Chat, the button says so.
- **The other side must play through the default output.** A call on a device that is not the Windows default is not heard, though a change of default mid-call is followed. DRM-protected sound is
  silent to loopback.
- **Others' voices through speakers.** An echo is dropped by comparing words, which is unmeasured. Headphones avoid it.
- **Your own assistant is recorded too** if it speaks during a call, because it plays through the same output.
- **Consent is the user's job.** The app reminds them. It cannot know the law where they are, and nothing tells the other people.

## Gmail and Calendar through Claude: real limits

- **Claude Code has to be signed in** to the Claude account that holds the connector, or the row says to connect it.
- **Only on request.** An answer takes 7 to 15 seconds and uses plan usage, about 0.11 USD equivalent for a broad mail search on 2026-11-01. So
  nothing polls and mail raises no alerts. My day reads Gmail when it opens, at most every half hour, which took 66 seconds for 11 messages.
- **My day gets text.** Claude copies messages as text, so booking details that sit only in a message's HTML are lost, and a direct sign-in
  finds more. The copies pass through a model, which is told to copy word for word; the extractor here still needs real identifiers.
- **Built on one version.** The server addresses are fixed in `google.rs`, and the flags and settings it depends on were proved on Claude Code
  2.1.316. If an address moves the row says not connected, which fails closed but says the wrong thing.
- **A link can open unasked** if a crafted email fools two models. See `docs/security/THREAT_MODEL.md`.

## Personal activity: real limits

- **Forged mail.** No sender check is done (no SPF or DKIM), so a spoofed email can create an event with a link. Every link
  button therefore shows its real host, and nothing opens without a click. Treat a link in an event as you would one in the
  email itself.
- **A booking seen in two accounts** is one row, owned by whichever wrote it last. Disconnecting one account can leave facts
  merged from it, or delete a row the other account also had. It comes back on the next sync of the other account only if
  that mail is still in the sync window.
- **Accuracy on real mail is unmeasured.** Extraction fixtures are hand-written, because no real mailbox was used.
- **A user correction** pins the edited fields only. A cancellation from the source still applies.
- **Outlook invites** arrive through the calendar, not mail, because Graph does not expose the `text/calendar` part.
- **Recurring events** in mail are not expanded. Series instances come from the calendar APIs.
- **After a calendar resync**, events deleted upstream during the gap stay until they age out.
- **Time zones.** 44 common Windows zones are mapped. Any other stays unzoned, and the event says no time zone was stated.

## Not tested

- The notch on a maximized app: it sits over the middle of a title bar or a browser's tab strip, and takes those clicks.
- A taskbar moved to the top of the screen: the island then hangs from the taskbar's lower edge.
- Multiple monitors. Selection and display-change handling are written, but only one display was available.
- Display scaling other than 100%. The hit-test maths has unit tests at 150%.
- Left and right placement on a real desktop.
- Hide when idle on a real desktop, including how easy the sliver is to reach.
- Sleep and resume.
- Windows 10.
- Battery saver.
- A fullscreen app in front. The hide logic is written, but it has not been exercised.
- Time-to-first-token overhead, and CPU over a full five minutes.
- Idle cost with contextual mode on, or with music playing. Measured idle only, with the mode off.

## Not built yet

- **Writing down speech with the Windows recognizer.** Left out on purpose. See `docs/DECISIONS.md`, D51. Wake words use its engine, fed the app's own sound, see D63.
- **Restored sessions are read-only.** Chat and finished sessions survive a restart, but a session's process does not, so it
  cannot be continued. Quitting ends every agent the app started. Agents in your own terminal carry on.
- **Following Codex.** Claude Code only.
- **A session stopped with Esc looks busy** until its next hook, or 30 minutes of silence, because Claude Code sends no event
  for a user interrupt.
- **A company policy of `allowedHttpHookUrls`** can block following.
- **A renderer crash** has no automatic recovery. Quit from the tray and start again.
- **Workflows, agent collaboration, output comparison.**
- **Application profiles, project context, memory.**
- **LLM extraction.** Email extraction is structured data and rules only. It will miss what they miss, by design.
- **Calendar writes.** Read-only. Creating or changing events is not implemented.
- **UI Automation and foreground app profiles.** Awareness is window text by OCR, not app-specific.
- **Per-app volume** and the audio visualizer.
- **Dragging the island.** Position is left, center or right, on a chosen display.
- **Codex with images.** It receives the text only, and the preview says so.
- **Region capture** works by cropping a full capture, not by a live overlay.
- **Chat niceties.** Plain text, no Markdown. Files can be referenced to agents, not attached to API chats.
- **Gemini CLI, Aider and Continue adapters.**

## Behaviour to be aware of

- After the assistant reads mail, the calendar, call notes or the day's events, it asks before opening a website, searching or opening a
  file, and cannot use web fetch or web search for half an hour. That is on purpose, D69.
- Allowing a command by voice needs the word the island shows, not yes. No is still enough to deny.
- Local-only mode now stops Claude Code and Codex chats and the assistant, as well as cloud providers.
- The terminal button finds the window Claude Code runs in by walking up its parent processes. A console Windows handed to Windows Terminal
  after it started has the terminal outside that chain, so no window is found, and it does not switch to the right tab. Any window of the
  same terminal app counts as "in front" for staying quiet.
- Quieting the room mutes the apps playing at the moment you start talking, on the default output only. An app that starts playing during
  a conversation is not muted, and a call in a browser (Meet in Chrome) is not recognised as a call.
- An MSI install updates through msiexec, which asks for administrator rights after the app has quit. If that is declined, nothing installs
  and Meridian has to be opened again by hand.
- A release built from this code needs `npm ci --ignore-scripts` and `cargo --locked` to pass in CI. Not yet seen on a real release run.

- Wake words have to be taught. Words in English letters are also heard by Windows' engine in any voice, and the rest only in the voices
  that taught them. Speech that sounds close can still wake it.
- An approval answered in the terminal clears from the island when the tool finishes, or at once if Claude Code hangs up its hook, so a long command can leave it showing until then.

- The assistant's actions work with Claude Code as the AI. API models and Codex can chat but have no tool loop yet, so they cannot act.

- Talking needs something to hear with. Hearing defaults to this PC, which needs a download of about 65 MB, or an ElevenLabs or Deepgram
  key. Until one is set, the microphone button opens Settings, Voice and says why. Speaking needs neither, because the Windows voice is
  always there.
- A whole-screen capture is refused while an excluded window is anywhere on that display, even behind other windows, and the error names the app. A window with `login` in its title is refused too, which includes a file called `login.rs`.
- Local-only mode also stops mail and calendar sync, and update checks.
- Previews of island states end after 8 seconds, or when the panel opens or closes, and they always leave the panel closed.
- Any animation redraws the whole 860 by 660 window at the display's refresh rate. On a 180 Hz display the working state costs about 39% of one core, and the drowsy face about 16% for its 75 seconds. Stepping the working animations to 60 a second halved that in a test, but it drops their easing, so it needs a design decision. A smaller window while collapsed is the real fix.
- Finished events and the reminder log are removed after 90 days.
- Cloud hearing runs at the end of a turn, so words do not appear while talking. Only local hearing shows them live.
- What is new on the Updates page is the release's notes, which still open with the install instructions from `release.yml`.
- A portable copy that updates installs the normal version, then restarts the portable one, which is still the old version.
- Windows reports screen brightness only for screens it controls, which means a laptop's own. A desktop monitor has no brightness to
  show, unless it is read over its cable, which is slow and not supported by every monitor.

- Questions and plans answered on the island follow Anthropic's documented format and have unit tests, but have not been tried
  against a live Claude Code session. Claude Code offers neither tool without a terminal, so it needs one real try by hand.
- A player that publishes nothing and is not named in `PLAYERS` in `crates/media/src/audio.rs` is not detected. Store apps do not
  need listing. Others do.
- Claude Code in another terminal cannot be matched to a Store app's sound if the app has no media session at all. It then shows
  nothing, which is the safe failure.
- A player that sends no timeline, such as JioSaavn, has no progress bar.

- Hide when idle shrinks the island to a sliver with no face. It has turned on twice in the owner's settings file with no known
  cause, and the second time was saved at 01:01 on 2026-10-31. Nothing in the code or tests sets it by itself, so a click is the
  likely cause, but this is not proven. If it comes back unasked, it needs looking at.
- Click-away closes the panel, so it cannot stay open beside your work.
- Each Claude Code session keeps a process of about 300 MB for 3 minutes after its last turn, so follow-ups are fast. Agents
  were seen to exit within seconds when the app was force-killed with idle sessions. A turn in progress was not tried.
- Contextual mode runs OCR on the active window each interval. It is off by default.
- Windows OCR splits file names, reading `main.tf` as `main. tf`. Detection allows for this. Shared text keeps what was read.
- The stream-json interrupt is the message the Agent SDK uses, and is not separately documented for direct use. If it stops
  working, a stop falls back to ending the process after 4 s, and the interrupted turn is not recorded.
- A resumed general conversation keeps its restrictions. Project mode runs with your own Claude Code permissions.
- Claude Code in print mode loads hooks and MCP servers from the project folder with no trust prompt. The new-session form
  says so. This is upstream behaviour.
- `max_tokens` is fixed at 64,000 for Anthropic. A model with a lower ceiling would return an error.
- Google refresh tokens last 7 days while your Google app is in Testing, so expect to reconnect weekly.
- `gpu-process` holds 75 to 100 MB, partly for the mostly empty 860 by 660 surface.
- GitHub reports one moderate alert for `glib`. It is a Linux-only dependency of Tauri, never compiled on Windows, and the
  fix has to come from upstream.

## Unexplained

- **Two test failures not reproduced.** "Island shows working" failed once on a deny run. "The conversation survives an
  interrupt" failed once, then passed seven times in a row, including mid-stream stops. No cause was found for either, so
  neither is called fixed.