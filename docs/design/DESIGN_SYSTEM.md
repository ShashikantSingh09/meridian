# Design system

## The idea: one line of light

Meridian has no mascot. A single luminous line is the product's character and carries every state, so you can read what
the app is doing from the corner of your eye, without reading a word. Text only says what the line cannot.

| State | Line behaviour | Colour token |
|---|---|---|
| Idle | Rests, tapered at both ends, breathing briefly after activity | `--state-idle` |
| Listening | Becomes a waveform that answers the microphone | `--state-listening` |
| Thinking | Standing wave, nodes fixed, slowly rising and falling | `--state-thinking` |
| Working | A pulse of light travels along it, implying activity and never a percentage | `--state-working` |
| Waiting for you | Steady and warm | `--state-waiting` |
| Notification | A flare that settles | `--state-success`, `--state-notice` |
| Contextual | A soft flare | `--state-context` |
| Multi-task | One small line per agent | Per session status |
| Error | Fractures, with a real gap in the middle | `--state-error` |

No state shows invented progress. A travelling pulse means "busy", and only a real number would ever become a bar.

## Material: smoked glass

The island is built in layers, from the back:

1. **Real blur.** A host backdrop visual, native and below the webview.
2. **Tint.** `--glass-tint` at 0.78. This one number decides legibility: at 0.5 the panel looked lovely over a dark editor
   and went mid-grey over white apps. Keep it dense.
3. **Sheen.** A soft top-down gradient, `--glass-sheen`.
4. **Rim.** A hairline ring and a brighter top edge, as inset shadows.
5. **Ambient light.** A radial gradient of the state colour, leaking from under the bottom edge.
6. **Shadow.** Soft and two-layered, `--glass-shadow`.

Without native blur, `html[data-glass="fallback"]` raises the tint to 0.93, and the design must still hold.

Filters are avoided on anything that moves. A gradient costs nothing per frame, and a blur filter is re-rastered on every
frame of a morph.

## Typography

Segoe UI Variable, in its Text and Display optical sizes, and Cascadia for code. Both ship with Windows 11, which is what
makes the app feel native and adds nothing to the download.

Scale: 11, 12, 13, 15 and 22 px. Body is 13 px, like Windows itself. Numbers use tabular figures wherever they update.

## Space and shape

Spacing steps are 4, 8, 12, 16, 24 and 32. Radii are 8, 12, 16 and 26, and a compact island's radius is half its height,
so the shape stays a true pill as it grows.

## Motion

Tokens live in `packages/design-system/src/motion.ts`.

| Token | Use | Character |
|---|---|---|
| `spring.grow` | Expanding | Stiffness 420, damping 33: a touch of overshoot |
| `spring.shrink` | Collapsing | Stiffness 460, damping 42: no overshoot |
| `spring.hover` | Hover growth | Stiffness 620, damping 40: immediate |
| `fade.in` | Content arriving | 200 ms, decelerating |
| `fade.out` | Content leaving | 90 ms, so nothing lingers |

Rules:

- Growth may overshoot. Shrinking never does: a panel that bounces while closing reads as a mistake.
- Content fades at its final size, so text never reflows during a morph.
- An interrupted transition keeps its velocity.
- Reduced motion, from the system or from Settings, lands instantly with no line animation.
- Nothing animates forever at rest. See `docs/DECISIONS.md`, D12.

## Writing

Sentence case, with plain verbs: Allow, Deny, Dismiss, Retry. Errors say what happened in the provider's or agent's own
words. An approval names the real command, because that is the thing being decided.
