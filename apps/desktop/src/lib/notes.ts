// Notes of a call, on the page's side: it brings the microphone, and follows what the core reports.

import { useEffect, useState } from "react";
import { bridge } from "./bridge";
import { chatEngine, dismissError, dismissNotice, getState, openPanel, pushError, pushNotice, setNotes, showNote, updateSettings } from "./store";
import type { Note, NoteLevels } from "./types";
import { closeNoteMicrophone, openNoteMicrophone } from "./voice";

const COPIED_MS = 1500;
const NOTE_TONES = 6;

let starting = false;

export const currentNote = (notes: Note[], selected: string | null, recording: string | null) =>
  notes.find((note) => note.id === (selected ?? recording)) ?? notes[0] ?? null;

/** Nothing is stored or sent by this, so it is safe to call as often as anything changes. */
export async function refreshNotes() {
  const state = await bridge.notesState();
  setNotes(state);
  if (state.recording === null) closeNoteMicrophone();
}

export async function startRecording() {
  if (starting || getState().notes.recording) return;
  starting = true;
  try {
    // The microphone comes first, because it is the part that can ask or refuse.
    await openNoteMicrophone(
      () => pushError({ title: "The microphone stopped", body: "This PC's sound is still being recorded." }),
      () => pushError({ title: "Your microphone is not connected", body: "Recording with the Windows default until it is back." }),
    );
    const id = await bridge.noteStart();
    showNote(id);
    await refreshNotes();
  } catch (err) {
    closeNoteMicrophone();
    const why = err instanceof Error ? err.message : String(err);
    pushError({ title: "Could not record", body: why === "Permission denied" ? "Windows did not allow the microphone." : why || "The microphone could not be opened." });
  } finally {
    starting = false;
  }
}

export async function stopRecording() {
  closeNoteMicrophone();
  await bridge.noteStop();
  await refreshNotes();
}

export async function writeSummary(id: string) {
  const engine = await chatEngine();
  if (!engine) throw new Error("No AI is ready. Add one in Settings, AI models.");
  await bridge.noteSummarize(id, engine);
}

/** The transcript is safe, so the summary comes next, and the note is ready after that. */
async function written(id: string) {
  await refreshNotes();
  const note = getState().notes.notes.find((n) => n.id === id);
  if (!note) return;
  if (getState().settings.notesSummary && note.lines.length > 0) {
    // A note with no summary is still a note, and the button for one is on its page.
    await writeSummary(id).catch((err) => pushError({ title: "Could not write the summary", body: err instanceof Error ? err.message : String(err) }));
    await refreshNotes();
  }
  const title = getState().notes.notes.find((n) => n.id === id)?.title ?? note.title;
  pushNotice({ tone: "success", title: "Notes ready", body: title, note: id });
}

export function seeNote(noticeId: string, id: string) {
  dismissNotice(noticeId);
  showNote(id);
  openPanel("notes");
}

export function openFailedNote(errorId: string, id: string) {
  dismissError(errorId);
  showNote(id);
  openPanel("notes");
}

export function retryNote(id: string) {
  void bridge.noteRetry(id).catch((err) => pushError({ title: "Could not try again", body: String(err) }));
}

export async function deleteNote(id: string) {
  try {
    await bridge.noteDelete(id);
    showNote(null);
    await refreshNotes();
  } catch (err) {
    pushError({ title: "Could not delete this note", body: String(err) });
  }
}

export async function copyNote(id: string) {
  await navigator.clipboard.writeText(await bridge.noteMarkdown(id));
}

export async function exportNote(note: Note) {
  const safe = note.title.replace(/[^\p{L}\p{N} -]+/gu, " ").replace(/\s+/g, " ").trim() || "Notes";
  const path = await bridge.pickSavePath(`${safe}.md`);
  if (path) await bridge.noteExport(note.id, path).catch((err) => pushError({ title: "Could not export this note", body: String(err) }));
}

export function setSummaryByItself(notesSummary: boolean) {
  void updateSettings({ notesSummary });
}

export function wireNotes() {
  void bridge.onNotesChanged(() => void refreshNotes());
  void bridge.onNoteWritten((id) => void written(id));
  void bridge.onNoteFailed(({ id, title, why }) => {
    // Someone looking at Notes already sees it, on the note itself.
    const { panelOpen, tab } = getState();
    if (!panelOpen || tab !== "notes") pushError({ title: "Could not write the notes", body: `${title}. ${why}`, note: id });
  });
  // Listening first, so a call left unfinished cannot end before the page hears about it.
  void refreshNotes().then(() => bridge.notesResume());
}

/** A running m:ss clock from a moment in the past. */
export function useRunningClock(since: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return clockOf((now - since) / 1000);
}

export function clockOf(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  const two = (n: number) => String(n).padStart(2, "0");
  return whole >= 3600 ? `${Math.floor(whole / 3600)}:${two(Math.floor(whole / 60) % 60)}:${two(whole % 60)}` : `${Math.floor(whole / 60)}:${two(whole % 60)}`;
}

/** How loud each side is, while the page showing them is open. */
export function useNoteLevels() {
  const [levels, setLevels] = useState<NoteLevels>({ you: 0, others: 0 });
  useEffect(() => {
    let off: (() => void) | undefined;
    let left = false;
    void bridge.onNoteLevels(setLevels).then((unlisten) => (left ? unlisten() : (off = unlisten)));
    return () => {
      left = true;
      off?.();
    };
  }, []);
  return levels;
}

/** Each person's share of the talking, as whole percentages. */
export function talkShares(note: Note) {
  const totals = new Map<string, number>();
  for (const line of note.lines) totals.set(line.speaker, (totals.get(line.speaker) ?? 0) + Math.max(0.1, line.end - line.start));
  const all = [...totals.values()].reduce((sum, time) => sum + time, 0);
  return new Map([...totals].map(([speaker, time]) => [speaker, Math.round((time / all) * 100)]));
}

export const personTone = (color: number) => `var(--person-${(Math.max(0, color) % NOTE_TONES) + 1})`;

export const copiedFor = COPIED_MS;
