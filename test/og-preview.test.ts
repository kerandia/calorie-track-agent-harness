import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  OG_DESCRIPTION,
  OG_ORIGIN,
  OG_POSTER_PATH,
  OG_POSTER_URL,
  OG_TITLE,
  OG_VIDEO_PATH,
  OG_VIDEO_URL,
} from "../.flue/lib/ogPreview.js";

const ROOT = resolve(import.meta.dirname, "..");
const DASHBOARD = resolve(ROOT, "dashboard");
const NEXT = resolve(DASHBOARD, "node_modules/next/dist/bin/next");
const PORT = 3317;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "og-leak-check-token-88af";

function decode(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num: string) => String.fromCodePoint(Number(num)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function headOf(html: string): string {
  const end = html.toLowerCase().indexOf("</head>");
  assert.ok(end !== -1, "expected a </head> in the initial HTML");
  return html.slice(0, end);
}

function metaContent(head: string, key: string): string {
  const tags = head.match(/<meta\b[^>]*>/gi) ?? [];
  const found: string[] = [];
  for (const tag of tags) {
    const name = tag.match(/\b(?:property|name)=["']([^"']+)["']/i)?.[1]?.toLowerCase();
    if (name !== key) continue;
    const content = tag.match(/\bcontent="([^"]*)"/i)?.[1] ?? tag.match(/\bcontent='([^']*)'/i)?.[1];
    assert.ok(content !== undefined, tag);
    found.push(decode(content));
  }
  assert.equal(found.length, 1, `${key} appeared ${found.length} times: ${found.join(" | ")}`);
  return found[0]!;
}

function run(args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [NEXT, ...args], {
      cwd: DASHBOARD,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`next ${args.join(" ")} exited ${code}\n${output.slice(-5000)}`));
    });
  });
}

async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child?.pid || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await new Promise((resolvePromise) => child.once("exit", resolvePromise));
}

test("dashboard login link serves a generic autoplay preview", { timeout: 180_000 }, async () => {
  await run(["build"]);
  let server: ChildProcess | undefined;
  let serverLog = "";
  try {
    server = spawn(process.execPath, [NEXT, "start", "-H", "127.0.0.1", "-p", String(PORT)], {
      cwd: DASHBOARD,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout?.on("data", (chunk: Buffer) => {
      serverLog += chunk.toString();
    });
    server.stderr?.on("data", (chunk: Buffer) => {
      serverLog += chunk.toString();
    });

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !serverLog.includes("Ready") && server.exitCode === null) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    assert.equal(server.exitCode, null, `dashboard exited before it was ready\n${serverLog.slice(-2000)}`);
    assert.match(serverLog, /Ready/, `dashboard did not start\n${serverLog.slice(-2000)}`);

    const page = await fetch(`${BASE}/login/confirm?token=${encodeURIComponent(TOKEN)}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    const head = headOf(html);

    assert.equal(metaContent(head, "og:title"), OG_TITLE);
    assert.equal(metaContent(head, "og:description"), OG_DESCRIPTION);
    assert.equal(metaContent(head, "og:image"), OG_POSTER_URL);
    assert.equal(metaContent(head, "og:image:type"), "image/jpeg");
    assert.equal(metaContent(head, "og:image:width"), "1200");
    assert.equal(metaContent(head, "og:image:height"), "630");
    assert.equal(metaContent(head, "og:video"), OG_VIDEO_URL);
    assert.equal(metaContent(head, "og:video:secure_url"), OG_VIDEO_URL);
    assert.equal(metaContent(head, "og:video:type"), "video/mp4");
    assert.equal(metaContent(head, "og:video:width"), "1200");
    assert.equal(metaContent(head, "og:video:height"), "630");
    assert.equal(metaContent(head, "twitter:card"), "summary_large_image");
    assert.equal(new URL(OG_VIDEO_URL).origin, OG_ORIGIN);
    assert.equal(new URL(OG_POSTER_URL).protocol, "https:");
    assert.doesNotMatch(head, new RegExp(TOKEN));
    assert.doesNotMatch(`${metaContent(head, "og:title")} ${metaContent(head, "og:description")}`, /kcal|token=/i);
    assert.match(html, new RegExp(TOKEN));
    assert.match(html, /Tap to open your dashboard/);

    const videoFile = readFileSync(resolve(DASHBOARD, "public", OG_VIDEO_PATH.slice(1)));
    const posterFile = readFileSync(resolve(DASHBOARD, "public", OG_POSTER_PATH.slice(1)));
    await assertAsset(OG_VIDEO_PATH, "video/mp4", videoFile);
    await assertAsset(OG_POSTER_PATH, "image/jpeg", posterFile);

    const dash = await fetch(`${BASE}/dashboard`, { redirect: "manual" });
    assert.ok(dash.status >= 300 && dash.status < 400, `dashboard without a session was ${dash.status}`);
    const location = dash.headers.get("location") ?? "";
    assert.equal(new URL(location, BASE).pathname, "/");
    assert.doesNotMatch(location, new RegExp(TOKEN));
    const home = headOf(await (await fetch(`${BASE}/`)).text());
    assert.equal(metaContent(home, "og:video"), OG_VIDEO_URL);
    assert.doesNotMatch(home, /kcal/i);
  } finally {
    await stop(server);
  }
});

async function assertAsset(pathname: string, contentType: string, file: Buffer): Promise<void> {
  const url = new URL(pathname, BASE);
  const full = await fetch(url);
  assert.equal(full.status, 200, pathname);
  assert.equal(full.headers.get("content-type"), contentType);
  assert.match(full.headers.get("accept-ranges") ?? "", /bytes/i);
  assert.match(full.headers.get("cache-control") ?? "", /public/);
  assert.match(full.headers.get("cache-control") ?? "", /max-age=\d+/);
  assert.equal(full.headers.get("set-cookie"), null);
  const body = Buffer.from(await full.arrayBuffer());
  assert.equal(createHash("sha256").update(body).digest("hex"), createHash("sha256").update(file).digest("hex"));

  const partial = await fetch(url, { headers: { Range: "bytes=0-99" } });
  assert.equal(partial.status, 206, pathname);
  assert.equal(partial.headers.get("content-type"), contentType);
  assert.match(partial.headers.get("content-range") ?? "", /^bytes 0-99\/\d+$/);
  const chunk = Buffer.from(await partial.arrayBuffer());
  assert.equal(chunk.length, 100);
  assert.equal(chunk.compare(file.subarray(0, 100)), 0);
}
