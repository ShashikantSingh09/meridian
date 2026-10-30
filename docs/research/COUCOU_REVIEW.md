# What Coucou taught us

Coucou (github.com/Louis-CFM/coucou, MIT) is a notch companion for coding agents. Its Windows app is Tauri, the same stack as
Meridian, so it is the closest open comparison there is. Reviewed at commit `37e457d`, by reading the source. REA ran on the Windows
tree and gave a module map, but it models Electron apps, so it added nothing about hooks, Rust or installers. Nothing from Coucou
was run.

**Licence.** The code is MIT, so it may be reused if the copyright notice is kept. `LICENSE-ASSETS.md` keeps back the names Coucou
and Mochi, the character's design and animation, and the icons, sounds and media. Nothing of those was used, and no code was copied.
What we took were ideas.

## Taken

| Idea | Where it went |
|---|---|
| A tag builds and publishes the release, and fails if the tag and the version files disagree | `.github/workflows/release.yml`, D42 |
| MSI beside the setup exe, because unsigned NSIS installers trip Windows Defender more often | Same workflow |
| A portable exe | Same workflow |
| Showing the exact change before writing to a settings file | `panel/Follow.tsx`, `watch::preview` |
| Plans and questions answered on the island | `panel/Markdown.tsx`, `island/views.tsx`, `watch::reply_body` |
| Markdown in chat, built from text and never from HTML | `lib/markdown.ts`, `panel/Markdown.tsx` |

Where Coucou and Anthropic's documentation differ, the documentation won. Coucou sends a multiple choice as a list, and the
documentation says labels joined with commas.

## Not taken yet, best first

1. **Plan limits on the island.** Five-hour and weekly gauges. Codex has `account/rateLimits/read`. Claude needs the status line
   wrapped, and the user's own kept. Small for Codex, medium for Claude.
2. **Following Codex, Gemini CLI, Cursor, Antigravity and Copilot.** This is Coucou's main feature. Each uses command hooks, not
   HTTP, so Meridian would need a small helper exe, which reverses D9. Only Codex and Copilot can be approved from the island. Most
   of these are not installed here, so little of it could be tested. It deserves its own milestone, starting with Codex.
3. **Jump to terminal.** One click raises the session's window. Small once the helper exists.
4. **File drop.** Drop a file on the island, then ask about it. Coucou had to bypass Tauri's handler for Explorer drags.

## Left out on purpose

- Flow dictation uses a low-level keyboard hook, which the project rules forbid.
- WhatsApp uses an unofficial gateway.
- The phone link needs a mobile app and a relay.
