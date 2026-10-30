// A small Markdown reader for what an AI writes. It produces data, never HTML, so nothing in a
// reply can become markup, and a link is only ever http or https. Text is read as it streams
// in, so an unfinished code block simply runs to the end.

export type Block =
  | { kind: "code"; lang: string; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "para"; text: string };

export type Span =
  | { kind: "text" | "bold" | "italic" | "code"; text: string }
  | { kind: "link"; text: string; url: string };

const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

export function blocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out: Block[] = [];
  let para: string[] = [];
  const endPara = () => {
    if (para.length > 0) out.push({ kind: "para", text: para.join("\n") });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = line.match(/^\s*```(\S*)/);
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (fence) {
      endPara();
      const body: string[] = [];
      for (i += 1; i < lines.length && !/^\s*```\s*$/.test(lines[i]!); i++) body.push(lines[i]!);
      out.push({ kind: "code", lang: fence[1] ?? "", text: body.join("\n") });
    } else if (heading) {
      endPara();
      out.push({ kind: "heading", level: heading[1]!.length, text: heading[2]! });
    } else if (BULLET.test(line) || NUMBERED.test(line)) {
      endPara();
      const pattern = BULLET.test(line) ? BULLET : NUMBERED;
      const items: string[] = [];
      for (; i < lines.length && pattern.test(lines[i]!); i++) items.push(lines[i]!.match(pattern)![1]!);
      i -= 1;
      out.push({ kind: "list", ordered: pattern === NUMBERED, items });
    } else if (line.startsWith(">")) {
      endPara();
      const quoted: string[] = [];
      for (; i < lines.length && lines[i]!.startsWith(">"); i++) quoted.push(lines[i]!.replace(/^>\s?/, ""));
      i -= 1;
      out.push({ kind: "quote", text: quoted.join("\n") });
    } else if (line.trim() === "") {
      endPara();
    } else {
      para.push(line);
    }
  }
  endPara();
  return out;
}

const INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s)>\]]+)/g;

export function spans(text: string): Span[] {
  const out: Span[] = [];
  let at = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > at) out.push({ kind: "text", text: text.slice(at, match.index) });
    const [whole, code, bold, italic, label, url, bare] = match;
    if (code) out.push({ kind: "code", text: code });
    else if (bold) out.push({ kind: "bold", text: bold });
    else if (italic) out.push({ kind: "italic", text: italic });
    else if (label && url) out.push({ kind: "link", text: label, url });
    else if (bare) out.push({ kind: "link", text: bare, url: bare });
    at = match.index + whole.length;
  }
  if (at < text.length) out.push({ kind: "text", text: text.slice(at) });
  return out;
}
