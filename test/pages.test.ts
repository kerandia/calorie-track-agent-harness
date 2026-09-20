import assert from "node:assert/strict";
import test from "node:test";
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
