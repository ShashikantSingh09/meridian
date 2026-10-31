# Voice test: Hindi, English and mixed speech

Run on 2026-10-31 on the reference machine: Ryzen 5 5600F, RTX 3070 Ti, 32 GB RAM. The owner read 11 lines into their own microphone with the
app's microphone settings. The clips were deleted afterwards, and they were sent to ElevenLabs once, through the app.

Local models ran in Chromium 156, the same engine as the app's WebView2, in a throwaway page. Nothing here is in the app.

## Hearing results

Word error rate, lower is better. A false start in one English line lifts every English figure. Models can write mixed speech in either
script, so the mixed column overstates errors, most of all for ElevenLabs.

| Model | Download | English | Hindi | Mixed | Average time per clip |
|---|---|---|---|---|---|
| ElevenLabs Scribe v2, cloud, language not set | None | 36% | **15%** | 37% | 1.2 s |
| Whisper large-v3-turbo, forced to Hindi | 564 MB | Not run | 49% | 44% | 1.1 s |
| Whisper small, forced to Hindi | 410 MB | Not run | 62% | Failed, repeats itself | 4.4 s |
| Whisper base, forced to Hindi | 290 MB | Not run | 361%, repeats itself | 84% | Not worked out |
| Whisper large-v3-turbo, language not set | 564 MB | 9% | 100% | 81% | About 1 s |
| Parakeet v3 | 684 MB | 36% | 100% | 86% | 0.17 s |

Read as text, ElevenLabs was far ahead. Ten of the 11 lines came out close, though "build" became "bid", "reminder" became "agenda" and "Claude"
became "Cloud". Only "nahin, rehne do" failed.

## What this means

- **ElevenLabs is the only one good enough for Hindi today.** It is already in the app and needs no language setting.
- **Whisper large-v3-turbo is the best local choice, but it is not good enough yet.** It needs the language set, because the page has no way
  to detect it. Left unset, Whisper treated Hindi as English or translated it.
- **Parakeet does not hear Hindi at all.** It is the fastest for English, by a long way.
- **Local models need a GPU.** With the GPU hidden, each one ran at 0.1 to 0.8 times real time, so a laptop without one cannot use them. The
  page was not cross-origin isolated, the same as the app, so WebAssembly had one thread.
- **`fluidaudio-web` cannot hear Hindi as shipped.** Its Whisper fixes the language to English with no option, and it is the small base model.
  The test patched a throwaway copy.

## Not tested

- The streaming Hindi models and IndicConformer, because they need the local engine, which cannot be loaded during development.
- Silero speech detection.
- Language detection before transcribing, which a later version could add.
