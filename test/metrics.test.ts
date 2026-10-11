import assert from "node:assert/strict";
import test from "node:test";
import { formatDigest, percentile, summarizeWeek, type DayStats } from "../.flue/lib/digest.js";
import { metricsUid, shellCommandKind } from "../.flue/lib/metrics.js";

test("metrics ids are stable, keyed, and don't contain the tenant id", () => {
  const a = metricsUid("123456789", "k1");
  assert.equal(a, metricsUid("123456789", "k1"));
  assert.notEqual(a, metricsUid("123456789", "k2"));
  assert.match(a, /^[a-f0-9]{16}$/);
  assert.ok(!a.includes("123456789"));
});

test("sandbox commands are reduced to the program and, for fetches, the host", () => {
  assert.equal(shellCommandKind("curl -s 'https://www.google.com/maps/search?q=ramen'"), "curl www.google.com");
  assert.equal(shellCommandKind("wget http://example.org/file"), "wget example.org");
  assert.equal(shellCommandKind("FOO=1 python3 -c 'print(1)'"), "python3");
  assert.equal(shellCommandKind("/usr/bin/pip install pandas"), "pip");
  assert.equal(shellCommandKind("   "), "unknown");
});

test("percentiles pick from the sorted samples", () => {
  assert.equal(percentile([], 50), undefined);
  assert.equal(percentile([7, 1, 3], 50), 3);
  assert.equal(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95), 95);
});

const dayOf = (date: string, over: Partial<DayStats> = {}): DayStats => ({
  date,
  active: [],
  turns: {},
  tools: {},
  toolErrors: {},
  tokens: { in: 0, out: 0, calls: 0 },
  latency: [],
  errors: {},
  shell: {},
  spend: {},
  ...over,
});

test("the weekly summary counts users, returning cohort, turns and silent features", () => {
  const week = [
    dayOf("2026-10-11", { active: ["a", "b"], turns: { telegram: 5, imessage: 2, voice: 1 }, tools: { web_search: 2, log_meal: 3 }, latency: [5, 9, 300], errors: { batch: 1 }, shell: { "curl maps.google.com": 2 } }),
    dayOf("2026-10-10", { active: ["a", "c"], turns: { telegram: 3 }, tokens: { in: 1000, out: 50, calls: 2 } }),
  ];
  const before = [dayOf("2026-10-03", { active: ["a", "d"], turns: { telegram: 4 } })];
  const first = { a: "2026-05-14", b: "2026-10-11", c: "2026-10-10", d: "2026-10-03" };

  const s = summarizeWeek(week, before, first);
  assert.equal(s.activeUsers, 3);
  assert.equal(s.activeUsersBefore, 2);
  assert.equal(s.newUsers, 2);
  assert.equal(s.totalUsers, 4);
  assert.deepEqual(s.returning, { cohort: 1, back: 0 }); // d started the week before, didn't return
  assert.equal(s.turns, 10); // voice is a tag, not a turn
  assert.deepEqual(s.byChannel, { telegram: 8, imessage: 2 });
  assert.equal(s.p95, 300);
  assert.ok(s.unusedFeatures.includes("travel_times"));
  assert.ok(!s.unusedFeatures.includes("web_search"));

  const text = formatDigest(s, "https://dash.example");
  assert.match(text, /Users: 3 active \(\+50%\), 2 new, 4 all-time/);
  assert.match(text, /Telegram 8, iMessage 2/);
  assert.match(text, /slowest 5% of replies take 300s/);
  assert.match(text, /sandbox fetched the web 2×/);
  assert.match(text, /Details: https:\/\/dash\.example\/dashboard\/admin/);
});
