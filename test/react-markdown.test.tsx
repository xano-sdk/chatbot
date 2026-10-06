// @vitest-environment happy-dom
/**
 * The reply renderer. Model output is untrusted (README "Render the reply as Markdown"): nothing a reply
 * contains may become markup, script or an unsafe link. It builds React elements, never HTML strings.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Markdown, parse } from "../src/react/markdown.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; });
function html(text: string) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Markdown text={text} />));
  return host;
}

describe("what it renders", () => {
  it("paragraphs, bold, italic, inline code and line breaks", () => {
    const el = html("Hello **there** and *you*, try `npm i`.\nNext line.\n\nSecond paragraph.");
    expect(el.querySelectorAll("p")).toHaveLength(2);
    expect(el.querySelector("strong")!.textContent).toBe("there");
    expect(el.querySelector("em")!.textContent).toBe("you");
    expect(el.querySelector("code")!.textContent).toBe("npm i");
    expect(el.querySelector("br")).not.toBeNull();
  });
  it("lists (ordered keeps its start), headings, quotes, rules and fenced code", () => {
    const el = html("## Steps\n\n3. three\n4. four\n\n- a\n- b\n\n> quoted\n\n---\n\n```ts\nconst x = 1 < 2;\n```");
    expect(el.querySelector('[role="heading"]')!.getAttribute("aria-level")).toBe("2");
    expect(el.querySelector("ol")!.getAttribute("start")).toBe("3");
    expect(el.querySelectorAll("ul li")).toHaveLength(2);
    expect(el.querySelector("blockquote")!.textContent).toBe("quoted");
    expect(el.querySelector("hr")).not.toBeNull();
    expect(el.querySelector("pre")!.textContent).toBe("const x = 1 < 2;");
    expect(el.querySelector("pre")!.getAttribute("data-lang")).toBe("ts");
  });
  it("code inside backticks is literal (no bold inside code)", () => {
    const el = html("`**not bold**`");
    expect(el.querySelector("strong")).toBeNull();
    expect(el.querySelector("code")!.textContent).toBe("**not bold**");
  });
  it("an unclosed fence still renders the rest as code", () => {
    expect(parse("```\nline")).toEqual([{ t: "code", lang: "", text: "line" }]);
  });
});

describe("what it never lets through", () => {
  it("raw HTML stays text", () => {
    const el = html('<img src=x onerror="alert(1)"><script>alert(2)</script><b>bold?</b>');
    expect(el.querySelector("img, script, b")).toBeNull();
    expect(el.textContent).toContain("<script>alert(2)</script>");
  });
  it("javascript:, data: and vbscript: links render as plain text, not links", () => {
    const el = html("[click](javascript:alert(1)) [data](data:text/html;base64,PHNjcmlwdD4=) [vb](vbscript:msgbox)");
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toContain("click");
  });
  it("http(s) and mailto links open safely in a new tab", () => {
    const el = html("[docs](https://docs.xano.com) [mail](mailto:help@x.test)");
    const links = [...el.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://docs.xano.com", "mailto:help@x.test"]);
    for (const a of links) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toContain("noopener");
      expect(a.getAttribute("rel")).toContain("noreferrer");
    }
  });
  it("an attribute-breaking link target can't escape the href", () => {
    const el = html('[x](https://a.test/"onmouseover="alert(1))');
    const a = el.querySelector("a");
    expect(a?.getAttribute("onmouseover") ?? null).toBeNull();
  });
});

describe("links into the app", () => {
  it("renders a path or a hash route as an in-app link, and refuses another host", () => {
    const out = html("[Open note #5](/notes/5) · [Approvals](#approvals) · [evil](//evil.example/x) · [js](javascript:alert(1))").innerHTML;
    expect(out).toContain('href="/notes/5"');
    expect(out).toContain('href="#approvals"');
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain('target="_blank" rel="noopener noreferrer nofollow" class="font-medium text-primary');   // in-app links stay in the tab
  });
  it("routes an in-app link through the app's navigate, without a reload", async () => {
    const { NavigateContext } = await import("../src/react/markdown.js");
    const went: string[] = [];
    const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    act(() => root!.render(<NavigateContext.Provider value={(h) => went.push(h)}><Markdown text="See [note 5](/notes/5)." /></NavigateContext.Provider>));
    const a = host.querySelector("a[data-in-app]") as HTMLAnchorElement;
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => { a.dispatchEvent(ev); });
    expect(went).toEqual(["/notes/5"]);
    expect(ev.defaultPrevented).toBe(true);
  });
});
