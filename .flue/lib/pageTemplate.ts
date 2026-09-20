/**
 * The Sezar page shell.
 *
 * Every page the agent publishes goes through here, so the model only ever
 * writes CONTENT (a body fragment using the class vocabulary below) and the
 * chrome, typography, theming and print rules stay consistent across
 * everything Sezar hands a user. The alternative — letting the model invent
 * inline CSS per page — produced a different-looking document every time.
 *
 * Self-contained by construction: no external CSS, fonts or scripts, so the
 * page renders identically offline, in an email client preview, and when
 * saved to PDF. Light by default (a shared plan is usually read in daylight),
 * dark when the reader's OS asks for it, using the dashboard's palette.
 *
 * Class vocabulary available to the model (plain HTML is styled too):
 *   .lede      intro paragraph, slightly larger
 *   .card      generic panel
 *   .day       a panel with .day-h > .day-t/.day-m header, then .stop items
 *   .stop      numbered item: .stop-n, .stop-t, .stop-d, .tags > .tag
 *   .stats     row of .stat > .stat-n + .stat-l (numbers: kcal, protein…)
 *   .kv        label/value rows: .kv-r > .kv-k + .kv-v
 *   .note      callout box (tips, warnings, "book ahead")
 *   .check     checklist <ul> (shopping lists, packing)
 *   .cta       prominent link button (e.g. to the map)
 */

import sanitizeHtml from "sanitize-html";

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

export type PageInput = {
  title: string;
  /** One line under the title (dates, city, what this is). */
  subtitle?: string;
  /** The body fragment written by the model. */
  bodyHtml: string;
  /** Companion map, shown as a button under the header. */
  mapUrl?: string;
  /** Defaults to now; shown in the footer. */
  updatedAt?: Date;
  /** Wordmark link target (the dashboard), when configured. */
  homeUrl?: string;
};

const STYLE = `
:root{
  --ink:#10151c; --ink-2:#39424f; --ink-3:#6b7684;
  --paper:#fbfaf7; --panel:#ffffff; --panel-2:#f4f3ef;
  --line:#e4e2db; --line-soft:#eceae4;
  --accent:#12855f; --accent-soft:#e6f5ee; --accent-line:#bfe3d3;
  --radius:16px; --radius-s:10px;
  --shadow:0 1px 2px rgba(16,21,28,.05), 0 10px 30px rgba(16,21,28,.06);
}
@media (prefers-color-scheme:dark){
  :root{
    --ink:#e9eef5; --ink-2:#aeb8c6; --ink-3:#8d97a5;
    --paper:#0a0c10; --panel:#14171d; --panel-2:#1b1f27;
    --line:#242a33; --line-soft:#1e232b;
    --accent:#34d399; --accent-soft:#11271f; --accent-line:#1f7a5a;
    --shadow:0 1px 2px rgba(0,0,0,.4), 0 10px 30px rgba(0,0,0,.28);
  }
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0; background:var(--paper); color:var(--ink);
  font:17px/1.62 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility;
}
.wrap{max-width:720px; margin:0 auto; padding:28px 20px 72px}
a{color:var(--accent); text-decoration:none}
a:hover{text-decoration:underline}

/* header */
.brand{display:inline-flex; align-items:center; gap:8px; margin-bottom:26px;
  color:var(--ink-3); font-size:13px; font-weight:600; letter-spacing:.02em; text-decoration:none}
.brand:hover{text-decoration:none; color:var(--ink-2)}
.brand-mark{width:22px; height:22px; border-radius:7px; display:grid; place-items:center;
  background:var(--accent); color:#fff; font-size:13px; font-weight:800; line-height:1}
@media (prefers-color-scheme:dark){ .brand-mark{color:#07130f} }
h1{font-size:clamp(27px,5.2vw,36px); line-height:1.16; letter-spacing:-.021em; font-weight:760; margin:0 0 10px}
.sub{margin:0; color:var(--ink-2); font-size:16.5px}
.head{padding-bottom:22px; margin-bottom:28px; border-bottom:1px solid var(--line)}

/* typography */
h2{font-size:13px; font-weight:730; letter-spacing:.085em; text-transform:uppercase;
  color:var(--ink-3); margin:40px 0 14px}
h3{font-size:18.5px; font-weight:680; letter-spacing:-.011em; margin:26px 0 8px}
p{margin:0 0 14px}
.lede{font-size:18.5px; color:var(--ink-2); margin-bottom:22px}
strong{font-weight:660}
ul,ol{margin:0 0 15px; padding-left:22px}
li{margin:0 0 7px}
li::marker{color:var(--ink-3)}
blockquote{margin:0 0 16px; padding:2px 0 2px 16px; border-left:3px solid var(--accent-line); color:var(--ink-2)}
hr{border:0; border-top:1px solid var(--line); margin:34px 0}
code{font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; background:var(--panel-2);
  border:1px solid var(--line-soft); border-radius:6px; padding:1px 5px}
small,.muted{color:var(--ink-3); font-size:14px}

/* card + day */
.card,.day{background:var(--panel); border:1px solid var(--line); border-radius:var(--radius);
  padding:20px; margin:0 0 14px; box-shadow:var(--shadow)}
.card>:last-child,.day>:last-child{margin-bottom:0}
.day-h{display:flex; align-items:baseline; justify-content:space-between; gap:12px;
  padding-bottom:13px; margin-bottom:5px; border-bottom:1px solid var(--line-soft); flex-wrap:wrap}
.day-t{font-size:17px; font-weight:700; letter-spacing:-.008em}
.day-m{color:var(--ink-3); font-size:13.5px; font-weight:560}

/* stops */
.stop{display:grid; grid-template-columns:28px 1fr; gap:3px 13px; padding:14px 0;
  border-bottom:1px solid var(--line-soft)}
.stop:last-child{border-bottom:0; padding-bottom:0}
.stop-n{grid-row:span 3; margin-top:2px; width:28px; height:28px; border-radius:50%;
  display:grid; place-items:center; background:var(--accent-soft); color:var(--accent);
  border:1px solid var(--accent-line); font-size:12.5px; font-weight:730}
.stop-t{font-weight:640; letter-spacing:-.008em}
.stop-t a{color:inherit; border-bottom:1px solid var(--accent-line)}
.stop-t a:hover{color:var(--accent); text-decoration:none}
.stop-d{color:var(--ink-2); font-size:15.5px}
.tags{display:flex; flex-wrap:wrap; gap:6px; margin-top:7px}
.tag{font-size:11.5px; font-weight:620; letter-spacing:.03em; text-transform:uppercase;
  color:var(--ink-3); background:var(--panel-2); border:1px solid var(--line-soft);
  border-radius:999px; padding:3px 9px}

/* stats */
.stats{display:flex; flex-wrap:wrap; gap:10px; margin:0 0 16px}
.stat{flex:1 1 120px; background:var(--panel); border:1px solid var(--line);
  border-radius:var(--radius-s); padding:13px 15px}
.stat-n{font-size:23px; font-weight:730; letter-spacing:-.02em; line-height:1.15}
.stat-l{color:var(--ink-3); font-size:12.5px; font-weight:600; letter-spacing:.04em;
  text-transform:uppercase; margin-top:3px}

/* key/value */
.kv{margin:0 0 16px}
.kv-r{display:flex; gap:16px; justify-content:space-between; padding:9px 0;
  border-bottom:1px solid var(--line-soft)}
.kv-r:last-child{border-bottom:0}
.kv-k{color:var(--ink-3); font-size:15px}
.kv-v{text-align:right; font-weight:580}

/* note + checklist + cta */
.note{background:var(--accent-soft); border:1px solid var(--accent-line);
  border-radius:var(--radius-s); padding:14px 16px; margin:0 0 16px; font-size:15.5px; color:var(--ink-2)}
.note>:last-child{margin-bottom:0}
.note strong{color:var(--ink)}
ul.check{list-style:none; padding:0}
ul.check li{display:flex; gap:11px; align-items:flex-start; padding:9px 0;
  border-bottom:1px solid var(--line-soft)}
ul.check li:last-child{border-bottom:0}
ul.check li::before{content:""; flex:none; width:17px; height:17px; margin-top:3px;
  border:1.5px solid var(--line); border-radius:5px; background:var(--panel)}
.cta{display:inline-flex; align-items:center; gap:8px; background:var(--accent); color:#fff;
  border-radius:999px; padding:11px 19px; font-size:15px; font-weight:640; margin:2px 0 8px}
.cta:hover{text-decoration:none; filter:brightness(1.06)}
@media (prefers-color-scheme:dark){ .cta{color:#07130f} }

/* table */
table{width:100%; border-collapse:collapse; margin:0 0 18px; font-size:15.5px}
th,td{text-align:left; padding:10px 12px; border-bottom:1px solid var(--line-soft)}
th{font-size:12px; font-weight:680; letter-spacing:.05em; text-transform:uppercase; color:var(--ink-3)}
tbody tr:last-child td{border-bottom:0}
td:not(:first-child),th:not(:first-child){text-align:right}

/* footer */
.foot{margin-top:46px; padding-top:18px; border-top:1px solid var(--line);
  color:var(--ink-3); font-size:13.5px; display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap}

@media (max-width:520px){
  .wrap{padding:22px 16px 56px}
  body{font-size:16.5px}
  .stop{grid-template-columns:24px 1fr; gap:2px 11px}
  .stop-n{width:24px; height:24px; font-size:11.5px}
}
@media print{
  :root{--paper:#fff; --panel:#fff; --panel-2:#fff; --ink:#000; --ink-2:#333; --ink-3:#666;
        --line:#ccc; --line-soft:#e0e0e0; --accent:#0a6b4c; --accent-soft:#fff; --shadow:none}
  .wrap{max-width:none; padding:0}
  .cta,.brand{display:none}
  .card,.day,.stat{break-inside:avoid; box-shadow:none}
  h2{break-after:avoid}
}
`;

/** Wrap a body fragment in the Sezar shell. */
export function renderPage(input: PageInput): string {
  const updated = input.updatedAt ?? new Date();
  const stamp = updated.toISOString().slice(0, 10);
  const title = escapeHtml(input.title);
  const brandInner =
    `<span class="brand-mark" aria-hidden="true">S</span><span>sezar</span>`;
  const brand = input.homeUrl
    ? `<a class="brand" href="${escapeHtml(input.homeUrl)}">${brandInner}</a>`
    : `<span class="brand">${brandInner}</span>`;
  const cta = input.mapUrl
    ? `<a class="cta" href="${escapeHtml(input.mapUrl)}">Open the map <span aria-hidden="true">&rarr;</span></a>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
${brand}
<header class="head">
<h1>${title}</h1>
${input.subtitle ? `<p class="sub">${escapeHtml(input.subtitle)}</p>` : ""}
${cta}
</header>
<main>
${input.bodyHtml.trim()}
</main>
<footer class="foot"><span>Made by Sezar</span><span>Updated ${stamp}</span></footer>
</div>
</body>
</html>`;
}

/**
 * The body fragment is model-written text that ends up on a public URL, so it
 * is sanitized before it reaches the shell: an allowlist of structural tags,
 * our own class vocabulary, and http(s)/mailto/tel links only. No scripts, no
 * inline styles, no iframes, no forms, no external assets — which is also why
 * the tools no longer accept a whole document: the shell owns <head>, so there
 * is nothing left that a page legitimately needs outside this allowlist.
 */
const ALLOWED_CLASSES = [
  "lede", "card", "day", "day-h", "day-t", "day-m",
  "stop", "stop-n", "stop-t", "stop-d", "tags", "tag",
  "stats", "stat", "stat-n", "stat-l",
  "kv", "kv-r", "kv-k", "kv-v",
  "note", "check", "cta", "muted",
];

export function sanitizeBody(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      "section", "div", "span", "p", "h2", "h3", "h4",
      "ul", "ol", "li", "strong", "em", "b", "i", "u", "s",
      "a", "table", "thead", "tbody", "tfoot", "tr", "th", "td",
      "blockquote", "code", "pre", "hr", "br", "small", "time",
      "figure", "figcaption", "dl", "dt", "dd",
    ],
    allowedAttributes: {
      // rel/target are added by transformTags below; allowedAttributes is
      // applied AFTER the transform, so they have to be listed here too.
      a: ["href", "title", "rel", "target"],
      time: ["datetime"],
      th: ["colspan", "scope"],
      td: ["colspan"],
      "*": ["class"],
    },
    allowedClasses: { "*": ALLOWED_CLASSES },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", {
        rel: "noopener noreferrer nofollow",
        target: "_blank",
      }),
    },
    disallowedTagsMode: "discard",
  });
}

/** Sanitize a model-written body fragment and wrap it in the Sezar shell. */
export function buildPageHtml(input: PageInput): string {
  return renderPage({ ...input, bodyHtml: sanitizeBody(input.bodyHtml) });
}
