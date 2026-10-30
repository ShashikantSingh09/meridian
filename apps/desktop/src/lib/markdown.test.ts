import { describe, expect, it } from "vitest";
import { blocks, spans } from "./markdown";

describe("reading what an AI writes", () => {
  it("finds paragraphs, headings, lists, quotes and code", () => {
    const read = blocks("# Title\n\nSome text\nmore text\n\n- one\n- two\n\n1. first\n2. second\n\n> quoted\n\n```ts\nconst a = 1;\n```\n");
    expect(read.map((b) => b.kind)).toEqual(["heading", "para", "list", "list", "quote", "code"]);
    expect(read[1]).toEqual({ kind: "para", text: "Some text\nmore text" });
    expect(read[3]).toEqual({ kind: "list", ordered: true, items: ["first", "second"] });
    expect(read[5]).toEqual({ kind: "code", lang: "ts", text: "const a = 1;" });
  });

  it("copes with a code block still arriving", () => {
    expect(blocks("Here:\n```js\nlet a")).toEqual([
      { kind: "para", text: "Here:" },
      { kind: "code", lang: "js", text: "let a" },
    ]);
  });

  it("leaves Markdown inside code alone", () => {
    expect(blocks("```\n# not a heading\n- not a list\n```")).toEqual([{ kind: "code", lang: "", text: "# not a heading\n- not a list" }]);
  });

  it("reads bold, italics, code and links in a line", () => {
    expect(spans("a **b** *c* `d` [e](https://e.com) f")).toEqual([
      { kind: "text", text: "a " },
      { kind: "bold", text: "b" },
      { kind: "text", text: " " },
      { kind: "italic", text: "c" },
      { kind: "text", text: " " },
      { kind: "code", text: "d" },
      { kind: "text", text: " " },
      { kind: "link", text: "e", url: "https://e.com" },
      { kind: "text", text: " f" },
    ]);
  });

  it("only ever links to http and https", () => {
    for (const bad of ["[x](javascript:alert(1))", "[x](file:///c:/secrets)", "[x](data:text/html,hi)"]) {
      expect(spans(bad).every((s) => s.kind !== "link"), bad).toBe(true);
    }
  });

  it("keeps markup as plain text, because it never becomes HTML", () => {
    expect(spans("<img src=x onerror=alert(1)>")).toEqual([{ kind: "text", text: "<img src=x onerror=alert(1)>" }]);
  });
});
