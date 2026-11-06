// Fill this form on the island, from the Fill this form board (figures 2 and 3, Show, When it does not
// have a value, Undo) and the Your details board (Add your details once?): a line while the boxes light
// up one by one, a line with Undo and Show once they are in, the list of every box and where its value
// came from, and the cards for an ID number and for starting Your details.

import { addDetails, allowIds, both, closeList, filledLine, goToBox, keptLine, listedRows, notNowDetails, sayIt, showAllRows, showList, skipIds, sourceOf, undoBox, undoForm } from "../lib/form";
import type { HereState, HereStep } from "../lib/here";
import type { FormRow } from "../lib/types";
import { Button, Card, Eyes, Working } from "./here";
import "./form.css";

export const FORM_STEPS: ReadonlySet<HereStep> = new Set(["filling", "filled", "list", "undone", "ids", "details"]);

const Small = ({ label, onClick, undo }: { label: string; onClick: () => void; undo?: boolean }) => (
  <button className={undo ? "here-b form-sm form-undo" : "here-b form-sm"} onClick={(e) => { e.stopPropagation(); onClick(); }}>
    {label}
  </button>
);

function Filling({ here, reduced }: { here: HereState; reduced: boolean }) {
  const progress = here.progress;
  const counted = progress && progress.total > 0;
  const text = progress?.reading === "mail" ? "Reading your mail…" : counted ? `Filling in · ${progress.done} of ${progress.total}` : "Reading the form…";
  return (
    <div className="row pad-pill here-pill" role="status">
      <Eyes mood="think" reduced={reduced} />
      <span className="grow label truncate">{text}</span>
      {counted ? (
        <span className="here-progress form-progress" aria-hidden="true">
          <i style={{ width: `${(100 * progress.done) / progress.total}%` }} />
        </span>
      ) : (
        <Working />
      )}
    </div>
  );
}

/** What a row says on the right: where its value came from, or Go to it for a box left for the user. */
function RowEnd({ row, missing }: { row: FormRow; missing: boolean }) {
  if (row.state === "filled") {
    const ai = row.origin === "written-by-ai";
    return (
      <>
        <Small label="Undo" undo onClick={() => void undoBox(row.field)} />
        <span className="form-src" data-ai={ai || undefined}>
          {!ai && <span className="form-dot" aria-hidden="true" />}
          {sourceOf(row)}
        </span>
      </>
    );
  }
  // With boxes that have no value on show, the boxes that are the user's stay quiet, as on the board.
  if (row.state === "needs-you" || row.state === "ask-first" || (row.state === "yours" && !missing)) return <Small label="Go to it" onClick={() => void goToBox(row.field)} />;
  return null;
}

function rowText(row: FormRow) {
  switch (row.state) {
    case "filled":
      return row.value;
    case "yours":
      return "Yours to fill";
    case "ask-first":
      return "Asks first";
    case "kept":
      return "Kept what was there";
    case "put-back":
      return "Put back";
    default:
      return row.why || "Not filled";
  }
}

function List({ here, reduced }: { here: HereState; reduced: boolean }) {
  const form = here.form!;
  const { rows, missing } = listedRows(form, here.all ?? false);
  const gap = form.rows.find((row) => row.state === "needs-you");
  const said = form.stopped ?? form.note;
  return (
    <div className="stack form-list" role="dialog" aria-label={filledLine(form)}>
      <div className="row form-head">
        <Eyes mood={missing ? "needs" : "rest"} reduced={reduced} />
        <span className="grow label truncate">{filledLine(form)}</span>
        <span className="form-site truncate">{form.site}</span>
      </div>
      <div className="form-rows">
        {rows.map((row) => (
          <div key={row.field} className="row form-row" data-state={row.state} data-quiet={(missing && row.state === "yours") || undefined}>
            <span className="form-k truncate" title={row.label}>{row.label}</span>
            <span className="form-v truncate" title={rowText(row)}>{rowText(row)}</span>
            <RowEnd row={row} missing={missing} />
          </div>
        ))}
      </div>
      {said && <p className="form-said">{said}</p>}
      {missing && gap && (
        <p className="form-hint">
          Say it and it fills that box: <b>“{sayIt(gap.label)} …”</b>
        </p>
      )}
      <div className="row form-foot">
        {missing ? (
          <>
            <span className="grow" />
            <Button label={`Show all ${form.total}`} onClick={showAllRows} />
            <Button label="Add to Your details" main onClick={addDetails} />
          </>
        ) : (
          <>
            <span className="grow form-check">Check it, then submit yourself.</span>
            {form.canUndo && <Button label="Undo all" onClick={() => void undoForm()} />}
            <Button label="Close" onClick={closeList} />
          </>
        )}
      </div>
    </div>
  );
}

export function FormView({ here, reduced }: { here: HereState; reduced: boolean }) {
  const form = here.form;
  if (here.step === "filling" || !form) return <Filling here={here} reduced={reduced} />;
  switch (here.step) {
    case "filled":
      return (
        <div className="row pad-pill here-pill" role="status">
          <Eyes mood="rest" reduced={reduced} />
          <span className="grow label truncate">{filledLine(form)}</span>
          {form.canUndo && <Button label="Undo" onClick={() => void undoForm()} />}
          <Button label="Show" onClick={showList} />
        </div>
      );
    case "list":
      return <List here={here} reduced={reduced} />;
    case "undone": {
      const undone = here.undone;
      const put = undone?.putBack ?? 0;
      return (
        <div className="stack pad-card here-card" role="status">
          <div className="row">
            <Eyes mood="rest" reduced={reduced} />
            <span className="grow label truncate">{`Put back ${put} ${put === 1 ? "box" : "boxes"}`}</span>
            <span className="form-site truncate">{form.site}</span>
          </div>
          <p className="here-body">{keptLine(undone?.kept ?? [])}</p>
        </div>
      );
    }
    case "ids":
      return (
        <Card mood="needs" reduced={reduced} title={`Put in your ${both(form.ids)} on ${form.site}?`} body="ID numbers ask every time, and they never go to the AI.">
          <Button label="Not this time" onClick={() => void skipIds()} />
          <Button label="Put it in" main onClick={() => void allowIds()} />
        </Card>
      );
    case "details":
      return (
        <div className="stack pad-card here-card" role="alertdialog" aria-label="Add your details once?">
          <div className="row">
            <Eyes mood="rest" reduced={reduced} />
            <span className="grow label truncate">Add your details once?</span>
            <span className="form-site truncate">{form.site}</span>
          </div>
          <p className="here-body">{`This form asks for your ${both(form.details ?? [])}. Add them once and Meridian fills them every time.`}</p>
          <div className="row end">
            <Button label="Not now" onClick={notNowDetails} />
            <Button label="Add my details" main onClick={addDetails} />
          </div>
        </div>
      );
    default:
      return null;
  }
}
