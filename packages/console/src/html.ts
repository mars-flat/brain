/**
 * Server-rendered HTML: one shell, no framework, no external assets — the
 * CSP allows nothing but this origin, so there is no supply chain to audit.
 * Markdown renders via marked with wikilinks pre-resolved to /node/ links.
 */

import { marked } from "marked";

export function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** `[[id]]` / `[[id|label]]` → markdown links into the viewer. */
export function resolveWikilinks(md: string): string {
  return md.replace(/\[\[([a-z0-9-]+)(?:\|([^\]]+))?\]\]/g, (_, id: string, label?: string) => {
    return `[${label ?? id}](/node/${id})`;
  });
}

export function renderMarkdown(md: string): string {
  return marked.parse(resolveWikilinks(md), { async: false }) as string;
}

const STYLE = `
:root { --bg:#faf9f6; --fg:#1c1b19; --muted:#6f6a60; --line:#e4e0d6; --accent:#4a6b52; --card:#ffffff; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#191817; --fg:#e8e5df; --muted:#98928a; --line:#33312d; --accent:#8fb49a; --card:#211f1d; }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg);
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { max-width: 52rem; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
nav.top { display:flex; gap:1rem; align-items:baseline; padding:.9rem 1rem; border-bottom:1px solid var(--line); }
nav.top a { color:var(--fg); text-decoration:none; font-weight:600; }
nav.top a:hover { color:var(--accent); }
nav.top form { margin-left:auto; }
nav.top input { background:var(--card); color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:.35rem .6rem; width:14rem; }
a { color: var(--accent); }
h1,h2,h3 { line-height:1.25; }
.chip { display:inline-block; font-size:.72rem; padding:.1rem .5rem; border:1px solid var(--line); border-radius:99px; color:var(--muted); margin-right:.35rem; }
.chip.type { color:var(--accent); border-color:var(--accent); }
.muted { color:var(--muted); }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding: .9rem 1.1rem; margin: .7rem 0; }
.grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(15rem,1fr)); gap:.7rem; }
ul.plain { list-style:none; padding:0; } ul.plain li { margin:.3rem 0; }
.ok { color:#3c7d4e; } .warn { color:#b57316; } .bad { color:#b3402e; }
blockquote { border-left:3px solid var(--line); margin:0; padding:.1rem 1rem; color:var(--muted); }
code { background:var(--card); border:1px solid var(--line); border-radius:4px; padding:0 .3rem; }
pre { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:.8rem; overflow-x:auto; }
table { border-collapse:collapse; } td,th { border:1px solid var(--line); padding:.3rem .6rem; }
`;

export function page(title: string, body: string, opts: { authed?: boolean } = {}): string {
  const nav = opts.authed
    ? `<nav class="top">
        <a href="/">vault</a>
        <a href="/episodes">episodes</a>
        <a href="/dashboard">dashboard</a>
        <form action="/search" method="get"><input type="search" name="q" placeholder="search memory…"></form>
      </nav>`
    : "";
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head><body>${nav}<main>${body}</main></body></html>`;
}
