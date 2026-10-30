# Security and privacy model

Scope is M1. Later subsystems that read desktop content must extend this before they are built.

## What M1 touches

| Data | Handling |
|---|---|
| API keys | Windows Credential Manager only. No command returns one to the webview. Logged nowhere. |
| Chat text | Sent only to the provider the user picked. |
| Prompts to agents | Sent over stdin, so they never appear in a process list. |
| Microphone | Opens only on a click, only while the listening view is mounted. A dot shows while it is open. Levels only: audio is neither recorded nor sent. |
| Screen, clipboard, keystrokes, window titles | Not read. |
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

## Credentials of other tools

Meridian detects agents from PATH and `--version` only. It reads no agent's config or credential files, and uses each
agent's own sign-in through its supported CLI.

## Before any public release

- Review the `open_project` and session commands against a hostile page.
- Sign binaries.
- Remove the `window.__meridian` test hook from release builds.
- Decide on an audit log for approvals.
- Never ship with `--remote-debugging-port`. It is used only by the live tests, through an environment variable.
