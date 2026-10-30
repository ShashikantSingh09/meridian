# TwoCode teardown

Static analysis of TwoCode 1.2.0-beta.6 for Windows, 2026-10-30, to learn how the product behaves. The app was never run. No
code, asset, icon or copy was taken. Licensing code (`license-main.cjs`) was not opened.

**Method.** The downloaded installer is a small unsigned stub around a ZIP. The ZIP was carved out and unpacked into an empty
scratch folder. It holds an Electron 44 app with unminified JavaScript in `resources/app`, so it could be read directly.
REA 6.8.0 analysed that folder in 49 s, evidence `ev_92149338070a9d2f…`. REA's coverage is partial: its semantic graph hit the
100,000-node ceiling and dynamic IPC channels stay unresolved. Everything below comes from reading the code, not from
watching it run, so statements about behaviour are what the code says it does.

**Terms.** twocode.nl/terms has no reverse-engineering clause. It says the licence is personal, "please don't share or resell
the code", app use "is subject to the terms we publish at launch", and Dutch law applies. No EULA ships in the package. This
reading is an engineering note, not legal advice.

## How it is built

| Area | TwoCode | Meridian before | Meridian now |
|---|---|---|---|
| Shell | Electron 44, about 234 MB exe | Tauri, 12 MB | Tauri, 14.9 MB |
| Island drawing | One canvas, everything painted by hand at 30 fps at rest | DOM and Motion | DOM and Motion, shaped like theirs |
| Shape | Flush with the top edge, flat top, two 10 px inward curves, round bottom | Floating pill, 10 px below the edge | Same idea as theirs, built with CSS |
| Surface | Opaque black, faint hairline | Translucent glass with native blur | Opaque black |
| Rest size | 116 × 32 | 128 × 30 | 132 × 32 |
| Morph | One spring integrator, velocity kept across interruptions | Motion springs, already velocity-preserving | Softer springs |
| Hover | Instant to compact, delay before expanded | Instant both ways | 180 ms in, 240 ms out |
| Content change | Scale, slide, blur | Blur and overlapping fades | Quick fade out, then in, no filters |
| Fonts | Bundled Inter | Segoe UI | Bundled Inter |

## What makes it feel right

1. **It looks like hardware.** Black, flat against the screen edge, no glass. Nothing has to be composited behind it, so there
   is nothing to fall out of step during a morph. This one choice removed most of our rendering problems.
2. **Motion is one idea.** A single spring with a little overshoot on growth and none on shrink.
3. **Hover has intent.** A pointer passing on its way to a browser tab does not set anything off.
4. **It starts calmly.** A dot comes out of the top edge and springs open.
5. **Sounds are synthesised**, so there are no files to ship, and they mark the moments that matter.

## The product insight we were missing

TwoCode does not run Claude Code. **It watches the sessions you already run**, in any terminal, through Claude Code's hooks.

- It writes nine hook events into `~/.claude/settings.json`, stripping and re-adding its own entries, with one backup.
- Hooks post to a loopback server. A `PermissionRequest` stays open until you answer on the island, and the terminal's own
  dialog stays live, so whichever answers first wins.
- It makes no model request, so it never touches a Claude credential. That also sidesteps the subscription question in D19.

Meridian only saw sessions it launched itself. This is now the default path for customers: see D29.

## Adopted

- Top-edge notch shape, opaque black, hairline edge in the state colour. Built independently with CSS.
- Spring character. Values are Apple's two-term form, tuned here, and are close to TwoCode's.
- Hover delays, quick content change, startup birth from the edge.
- Watching Claude Code through hooks, with allow and deny on the island.
- Synthesised chimes, and a bundled open font.
- Small per-file checks that the renderer is still alive: a click-through state that is re-applied, not assumed.

## Improved on

| Weakness in TwoCode | What Meridian does |
|---|---|
| Fixed port 47823 | Port chosen on first use and recorded with the hooks |
| Sessions never expire, so a killed terminal looks busy for ever | 30 minutes of silence ends a watched session |
| One open permission per session | Several, keyed by request |
| Prompts stored unencrypted | Only a short label and the first prompt line leave the watcher, and nothing is written to disk |
| Hooks orphaned, no uninstaller found | Turning the setting off removes exactly our entries |
| Idle auto-update ignores running agents | Updates install only on a click |
| Updates are signed but the app itself is not | Same gap for now: see Shipping in `docs/KNOWN_ISSUES.md` |
| No crash handling beyond a renderer reload shortcut | Panics are written to a redacted log |
| No mail, calendar or service connections | Direct mail and calendar, plus 22 MCP services |
| A `const` shadowing bug in self-install | Not applicable: a standard NSIS installer |
| 158.8 MB installer, 234 MB app | 4.4 MB installer, 14.9 MB app |

## Not adopted

- **The mascot.** It is TwoCode's identity. Meridian keeps the line of light.
- **Reading ChatGPT and Claude windows through UI Automation.** Fragile, disabled in their own shipped build, and a privacy
  risk we do not need.
- **Canvas for everything.** They hand-build input fields, hit testing and text fitting. The DOM gives those for free.
- **A separate settings window.** Settings stay inside the island, in fewer places to look.
- **Self-copying into AppData.** NSIS does this properly.
- **Clipboard history, tray, webcam mirror, focus timer.** Clipboard reading breaks a promise in our brief, and the rest
  were not asked for.
