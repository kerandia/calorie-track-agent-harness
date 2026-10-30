import assert from "node:assert/strict";
import test from "node:test";
import { isPreviewLink, splitPreviewLinks } from "../.flue/lib/previewLinks.js";

const LOGIN = "https://calorie-track-agent-harness.vercel.app/login/confirm?token=abc123&next=%2Fdashboard";
const PAGE = "https://calorie-track-agent-harness.vercel.app/p/0123456789abcdef/lisbon-plan-a1b2c3d4.html";
const MAP = "https://maptoagent.xyz/m/map-1";

test("a login line and its URL become two bubbles, URL alone", () => {
  const text = `Here's your dashboard login link (valid 10 minutes, one-time):\n${LOGIN}`;
  assert.deepEqual(splitPreviewLinks(text), [
    "Here's your dashboard login link (valid 10 minutes, one-time):",
    LOGIN,
  ]);
  assert.equal(isPreviewLink(LOGIN), true);
});

test("a share page and a map each leave the surrounding words intact", () => {
  const text = `page is up:\n${PAGE}\n\nmap's live:\n${MAP}`;
  assert.deepEqual(splitPreviewLinks(text), ["page is up:", PAGE, "map's live:", MAP]);
});

test("a URL that is already the whole message stays one bubble", () => {
  assert.deepEqual(splitPreviewLinks(`  ${PAGE}  `), [PAGE]);
});

test("other links stay in the sentence", () => {
  const text = `try https://example.com/bar before ${LOGIN}.`;
  assert.deepEqual(splitPreviewLinks(text), [`try https://example.com/bar before`, LOGIN]);
  assert.equal(isPreviewLink("https://example.com/bar"), false);
  assert.equal(isPreviewLink("https://maptoagent.xyz/docs"), false);
  assert.equal(isPreviewLink("https://maptoagent.xyz/v1/artifacts"), false);
});

test("a reply with no preview link is not rewritten", () => {
  const text = "logged. 480 kcal\n\nstill under.";
  assert.deepEqual(splitPreviewLinks(text), [text]);
});
