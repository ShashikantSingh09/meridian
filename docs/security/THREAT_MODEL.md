# Security and privacy model

Scope is M3. Anything that reads more of the desktop must extend this before it is built.

## What the app touches

| Data | Handling |
|---|---|
| API keys | Windows Credential Manager only. No command returns one to the webview. Logged nowhere. |
| Chat text | Sent only to the provider the user picked. |
| Prompts to agents | Sent over stdin, so they never appear in a process list. |
| Microphone | Opens on a click or while the voice key is used. It stays open only if the user turns on wake words, which are off by default, and then the island shows a dot for as long as it is open. That listening happens on this PC, in the Windows recognizer, against a fixed list, and nothing is kept or sent until a phrase is heard. In a conversation the island shows Listening, with a stop button. Audio stays in memory and is never saved. With local hearing it stays on this PC. With a cloud service, the recorded turn is sent to that service at the end of the turn. |
| Voice keys | Windows Credential Manager, like API keys. No command returns one to the webview. |
| Spoken replies | With a cloud voice, the reply text goes to that service. Local only blocks every cloud voice and cloud hearing. |
| Screen | Read only on request or in opt-in contextual mode, on this PC. Shared only from a preview the user approves. Frames are held in memory and dropped on send, discard or at once in contextual mode. |
| Excluded windows | Password managers, private browsing and sign-in windows can never be captured, whatever the user's own list says. Every visible window in the captured area is checked, and the capture is refused before any pixel is read. |
| Clipboard, keystrokes | Not read. |
| Mail and calendars | Read-only OAuth with minimum scopes. Read on this PC. Extracted events stay in a local SQLite file. Nothing here is sent to an AI provider. |
| OAuth tokens | Windows Credential Manager, never in SQLite. Disconnect removes the tokens and the events owned by that account. A booking seen in two accounts is one row, see `KNOWN_ISSUES.md`. |
| Providers over MCP | Read-only tools only, chosen by annotation and name, with write verbs refused whatever the server claims. What a service returns stays in memory, is drawn as text, and is never sent to a model. Tokens stay in Credential Manager. |
| Chat and session history | Plain text in the webview's storage on this PC, like Claude Code's own transcripts. Images are never kept. Privacy can clear it. |
| Hook events from Claude Code | Followed in memory. A short label, the first line of a prompt, the lines of an edit, the end of a command's output, a plan and a question's options reach the interface, to be shown as they happen. Sessions followed this way are never saved to history. |
| Claude Code settings file | Changed only when the user turns on following. One backup is kept, invalid JSON is refused, and turning it off removes exactly our entries. |
| Crash log | Local. Credentials and URL queries are removed before writing. |
| Agent sign-in | Handled entirely by the CLI. The app reads only its status, and drops the account's email and organization. |
| Telemetry | None. |

## Trust boundaries

**The webview is treated as untrusted.** It loads only bundled content, under a strict content security policy. A
compromised page could start an agent in a folder or spend tokens, but cannot read a key, because no command exposes one.
The capability file grants only what the page needs. Other webview permissions, such as camera and location, are denied by
default in `island::restrict_permissions`.

**The approval server** listens on 127.0.0.1 only, on a random port. Each session has a random 128-bit token in its path,
and an unknown token gets a 404 and raises nothing on screen. The token appears in the agent's command line, which any
process of the same user can read. Same-user processes are outside this model, as they could equally drive the CLI directly.

**Agents run as the user, with the user's own settings.** Meridian does not sandbox them. The app never approves anything
on its own: a request waits for a click, and if nobody answers within 30 minutes the agent's own rule applies. Project
hooks load without a trust prompt in print mode, so the new-session form warns about this.

**Local-only mode** also stops mail and calendar sync, and it is enforced in Rust on the resolved address, including custom endpoints. A hostname merely containing
"localhost" does not pass.

**The OAuth loopback listener** binds 127.0.0.1 on a random port for one sign-in, and checks `state` and PKCE.

**Screen text is untrusted.** Text read from the screen goes to an engine as data, but a model can be influenced by it. A
malicious web page on screen could carry instructions. Approvals stand between that and any action.

**The watcher** listens on 127.0.0.1 only, and accepts only `POST /meridian-hook` with the right token, compared in constant
time. A request with an `Origin` header is refused, so a web page cannot reach it. The token sits in the user's Claude Code
settings file in clear, which any process of the same user can read. Same-user processes are outside this model. A closed app
never blocks Claude Code, because a failed http hook is not an error to it.

**MCP servers are untrusted.** A server chooses its metadata, tool names, annotations and results. Every URL taken from one
must be https and must not be a private or loopback address, so a server cannot point the app at a local service.
Authorization needs PKCE S256, a matching issuer, and a `resource` that describes the same server, or sign-in is refused. The
last one stops a server borrowing another service's sign-in to receive its token. A hostile name can trick the read-only rule only
into calling a read-sounding tool, which a server could equally do anything with. A token is only as narrow as the vendor's
scopes. The DNS-rebinding case is not covered: a public name resolving to a private address passes the check.

**Mail is untrusted.** Senders are not authenticated, so a forged message can create an event and a link. Links open only on
a click, only for http and https, and each button shows its real host. Extraction uses no model, so mail cannot instruct
anything.

**Downloaded speech packs are code the app loads.** The local engine is a DLL from sherpa-onnx's releases, loaded into the app's own
process. It downloads only when asked for, over TLS, and must match a SHA-256 pinned in the source, so a changed release fails instead of
running. This trusts that the pinned build was clean, and the app does not sign or sandbox it. A same-user process could replace the
unpacked DLL, which is outside this model. Packs are unpacked with Windows' own `tar`.

**Updates run an installer.** An update is a program run with the user's rights. It comes through `gh` from a private repository, and
must match the release's `SHA256SUMS.txt`. Both come from the same place, so the checksum proves the download is whole and not who made
it. Anyone able to publish to the repository can therefore reach every PC that updates. This is acceptable for one owner. Customers need
a signed update, see `docs/DECISIONS.md`, D52.

**The hook token stays out of the webview.** The preview of what following changes in the Claude Code settings file reads only the `hooks` section, with every header value hidden, in both directions.

## Credentials of other tools

Meridian detects agents from PATH and `--version` only. It reads no agent's config or credential files, and uses each
agent's own sign-in through its supported CLI.

## Before any public release

- Review the `open_project` and session commands against a hostile page.
- Sign binaries. Until then SmartScreen warns customers, and the installer cannot be told from a tampered one.
- Decide on an audit log for approvals.
- Never ship with `--remote-debugging-port`. It is used only by the live tests, through an environment variable.
