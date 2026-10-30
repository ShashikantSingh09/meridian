# Known issues and limitations

Honest state of M1. "Not verified" means the code exists and has unit tests where noted, but the behaviour has not been
seen working for real.

## Not verified end to end

| Area | State | To close it |
|---|---|---|
| Codex full turn | The handshake, thread start and failure path ran against codex-cli 0.142.4. A real turn, streaming text, approvals and usage did not, because the local sign-in has expired. Those paths are tested against the generated protocol schema only. | Run `codex login`, then `node tests/live/e2e.mjs codex` |
| Cloud chat | No live call to Anthropic, OpenAI or any other cloud API. Adapters are tested against a real local socket with recorded response shapes. | Add a key, send a message |
| Ollama, LM Studio, llama.cpp | Not installed here. Discovery and streaming ran through the real app against a stand-in server on LM Studio's port. | Run a real server |
| Focus return after Esc | Implemented. The check gave a false reading because a person was using the machine during the test. | Press the shortcut, then Esc, and see that focus returns |
| Concurrent live agents | Multitask view is tested with sample data. Two real agents at once have not been run. | Start two sessions |

## Not tested

- Multiple monitors. The island always uses the primary display, and a display change is not followed.
- Display scaling other than 100%. The hit-test maths has unit tests at 150%.
- Sleep and resume.
- Windows 10, where only the tinted fallback is expected to work.
- Transparency effects turned off, and battery saver.
- A fullscreen app in front. The hide logic is written, but it has not been exercised.
- Time-to-first-token overhead, and CPU over a full five minutes.

## Not built yet

These are later milestones, and nothing in the UI pretends otherwise.

- **Voice.** The listening state shows the real microphone level. There is no speech to text, text to speech, wake word
  or voice command.
- **Desktop context engine.** The contextual state and its accept and dismiss flow work, but nothing generates
  suggestions yet. It is reachable only through Settings, Preview island states.
- **Sessions started outside the app.** Agents in your own terminal do not appear.
- **Workflows, agent collaboration, output comparison.**
- **Persistence.** Chat and sessions are lost on restart. Quitting ends every running agent.
- **Application profiles, project context, memory.**
- **Installer, auto-update, code signing.** `tauri build` produced a binary only.
- **Chat niceties.** Plain text only, with no Markdown or file attachments.
- **Providers.** Tool calling is declared as a capability but the chat does not use it. Gemini CLI, Aider and Continue
  adapters do not exist.
- **Configuration.** The shortcut, `Ctrl+Alt+Space`, and the island position are fixed.

## Behaviour to be aware of

- Click-away closes the panel, so it cannot stay open beside your work. A pin is the obvious next step.
- Cancelling a Claude Code session ends the process tree, so the interrupted turn is not recorded.
- `max_tokens` is fixed at 64,000 for Anthropic. A model with a lower ceiling would return an error.
- Claude Code in print mode loads hooks and MCP servers from the project folder with no trust prompt. The new-session
  form says so. This is upstream behaviour.
- `gpu-process` holds about 75 to 100 MB, partly for the mostly empty 860 by 660 surface.
- Memory grows from about 166 MB to about 268 MB once the panel has been opened, and was not seen to fall again.

## Unexplained

- **One test failure not reproduced.** "Island shows working" failed once on a deny run, then passed on the next. The
  store was correct by the end of that run. No cause was found, so it is not called fixed.
