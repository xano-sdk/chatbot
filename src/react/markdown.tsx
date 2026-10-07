/**
 * A small Markdown renderer for assistant replies, safe by construction: it builds React elements and
 * never HTML strings, so a reply steered by prompt injection cannot put markup or script on the page.
 * Links keep only http(s) and mailto targets (a new tab, without referrer) and links into the app itself:
 * a path ("/notes/12") or a hash route ("#approvals"), never "//host". In-app links go through
 * `onNavigate` when the app gives one (its router), so they never reload the page.
 *
 * Supports what the chatbot's default prompt asks for: paragraphs, **bold**, *italic*, `code`, fenced
 * code blocks, headings, bullet and numbered lists, block quotes, links and horizontal rules. Anything
 * else is shown as text.
 */
import { createContext, Fragment, useContext, type ReactNode } from "react";

const SAFE_URL = /^(https?:\/\/|mailto:)/i;
/** A path or hash route in this app: "/x", "#x". "//host" (another site) is not. */
const IN_APP = /^(\/(?!\/)|#)[^\s]*$/;

/** How an in-app link navigates: the app's router (react-router's navigate, say). Absent → a plain link. */
export const NavigateContext = createContext<((href: string) => void) | undefined>(undefined);

function InAppLink({ href, children }: { href: string; children: ReactNode }) {
  const navigate = useContext(NavigateContext);
  return (
    <a href={href} data-in-app="" className="font-medium text-foreground underline underline-offset-2"
      onClick={(e) => { if (navigate && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); navigate(href); } }}>
      {children}
    </a>
  );
}

/** Inline spans: code first (its content is literal), then links, bold, italic. */
export function inline(text: string, key = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`+)([^`]+?)\1|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${n++}`;
    if (m[2] !== undefined) out.push(<code key={k} className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{m[2]}</code>);
    else if (m[3] !== undefined) {
      const href = m[4]!;
      out.push(SAFE_URL.test(href)
        ? <a key={k} href={href} target="_blank" rel="noopener noreferrer nofollow" className="font-medium underline underline-offset-2">{inline(m[3], k)}</a>
        : IN_APP.test(href) ? <InAppLink key={k} href={href}>{inline(m[3], k)}</InAppLink>
        : <Fragment key={k}>{inline(m[3], k)}</Fragment>);
    } else if (m[5] !== undefined || m[6] !== undefined) out.push(<strong key={k} className="font-semibold">{inline(m[5] ?? m[6]!, k)}</strong>);
    else out.push(<em key={k}>{inline(m[7] ?? m[8]!, k)}</em>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { t: "p"; text: string }
  | { t: "h"; level: number; text: string }
  | { t: "code"; lang: string; text: string }
  | { t: "ul" | "ol"; items: string[]; start: number }
  | { t: "quote"; text: string }
  | { t: "hr" };

export function parse(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = line.match(/^\s*(```|~~~)\s*([\w+-]*)\s*$/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(fence[1]!)) body.push(lines[i++]!);
      i++;   // closing fence (or end)
      blocks.push({ t: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { blocks.push({ t: "h", level: h[1]!.length, text: h[2]!.trim() }); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { blocks.push({ t: "hr" }); i++; continue; }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      blocks.push({ t: "quote", text: body.join("\n") });
      continue;
    }
    const ul = /^\s*[-*+]\s+(.*)$/, ol = /^\s*(\d+)[.)]\s+(.*)$/;
    if (ul.test(line) || ol.test(line)) {
      const ordered = ol.test(line);
      const re = ordered ? ol : ul;
      const items: string[] = [];
      const start = ordered ? Number(line.match(ol)![1]) : 1;
      while (i < lines.length && (re.test(lines[i]!) || (/^\s{2,}\S/.test(lines[i]!) && items.length))) {
        const m = lines[i]!.match(re);
        if (m) items.push(ordered ? m[2]! : m[1]!);
        else items[items.length - 1] += ` ${lines[i]!.trim()}`;
        i++;
      }
      blocks.push({ t: ordered ? "ol" : "ul", items, start });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,6}\s|\s*(```|~~~)|\s*>|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[i]!)) para.push(lines[i++]!.trim());
    if (!para.length) para.push(lines[i++]!.trim());
    blocks.push({ t: "p", text: para.join("\n") });
  }
  return blocks;
}

/** Line breaks inside a paragraph render as <br>, the way chat text reads. */
const withBreaks = (text: string, key: string) =>
  text.split("\n").flatMap((l, j) => (j ? [<br key={`${key}-br${j}`} />, ...inline(l, `${key}-${j}`)] : inline(l, `${key}-${j}`)));

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className}>
      {parse(text).map((b, n) => {
        const k = `b${n}`;
        switch (b.t) {
          case "p": return <p key={k} className="my-2 first:mt-0 last:mb-0 leading-relaxed">{withBreaks(b.text, k)}</p>;
          case "h": return <p key={k} role="heading" aria-level={b.level} className="mt-3 mb-1 font-semibold first:mt-0">{inline(b.text, k)}</p>;
          case "code": return (
            <pre key={k} className="my-2 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs leading-5" data-lang={b.lang || undefined}><code>{b.text}</code></pre>
          );
          case "ul": return <ul key={k} className="my-2 list-disc space-y-1 pl-5">{b.items.map((it, j) => <li key={j}>{inline(it, `${k}-${j}`)}</li>)}</ul>;
          case "ol": return <ol key={k} start={b.start} className="my-2 list-decimal space-y-1 pl-5">{b.items.map((it, j) => <li key={j}>{inline(it, `${k}-${j}`)}</li>)}</ol>;
          case "quote": return <blockquote key={k} className="my-2 border-l-2 pl-3 text-muted-foreground">{withBreaks(b.text, k)}</blockquote>;
          case "hr": return <hr key={k} className="my-3" />;
        }
      })}
    </div>
  );
}
