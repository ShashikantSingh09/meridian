# Security and privacy model

Scope is M3. Anything that reads more of the desktop must extend this before it is built.

## What the app touches

| Data | Handling |
|---|---|
| API keys | Windows Credential Manager only. No command returns one to the webview. Logged nowhere. |
| Chat text | Sent only to the provider the user picked. |
| Prompts to agents | Sent over stdin, so they never appear in a process list. |
| Microphone | Opens on a click or while the voice key is used. It stays open only if the user turns on wake words, which are off by default, and then the island shows a dot for as long as it is open. That listening happens on this PC, by comparing the chosen microphone with a pattern of the user's own voice, and by Windows' own speech engine running inside the app on the same sound. The sound is compared and dropped, apart from the last three seconds held in memory to hand a command said with the name to the conversation, a lesson's recordings stay in memory until the pattern is made, and nothing is sent until the word is found. After that, what is said goes to the hearing service, including anything said by mistake after a false wake. In a conversation the island shows Listening, with a stop button. Audio stays in memory and is never saved. With local hearing it stays on this PC. With a cloud service, the recorded turn is sent to that service at the end of the turn. Test and repair also opens it for under a second, to hear it, while that page checks. |
| Calls | On a click, or when the user asks the assistant in their own words, by voice or in chat; never by itself. After the assistant has read mail, the calendar, call notes or the day's events, a request to record waits for a click on the island, so words in those cannot start it. The page opens the microphone the same way for both. The island shows a red dot and a clock for as long as it records, over every other view. Microphone and PC sound go to files on this PC, then to the hearing service the user chose, then the audio is deleted. Local only refuses it. Pausing all monitoring stops it. It stops by itself after four hours. |
| Assistant actions | Tools run on a loopback server with a random token in the path, reachable only by this app's own runs, which refuses any request with an Origin. Opening things, media, volume and reminders run without asking, until the assistant reads other people's words: for half an hour after mail, the calendar, call notes, Knowledge pages or the day's events, opening a website, searching and opening a file ask on the island first, and the CLI's own WebFetch and WebSearch are refused. Reading the screen, starting an agent, commands and edits always ask first. The open tool opens only documents, pictures, music and video, never a program or a path on another computer. |
| Voice keys | Windows Credential Manager, like API keys. No command returns one to the webview. |
| Spoken replies | With a cloud voice, the reply text goes to that service. Local only blocks every cloud voice and cloud hearing. |
| Screen | Read only on request or in opt-in contextual mode, on this PC. Shared only from a preview the user approves. Frames are held in memory and dropped on send, discard or at once in contextual mode. |
| Excluded windows | Password managers, private browsing and sign-in windows can never be captured, whatever the user's own list says. Every visible window in the captured area is checked, and the capture is refused before any pixel is read. |
| Clipboard, keystrokes | Not read. Write here puts text on the clipboard only to paste it into the box the user is in, after saving the clipboard and putting it back, marked so Win+V history and cloud clipboard skip it. It sends only Ctrl+A, Ctrl+V, Ctrl+Z and plain characters, never Enter or Tab, and polls for held keys with no hook. |
| Filling boxes in other apps | Write here only, on Ctrl Alt F (a registered shortcut, never a hook), the island's button, or the assistant when the user asks; Fill this form is not built yet. Up to 6,000 characters of the page before the box go to the AI as data. Hover checks read the app, title, site and kind of box, never its value. Esc is registered only while a reply is on its way. Nothing is ever sent or submitted. Copy the reply is an ordinary copy, on a click. Rust refuses password, card, CVV, expiry, one-time code, CAPTCHA, consent, upload and button boxes, and refuses Meridian, terminals, Windows Settings, Windows Security, password managers, private windows and a browser's own pages, whatever the AI says. Banks, tax and government sites ask every time. A box's value is cleared before the AI sees a refused box, and values are never logged. |
| Answers into the user's box | A question asked on the island can be written into the box that had the cursor when the island was pointed at, without a further click, only in a place the user allowed, with Undo. It is never sent. The assistant's `write_here` waits for a click once it has read other people's words. |
| Cards in My Day | Once a day after 6 am, Gmail and Calendar are read through the user's Claude account in reading-only runs. `cards.json` keeps the words of mail someone is waiting on (up to 3,000 characters a card) only while its card exists, and the drafts. Drafts send that mail, Knowledge lines about the sender and the style lines to the AI chosen for Chat, fenced as content; written ahead only on the Claude plan or an AI on this PC. The home city is compared on this PC. Links are built only from plain ids, for Gmail and Google Calendar; plan sites are a fixed list. Local only stops it. |
| Your details | A JSON file in the app's local folder, not synced or backed up. PAN, Aadhaar and passport are off by default, kept in Credential Manager, removed when turned off, and come back from Rust only as ask-first. The AI is given key names, never values. Show returns a whole ID number to the webview, never to the AI. |
| Knowledge pages | Plain Markdown in Documents\Meridian\Knowledge, which any program on the PC can read. Every source is off until turned on. New items go to the engine chosen for Chat, a cloud AI unless local only is on, wrapped as content and never as instructions; Gmail and Calendar are skipped in local only. The assistant reads them through `my_knowledge`, which counts as reading other people's words. Idle is read from Windows' last-input time, with no hook. |
| Sounds like you | Sent mail is read through the user's Claude account in a reading-only run. Only short facts come back, at most 60 characters, quotes removed, and only the merged lines are kept, in a local file. The lines are given to the AI as a description of how the user writes, never as instructions. Local only refuses it. |
| Mail and calendars | Read-only OAuth with minimum scopes. Read on this PC. Extracted events stay in a local SQLite file. Nothing here is sent to an AI provider. |
| Mail and calendars through Claude | With no registered Google app, the user connects both in their own Claude account, which holds the token. The app never sees it and does not look for it. Read only when the user asks, in a run of Claude Code with one server, reading tools only, no shell, files or web, no hooks and no session history. What is read goes through Claude, and the answer goes to the engine the assistant uses. Local only refuses it. |
| Notes | Plain JSON in the app's local folder, with no encryption beyond the user's account, like Claude Code's own transcripts. A transcript goes to the engine chosen for Chat for the summary, in a run with no tools, no hooks and no history. The assistant reads them only through `my_notes`. |
| OAuth tokens | Windows Credential Manager, never in SQLite. Disconnect removes the tokens and the events owned by that account. A booking seen in two accounts is one row, see `KNOWN_ISSUES.md`. |
| Providers over MCP | Read-only tools only, chosen by annotation and name, with write verbs refused whatever the server claims. What a service returns stays in memory, is drawn as text, and is never sent to a model. Tokens stay in Credential Manager. |
| Chat and session history | Plain text in the webview's storage on this PC, like Claude Code's own transcripts. Images are never kept. Privacy can clear it. |
| Typed answers | A question from Claude Code can be answered from the island's box: not empty, at most 2000 characters, AskUserQuestion only, sent only when the user presses Enter. The island takes the keyboard only while the box is in use. |
| Hook events from Claude Code | Followed in memory. A short label, the first line of a prompt, the lines of an edit, the end of a command's output, a plan and a question's options reach the interface, to be shown as they happen. Sessions followed this way are never saved to history. |
| Claude Code settings file | Changed only when the user turns on following, or presses Fix in Test and repair, and both show the exact lines first. One backup is kept, invalid JSON is refused, and turning it off removes exactly our entries. Test and repair only reads it and known projects' own settings files. |
| Crash log | Local. Credentials and URL queries are removed before writing. |
| Agent sign-in | Handled entirely by the CLI. The app reads only its status, and drops the account's email and organization. |
| Telemetry | None. |

## Trust boundaries

**The webview is treated as untrusted.** It loads only bundled content, under a strict content security policy. A navigation guard refuses
any other address, and the page cancels dropped files and links, so nothing else can load where the app's commands are reachable. A
compromised page could start an agent in a folder or spend tokens, but cannot read a key, because no command exposes one.
The capability file grants only what the page needs. Other webview permissions, such as camera and location, are denied by
default in `island::restrict_permissions`.

**The approval server** listens on 127.0.0.1 only, on a random port. Each session has a random 128-bit token in its path,
and an unknown token gets a 404 and raises nothing on screen. The token appears in the agent's command line, which any
process of the same user can read. Same-user processes are outside this model, as they could equally drive the CLI directly.

**Agents run as the user, with the user's own settings.** Meridian does not sandbox them. The app never approves anything
on its own: a request waits for a click, and if nobody answers within 30 minutes the agent's own rule applies. A request whose one line
leaves anything out carries the whole of it, and Allow stays off until it has been opened. By voice, allowing needs a word picked for that
request, so a yes from a video or another person cannot allow anything. The assistant's Start an agent names the folder and that the agent
gets full access, and is not offered for a folder the user never worked in. Project
hooks load without a trust prompt in print mode, so the new-session form warns about this.

**Local-only mode** also stops Claude Code and Codex sessions, which send what they are given to their makers, and mail and calendar sync, and it is enforced in Rust on the resolved address, including custom endpoints. A hostname merely containing
"localhost" does not pass.

**The OAuth loopback listener** binds 127.0.0.1 on a random port for one sign-in, and checks `state` and PKCE.

**Screen text is untrusted.** Text read from the screen goes to an engine as data, but a model can be influenced by it. A
malicious web page on screen could carry instructions. Approvals stand between that and any action.

**The watcher** listens on 127.0.0.1 only, and accepts only `POST /meridian-hook` with the right token, compared in constant
time. A request with an `Origin` header is refused, so a web page cannot reach it. The token sits in the user's Claude Code
settings file in clear, which any process of the same user can read. Same-user processes are outside this model. A closed app
never blocks Claude Code, because a failed http hook is not an error to it. The hooks are taken out when the app quits and put back when it
starts, and a new port comes with a new token, so another account on the PC cannot answer on that address while the app is closed. A
crash leaves them in place until the next start.

**MCP servers are untrusted.** A server chooses its metadata, tool names, annotations and results. Every URL taken from one
must be https and must not be a private or loopback address, so a server cannot point the app at a local service.
Authorization needs PKCE S256, a matching issuer, and a `resource` that describes the same server, or sign-in is refused. The
last one stops a server borrowing another service's sign-in to receive its token. A hostile name can trick the read-only rule only
into calling a read-sounding tool, which a server could equally do anything with. A token is only as narrow as the vendor's
scopes. The DNS-rebinding case is not covered: a public name resolving to a private address passes the check.

**Mail is untrusted.** Senders are not authenticated, so a forged message can create an event and a link. Links open only on
a click, only for http and https, and each button shows its real host. Direct extraction uses no model, so that mail cannot instruct
anything.

**Mail read through Claude does reach a model**, so there it can try to instruct one. That run loads one server, can run only tools named
get, list, search or find, refuses write verbs by name even if the user has allowed them everywhere, and has nothing else to reach for. Its
one output is a reply. The assistant gets that reply, is told to report it and never act on it, and its commands still ask on the island.
Once mail has been read, the assistant's ways of sending something out ask first, and the CLI's web tools are refused, for half an hour.
What remains: an approved link can still carry what the reply held, which the island shows before the click. Reading verbs are trusted by name, as with Providers over MCP. Claude's own page calls its Calendar connector
read-only, and the Gmail connector offers send and delete, so the rule here does not rest on that wording.

**A call is other people's words.** Someone on a call could say something meant for the AI. The summary run has no tools, so the most it can do is write a bad summary, and what it sends back can only
fill in a note's fields, as text. The assistant is told to report notes and never act on them, and after reading one its ways of sending something out ask first, as with mail.

**Downloaded speech packs are code the app loads.** The local engine is a DLL from sherpa-onnx's releases, loaded into the app's own
process. It downloads only when asked for, over TLS, and must match a SHA-256 pinned in the source, so a changed release fails instead of
running. This trusts that the pinned build was clean, and the app does not sign or sandbox it. A same-user process could replace the
unpacked DLL, which is outside this model. Packs are unpacked with Windows' own `tar`.

**Updates run an installer.** An update is a program run with the user's rights, and only the version the user was shown. It comes over
HTTPS from the repository's public GitHub releases, or through `gh` if the repository is private, into a new folder of the app's own, and
must match the release's `SHA256SUMS.txt`, checked in memory before the file is written. Windows' own tools run by full path. Both come from the same
place, so the checksum proves the download is whole and not who made it. Anyone able to publish to the repository can therefore reach
every PC that updates, and with the repository public that is every installed copy, each of which is told about the release. Each still
needs its user's click. Customers need a signed update, see `docs/DECISIONS.md`, D52 and D62.

**The hook token stays out of the webview.** The preview of what following changes in the Claude Code settings file reads only the `hooks` section, with every header value hidden, in both directions.

## Credentials of other tools

Meridian detects agents from PATH and `--version` only. It reads no agent's config or credential files, and uses each
agent's own sign-in through its supported CLI.

## Before any public release

- Review the `open_project` and session commands against a hostile page.
- Sign binaries. Until then SmartScreen warns customers, and the installer cannot be told from a tampered one.
- Decide on an audit log for approvals.
- Never ship with `--remote-debugging-port`. It is used only by the live tests, through an environment variable.
