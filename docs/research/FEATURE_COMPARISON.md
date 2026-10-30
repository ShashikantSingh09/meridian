# Feature Comparison

Date: 2026-10-30. This compares the studied products with the Meridian target. Coucou, Glint and
EchoIsland entries come from source code and their READMEs. TwoCode entries come from its website and
installer. Agent Island entries come only from third-party listings, because its repository could not be
reached through the GitHub API (404), so those entries are unconfirmed.

Legend: **Yes** means present, **Partial** means limited, **No** means absent, **?** means unknown. A **No**
reflects the sources that were read, not exhaustive testing. For TwoCode it means the website does not mention it.

## Positioning

| Project | Licence | Platform | Stack | Focus |
|---|---|---|---|---|
| TwoCode | Proprietary | Windows | Electron layout (inferred) | Agent status island with a mascot |
| Coucou | MIT code, reserved assets | macOS, Windows, Linux, iOS, Android | Swift; Tauri on Windows | Agent status plus many integrations |
| Glint | MIT | Windows | Tauri, React, Tailwind | Compact agent status overlay |
| EchoIsland | MIT | Windows first, macOS in progress | Tauri host, Direct2D island | Lightweight session hub |
| Agent Island | MIT (listings) | Windows, others | WPF on Windows (listings) | Status and usage reports |
| Meridian | To be decided | Windows first | Tauri 2, React, Rust | Universal AI companion and command center |

## Interface

| Capability | TwoCode | Coucou | Glint | EchoIsland | Meridian target |
|---|---|---|---|---|---|
| Floating island or pill | Yes | Yes | Yes, in a corner | Yes | Yes, M1 |
| Expand and collapse morphing | ? | Yes | Partial, hover card | Yes | Yes, M1 |
| Real desktop blur behind the island | ? | No | No | No | Spike, CSS fallback in M1 |
| Mascot | Robo | Mochi | No | Mascot poses in renderer | No, the Meridian Line |
| Reduced-motion support | ? | Not found | Not checked | Not checked | Yes, M1 |
| Light and dark themes | ? | ? | ? | ? | Dark in M1, light later |
| Multiple monitors | ? | Yes | Primary monitor | ? | Yes, M1 basic |
| Survives display scaling mismatch | ? | Yes, zoom correction | ? | DPI module exists | Yes, M1 |
| Never steals focus | ? | Yes | ? | Yes, passive updates | Yes, M1 |

## Agent support

| Capability | TwoCode | Coucou | Glint | EchoIsland | Meridian target |
|---|---|---|---|---|---|
| Claude Code monitoring | Yes | Yes, hooks | Yes, hooks | Yes, hooks and scan | Yes, managed in M1, hooks in M2 |
| Codex monitoring | Yes | Yes, hooks | Yes, hooks | Partial on Windows | Yes, app-server in M1 |
| Other coding agents | No | Many | Cursor | OpenClaw | Gemini CLI and Aider in M2 |
| Allow or deny from the island | Yes | Four agents | No | Pending queues exist | Yes, M1 where supported |
| Start a session from the app | ? | No | No | No | Yes, M1 |
| Send follow-up instructions | ? | Partial, answers questions | No | Partial | Yes, M1 |
| Cancel a running turn | ? | No | No | ? | Yes, M1 |
| Concurrent managed sessions | ? | Monitors many | Monitors many | Monitors many | Yes, M1 |
| Compare agent outputs | No | No | No | No | M2 |
| Controlled agent workflows | No | No | No | No | M5 |
| Usage and cost reporting | ? | Yes, plan usage | No | ? | Where agents report it |

The strongest gap in the field is control. Every studied project is an observer of sessions that the user
started elsewhere. None of them acts as a command center that starts, instructs and cancels agents across
vendors, and that is the clearest place for Meridian to stand apart.

## AI providers

| Capability | TwoCode | Coucou | Glint | EchoIsland | Meridian target |
|---|---|---|---|---|---|
| Direct model chat | Partial, Robo questions | Yes | No | No | Yes, M1 |
| Anthropic native | ? | Yes | No | No | Yes, M1 |
| OpenAI and compatible endpoints | ? | Yes | No | No | Yes, M1 |
| OpenRouter | ? | Yes | No | No | Yes, M1, via compatible client |
| Groq, Together, Mistral, xAI, DeepSeek | ? | Via custom server | No | No | Yes, M1, via compatible client |
| Ollama and LM Studio | ? | Yes | No | No | Yes, M1 |
| Local endpoint discovery | ? | Connection check | No | No | Yes, M1 |
| Local-only mode | ? | Partial | Not applicable | Not applicable | Yes, M1 setting |
| Providers advertise capabilities | ? | Partial | Not applicable | Not applicable | Yes, M1 |

## Context, voice and workspace

| Capability | TwoCode | Coucou | Glint | EchoIsland | Meridian target |
|---|---|---|---|---|---|
| Foreground app awareness | Partial, drag onto window | No | No | No | M3 |
| Proactive suggestions | No | No | No | No | M3 |
| Screen questions | Yes, manual | Dropped file context | No | No | M3, on demand |
| Push to talk and dictation | No | Yes | No | No | M4 |
| Wake word | No | Yes | No | No | M4, opt-in |
| Text to speech | No | Yes | No | No | M4 |
| Persistent history | Yes | Partial | Session logs | Persistence crate | M2 |
| Project memory and profiles | No | No | No | No | M4 |
| Privacy dashboard | No | No | No | No | M3 |

## Privacy and distribution

| Capability | TwoCode | Coucou | Glint | EchoIsland | Meridian target |
|---|---|---|---|---|---|
| Keys in a credential store | ? | Yes | Not applicable | Not applicable | Yes, M1 |
| Telemetry | Optional statistics | None, by rule | ? | ? | None by default |
| Backup and diff before config edits | ? | Yes | Backup | ? | Yes, M2 hooks |
| Signed Windows installer | No | No | No | ? | M6 |
| Auto update | Yes, update check | Yes | No | Yes, Tauri updater | M6 |
| Installer size | 159 MB | Not measured | Not measured | Not measured | Small, no bundled Chromium |

## Conclusions

1. **Status display is a crowded category.** At least five projects show agent status in a Windows island.
   Meridian cannot win on status alone, so it must lead with control and universality.
2. **Visual quality is an open opportunity.** Real glass was not found in any studied project, and most use
   flat dark surfaces. Original motion and a real material would be a visible difference.
3. **Nobody combines the three pillars.** Agent control, direct access to any model, and desktop context all
   exist separately, and no project combines them. Coucou comes closest, with chat plus agents.
4. **Windows Codex integration is unreliable through hooks.** The app-server path may give Meridian a more
   dependable Codex experience than the studied projects, subject to its experimental status.
5. **Trust is a differentiator.** Unsigned installers are the norm here, and a privacy dashboard exists
   nowhere. Both are straightforward ways to earn trust.
