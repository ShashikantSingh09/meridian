# Known issues and limitations

Honest state of M2. "Not verified" means the code exists and has tests where noted, but the behaviour has not been seen
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
| 6 | Sessions created, continued, managed | Done, within a run | Live. Lost on restart |
| 7 | Analysis of the current screen | Done | Live: capture, OCR, and an image read by Claude Code |
| 8 | Identifies visible errors | Done | Live on a real terminal and a test window |
| 9 | Screen awareness pausable | Done | Settings, tray, tests |
| 10 | Media sessions detected | Done | Live, with a silent session. No real player tried |
| 11 | Media controls | Done | Live: controls reached the session |
| 12 | Connect email accounts | **Not verified** | Tested against canned servers. Needs your app registration |
| 13 | Booking and delivery extraction | Done | Live from a pasted email, plus fixtures. Not from a real mailbox |
| 14 | Connect calendars | **Not verified** | As 12 |
| 15 | Meetings and dates on the island | Done, from local events | Live with a reminder. Not from a real calendar |
| 16 | Activity timeline | Done | Live and UI tests |
| 17 | Prioritized and deduplicated | Done | Unit tests on the engine and store, live reschedule |
| 18 | Permissions and disconnect | Done in code, with one edge case | Unit tests. Not with a real account. See below |
| 19 | No data sent without authorization | Done by design | One share path; no network code in `screen` |
| 20 | Existing features still work | Done | 296 Rust, 20 unit and 31 UI tests, and every live check pass on the final build |

## Licensing: read before distributing

Chatting through Claude Code uses your own installed CLI and your own sign-in. Anthropic's terms do not permit third-party
developers to offer Claude.ai login in their own apps, or to route requests through Free, Pro or Max credentials on behalf
of their users. Using this yourself on your machine is the case this design serves. Giving it to other people is a
different one, and needs Anthropic's approval or an API-key path first. See `docs/DECISIONS.md`, D19. This is an engineering
reading, not legal advice.

## Not verified end to end

| Area | State | To close it |
|---|---|---|
| Gmail, Google Calendar, Outlook, Microsoft Calendar | No real account has been connected. OAuth and all four connectors are tested against canned responses, so real-world quirks may remain. | Follow `docs/development/CONNECTING_ACCOUNTS.md` |
| Codex full turn | Handshake, thread start and failure path ran for real. A successful turn, streaming, approvals and usage did not, because the sign-in here has expired. | Run `codex login`, then `node tests/live/e2e.mjs codex` |
| Cloud chat APIs | No live call was made to any cloud API. Adapters are tested against a real local socket. An OpenRouter key was added here, but it was not used, to avoid spending it. | Send a message |
| Ollama, LM Studio, llama.cpp | Not installed here. Tested through the real app against a stand-in server. | Run a real server |
| Real media players | Tested with a silent session of its own. Spotify, browsers and VLC not tried, so artwork in particular is unproven. | Play something |
| Focus return after Esc | Implemented. The check is unreliable while someone else is using the machine. | Try it |
| Concurrent live agents | Multitask view is tested with sample data only. | Start two sessions |

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

- Multiple monitors. Selection and display-change handling are written, but only one display was available.
- Display scaling other than 100%. The hit-test maths has unit tests at 150%.
- Left and right placement on a real desktop.
- Hide when idle on a real desktop, including how easy the sliver is to reach.
- Sleep and resume.
- Windows 10, where only the tinted fallback is expected to work.
- Transparency effects turned off, and battery saver.
- A fullscreen app in front. The hide logic is written, but it has not been exercised.
- Time-to-first-token overhead, and CPU over a full five minutes.
- Idle cost with contextual mode on, or with music playing. Measured idle only, with the mode off.

## Not built yet

- **Voice.** The listening state shows the real microphone level. There is no speech to text, text to speech, wake word or
  voice command.
- **Sessions and chats do not survive a restart.** Activity events do, in SQLite. Quitting ends every running agent.
- **Sessions started outside the app.** Agents in your own terminal do not appear.
- **Workflows, agent collaboration, output comparison.**
- **Application profiles, project context, memory.**
- **Installer, auto-update, code signing.** Only a binary has been built.
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