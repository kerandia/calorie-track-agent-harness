import assert from "node:assert/strict";
import test from "node:test";
import { OG_VIDEO_URL, injectOgPreview } from "../.flue/lib/ogPreview.js";
import { buildPageHtml } from "../.flue/lib/pageTemplate.js";
import {
  assertPagePath,
  putPage,
  tenantPrefix,
} from "../.flue/lib/pages.js";

test("hosted page content is sanitised inside the consistent page shell", () => {
  const html = buildPageHtml({
    title: `<script>bad</script> "Trip"`,
    subtitle: "<b>dates</b>",
    mapUrl: "https://maps.example/plan?a=1&b=2",
    bodyHtml:
      '<h2 onclick="steal()">Day 1</h2><script>steal()</script>' +
      '<a href="javascript:steal()" style="color:red">bad link</a>' +
      '<div class="card unknown">Safe content</div>',
    updatedAt: new Date("2026-09-20T12:00:00.000Z"),
  });

  assert.match(html, /^<!doctype html>/);
  assert.match(html, /&lt;script&gt;bad&lt;\/script&gt; &quot;Trip&quot;/);
  assert.match(html, /Updated 2026-09-20/);
  assert.match(html, /class="card"/);
  assert.doesNotMatch(html, /onclick|style="color:red"|javascript:|steal\(\)|class="card unknown"/);
  assert.match(html, /rel="noopener noreferrer nofollow"/);
  assert.match(html, /https:\/\/maps\.example\/plan\?a=1&amp;b=2/);
});

test("page paths cannot escape their tenant prefix", () => {
  const valid = `${tenantPrefix("tenant-a")}/plan-123.html`;
  assert.doesNotThrow(() => assertPagePath("tenant-a", valid));
  assert.throws(
    () => assertPagePath("tenant-b", valid),
    /outside tenant prefix/,
  );
  assert.throws(
    () => assertPagePath("tenant-a", `${tenantPrefix("tenant-a")}/nested/plan.html`),
    /outside tenant prefix/,
  );
});

test("page updates require and normalise optimistic-concurrency etags", async () => {
  const path = `${tenantPrefix("tenant-a")}/plan-123.html`;
  let captured:
    | { path: string; body: string; options: Record<string, unknown> }
    | undefined;
  const storage = {
    async put(
      putPath: string,
      body: string,
      options: Record<string, unknown>,
    ) {
      captured = { path: putPath, body, options };
      return {
        path: putPath,
        url: "https://blob.example/plan-123.html",
        etag: 'W/"new-etag"',
      };
    },
  };

  await assert.rejects(
    putPage("tenant-a", "body", { path }, storage as never),
    /Read the page before updating it/,
  );
  const published = await putPage(
    "tenant-a",
    "body",
    { path, expectedEtag: 'W/"old-etag"' },
    storage as never,
  );

  assert.equal(captured?.path, path);
  assert.equal(captured?.options.ifUnchanged, '"old-etag"');
  assert.equal(published.etag, '"new-etag"');
});

test("share pages advertise the generic Sezar video, not the page's own stats", () => {
  const html = buildPageHtml({
    title: "1840 kcal — Monday",
    subtitle: "token=secret-token-should-not-preview",
    bodyHtml: '<p class="stat-n">1840</p>',
  });
  assert.match(html, /<h1>1840 kcal — Monday<\/h1>/);
  assert.match(html, /<title>1840 kcal — Monday<\/title>/);
  const head = html.slice(0, html.indexOf("</head>"));
  const preview = head
    .split("\n")
    .filter((line) => line.includes("og:") || line.includes("twitter:"))
    .join("\n");
  assert.match(preview, /property="og:title" content="Sezar — text the agent, keep the record"/);
  assert.match(head, /property="og:video" content="https:\/\/calorie-track-agent-harness\.vercel\.app\/og\/A2_grok_inout_key_og\.mp4"/);
  assert.match(head, /property="og:video:secure_url"/);
  assert.match(head, /property="og:video:type" content="video\/mp4"/);
  assert.match(head, /property="og:video:width" content="1200"/);
  assert.match(head, /property="og:video:height" content="630"/);
  assert.match(head, /property="og:image:type" content="image\/jpeg"/);
  assert.match(head, /property="og:image:width" content="1200"/);
  assert.match(head, /property="og:image:height" content="630"/);
  assert.match(preview, /name="twitter:card" content="summary_large_image"/);
  assert.doesNotMatch(preview, /1840|secret-token/);
  assert.equal(injectOgPreview(html).split('property="og:video"').length, 2);
  assert.match(OG_VIDEO_URL, /^https:\/\/calorie-track-agent-harness\.vercel\.app\/og\//);
});

test("a stored share page without preview tags gains them in front of </head>", () => {
  const legacy =
    "<!doctype html><html><head><title>1840 kcal</title></head><body>1840 kcal secret-token</body></html>";
  const html = injectOgPreview(legacy);
  const head = html.slice(0, html.indexOf("</head>"));
  const preview = head
    .split("<meta ")
    .filter((part) => part.startsWith("property=") || part.startsWith("name="))
    .join("\n");
  assert.match(preview, /property="og:video"/);
  assert.doesNotMatch(preview, /1840|secret-token/);
  assert.match(html, /<body>1840 kcal secret-token<\/body>/);
  assert.equal(injectOgPreview(html), html);
});

test("pre-escaped titles are escaped exactly once", () => {
  const html = buildPageHtml({ title: "Eat &amp; drink", subtitle: "Paris &amp; Berlin <3", bodyHtml: "<p>x</p>" });
  assert.match(html, /<h1>Eat &amp; drink<\/h1>/);
  assert.match(html, /<p class="sub">Paris &amp; Berlin &lt;3<\/p>/);
});
