# Security and privacy model

Scope is M2. Anything that reads more of the desktop must extend this before it is built.

## What the app touches

| Data | Handling |
|---|---|
| API keys | Windows Credential Manager only. No command returns one to the webview. Logged nowhere. |
| Chat text | Sent only to the provider the user picked. |
| Prompts to agents | Sent over stdin, so they never appear in a process list. |
| Microphone | Opens only on a click, only while the listening view is mounted. A dot shows while it is open. Levels only: audio is neither recorded nor sent. |
| Screen | Read only on request or in opt-in contextual mode, on this PC. Shared only from a preview the user approves. Frames are held in memory and dropped on send, discard or at once in contextual mode. |
| Excluded windows | Password managers, private browsing and sign-in windows can never be captured, whatever the user's own list says. Refused before any pixel is read. |
| Clipboard, keystrokes | Not read. |
| Mail and calendars | Read-only OAuth with minimum scopes. Read on this PC. Extracted events stay in a local SQLite file. Nothing here is sent to an AI provider. |
| OAuth tokens | Windows Credential Manager, never in SQLite. Disconnect removes the tokens and the events owned by that account. A booking seen in two accounts is one row, see `KNOWN_ISSUES.md`. |
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

**Local-only mode** is enforced in Rust on the resolved address, including custom endpoints. A hostname merely containing
"localhost" does not pass.

**The OAuth loopback listener** binds 127.0.0.1 on a random port for one sign-in, and checks `state` and PKCE.

**Screen text is untrusted.** Text read from the screen goes to an engine as data, but a model can be influenced by it. A
malicious web page on screen could carry instructions. Approvals stand between that and any action.

**Mail is untrusted.** Senders are not authenticated, so a forged message can create an event and a link. Links open only on
a click, only for http and https, and each button shows its real host. Extraction uses no model, so mail cannot instruct
anything.

## Credentials of other tools

Meridian detects agents from PATH and `--version` only. It reads no agent's config or credential files, and uses each
agent's own sign-in through its supported CLI.

## Before any public release

- Review the `open_project` and session commands against a hostile page.
- Sign binaries.
- Decide on an audit log for approvals.
- Never ship with `--remote-debugging-port`. It is used only by the live tests, through an environment variable.
