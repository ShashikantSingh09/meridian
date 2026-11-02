# What Coucou's Notetaker does

Coucou (github.com/Louis-CFM/coucou, MIT) has a feature called the Notetaker. It records a call, then writes a transcript person by person,
a summary, the key points and the to-dos. This page separates what was seen in the source from what was concluded from it.

**How this was reviewed.** At upstream commit `b6a85f2` (2026-10-31). `notes/mod.rs` and `notes/builder.rs` were checked against GitHub by git
hash and match. All of it was read by hand: 1,100 lines of Rust for the notes, 1,040 for speech, 264 of TypeScript, and 2,360 of Swift, because the
Windows code calls itself a port of the Mac code. REA analysed the Windows tree statically (root sha256 `6bebd033`, Evidence
`ev_fa9eb12a2e2b828bc6306dcfb2a39462bc047475712eef97658d13ec5edad939`). It parsed all 86 front-end sources with no failures, and showed that
`hub/pages/notes.ts` has one export, `notesPage`, and seven imports. It models Electron, so it reports no IPC for a Tauri app, a trace on the
literal `notes_start` matched nothing, and it does not read Rust or Swift. That gap was closed by reading those files. Nothing from Coucou was
run, built or installed, so **everything below is from the code, and none of it was seen working.**

## How it works

1. **Start.** A click only. The three places are the record button in Notes, the same button on the dictation home, and the pill's toolbar.
   A search of all three platforms found no call detection, so nothing ever starts by itself. No bot joins the call, and the page says to tell the
   people in it.
2. **Two recordings.** The microphone goes to `mic.wav` and what the computer plays goes to `system.wav`, both 16 kHz mono. System sound is
   WASAPI loopback on Windows, through `cpal`. If it cannot open, the call is noted from the microphone alone.
3. **While recording.** The pill shows a red dot, a running clock and a stop button. Every second, a stretch of audio ending on a pause goes to
   the local model, and its text appears as a line marked Me or Others. Those lines are thrown away at the end.
4. **Stop.** Both files are closed and the note becomes `processing`.
5. **Transcript, from the whole recording.** Each file is transcribed with word times, using NVIDIA's Parakeet on the PC. Then one of three paths:
   - The computer's sound holds 5 words or more: a call. The diarizer separates the voices in `system.wav`, and each word goes to whoever was speaking.
   - Otherwise, with 20 or more microphone words: people round one PC. The diarizer runs on `mic.wav` and everyone is numbered.
   - Otherwise it is just you.
6. **Lines.** A new line starts after a pause of 1.4 s, on a new speaker, or at 40 s. The speaker who is you is `me`. The others become Person 2,
   Person 3 and so on, in the order they first speak.
7. **Echo.** Without headphones the others come back through the microphone. A line of yours is dropped if at least 60% of its words appear in
   the others' words at the same moment.
8. **The audio is deleted** once the transcript is written. If it fails, the audio stays and Retry runs it again.
9. **Summary.** If summaries are on and an AI is ready, the transcript goes to Claude, by API key or through the user's Claude Code. It asks for JSON
   holding a title of 6 words at most, 2 to 4 sentences of what was decided and why, up to 6 key points, and to-dos with an owner and a due date as said.
   It says to write in the language of the transcript and to invent nothing. The title is kept only if the user has not renamed the note.
10. **Notes ready.** The pill says so for 12 seconds, with a button to see them.
11. **A crash is survived.** A note left recording or processing is finished at the next launch. On quit, the files are closed properly first.

Each note is `Notes/<id>/note.json`, written to a temporary file and renamed. While recording, Coucou stops listening for its wake word.

**The page** has the list on the left, grouped by day, with a recording row on top, and the note on the right. A note has its title (click to rename),
date and app, Copy as Markdown, Export, Delete with a confirmation, speaker chips (click to rename), and Summary and Transcript tabs. To-dos tick off.

## Windows and Mac differ

Windows is the closest to Meridian, and the Mac has more.

| | Windows | Mac |
|---|---|---|
| Speech | Parakeet through sherpa-onnx, a 670 MB download | Parakeet through FluidAudio |
| Voices | sherpa-onnx diarizer, 30 MB | FluidAudio diarizer, with voice fingerprints |
| Summary | Claude, or off | Claude, Apple Intelligence on the Mac, or off |
| Echo | Words in common, by line | Also compares loudness in 20 ms frames, and matches runs of 3 or more words |
| A short "yeah" made into a new person | Left in | Merged into the nearest real voice |
| AI fixing misheard words | No | Yes. A fix is refused if it changes too much of the line, and the original words are kept |
| Learns names and terms from corrections | No | Yes, up to 300 |
| Renaming a person to a name already in the call | Just renames | Joins the two, because one voice was split |
| Fixing one line, moving it to someone else, deleting it | No | Yes |
| Share of talking per person | No | Yes |
| The two levels while recording | No | Yes |
| The two recordings kept on one clock | Not done | Pads the silence before the first sound |

## What matters for Meridian

- **Parakeet has no Hindi.** Its model card lists 25 European languages, and [Hindi is not one](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3). Hindi
  is a requirement here, so copying Coucou's speech engine would fail on the owner's own calls.
- **Meridian's local hearing cannot do this either.** It is English only, gives no speakers, and the sherpa DLL it loads must not be loaded in testing here.
- **Cloud hearing can.** [ElevenLabs Scribe v2](https://elevenlabs.io/docs/capabilities/speech-to-text) rates Hindi in its high accuracy tier, returns
  [word times and a speaker for each word](https://elevenlabs.io/docs/api-reference/speech-to-text/convert), handles up to 32 speakers and 10 hours, and is already what the
  owner uses to hear. It costs [$0.22 an hour](https://elevenlabs.io/pricing/api), and silence is billed. Deepgram Nova-3 also lists Hindi.
- **Live words are local by nature.** Coucou gets them free because its model is on the PC, and it transcribes everything a second time at the end. Through a
  cloud service that would be paid for twice.
- **The Windows port may drift.** Its samples are counted as they arrive, and nothing fills a gap, in code that opens loopback through `cpal`. If loopback delivers
  nothing during silence, later words in `system.wav` would land early against the microphone. This is **inferred from the code and not measured**, and
  [Microsoft's page](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording) does not say what happens in silence. Meridian should measure it and keep
  the two on one clock either way. The Mac code pads only the start.

## Not known

- How accurate any of this is, because nothing was run. That includes the echo rule, the 60% and the 1.4 s.
- Whether `diarize` works together with `use_multi_channel` at ElevenLabs. The API page does not say.
- Whether ElevenLabs separates voices well on a mixed call in Hindi and English. Only a real call will show that.

## Licence

The code is MIT, so it may be reused if the notice is kept. `LICENSE-ASSETS.md` keeps back the names Coucou and Mochi, the character, icons, sounds and media. As before, we
take the ideas and write our own code.
