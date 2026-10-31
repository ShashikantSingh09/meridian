import { useState } from "react";
import { hostOf } from "../island/views";
import { blocks, spans } from "../lib/markdown";
import { openLink } from "../lib/store";

function Inline({ text }: { text: string }) {
  return (
    <>
      {spans(text).map((span, i) => {
        switch (span.kind) {
          case "bold":
            return <strong key={i}>{span.text}</strong>;
          case "italic":
            return <em key={i}>{span.text}</em>;
          case "code":
            return <code key={i} className="md-inline">{span.text}</code>;
          case "link":
            return <button key={i} className="md-link" title={`Open on ${hostOf(span.url)}`} onClick={() => openLink(span.url)}>{span.text}</button>;
          default:
            return <span key={i}>{span.text}</span>;
        }
      })}
    </>
  );
}

function Code({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return (
    <div className="md-code">
      <pre>{text}</pre>
      <div className="md-code-bar">
        {lang && <span>{lang}</span>}
        <button aria-label="Copy code" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
      </div>
    </div>
  );
}

/** What an AI wrote, formatted. Everything here is built from text, never from its HTML. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      {blocks(text).map((block, i) => {
        switch (block.kind) {
          case "code":
            return <Code key={i} lang={block.lang} text={block.text} />;
          case "heading":
            return <p key={i} className="md-heading" data-level={block.level}><Inline text={block.text} /></p>;
          case "quote":
            return <blockquote key={i}><Inline text={block.text} /></blockquote>;
          case "list": {
            const List = block.ordered ? "ol" : "ul";
            return <List key={i}>{block.items.map((item, n) => <li key={n}><Inline text={item} /></li>)}</List>;
          }
          default:
            return <p key={i}><Inline text={block.text} /></p>;
        }
      })}
    </div>
  );
}
