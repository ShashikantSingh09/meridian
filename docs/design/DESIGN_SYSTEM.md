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

## Material: a black notch

The island is one opaque black shape hanging from the top edge of the display, like the hardware notch it extends:

1. **Flat top.** It meets the edge of the screen, so it has no top corners.
2. **Two inward curves.** 10 px each, where the shape flows out of the edge. They are radial gradients beside the shape, so
   nothing is clipped or re-rastered per frame.
3. **Round bottom.** 13 px at rest, up to 30 px on the panel.
4. **Hairline edge.** 11% white, so black stays visible on a dark desktop. While something is happening it takes the state
   colour at 42%.
5. **Shadow.** One soft layer, `--island-shadow`, to lift it off a light desktop.

There is no glass, no tint and no light theme. See `docs/DECISIONS.md`, D27. Filters are avoided on anything that moves.

## Typography

Inter, bundled as a variable font with optical sizes, and Cascadia for code. Inter is the closest open font to San
Francisco, and it is what makes the island read as native to a notch rather than to Windows.

Scale: 11, 12, 13, 15 and 21 px. Body is 13 px. Numbers use tabular figures wherever they update.

## Space and shape

Spacing steps are 4, 8, 12, 16, 24 and 32. Radii are 8, 12 and 16. Heights stay slim: 32 at rest, 44 for a compact state, so
the island stays close to the notch it imitates.

## Motion

Tokens live in `packages/design-system/src/motion.ts`.

| Token | Use | Character |
|---|---|---|
| `spring.grow` | Expanding | Response 0.42 s, damping 0.84: a hint of overshoot |
| `spring.shrink` | Collapsing | Response 0.34 s, damping 1: no overshoot |
| `spring.hover` | Hover growth, indicators | Response 0.28 s, damping 0.9 |
| `contentEnter` | Content changing | 70 ms out, then 200 ms in |
| `rowEnter` | Rows from a fetch | One after another, 35 ms apart |

Rules:

- Growth may overshoot. Shrinking never does: a panel that bounces while closing reads as a mistake.
- Content fades at its final size, so text never reflows during a morph.
- Old content leaves before new content arrives, so two lines of text are never readable on top of each other.
- The island reacts to a resting pointer, not a passing one: 180 ms in, 240 ms out.
- At launch the shape grows out of a dot at the screen's edge.
- An interrupted transition keeps its velocity.
- Reduced motion, from the system or from Settings, lands instantly with no line animation.
- Nothing animates forever at rest. See `docs/DECISIONS.md`, D12.

## Writing

Sentence case, with plain verbs: Allow, Deny, Dismiss, Retry. Errors say what happened in the provider's or agent's own
words. An approval names the real command, because that is the thing being decided.
