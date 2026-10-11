import assert from "node:assert/strict";
import test from "node:test";
import { findTenantKeys, isDeleteCommand, isTenantSessionKey } from "../.flue/lib/account.js";
import { dashboardPath } from "../.flue/capabilities/dashboard.js";

test("only the exact commands arm deletion", () => {
  assert.equal(isDeleteCommand("/deletemydata"), true);
  assert.equal(isDeleteCommand(" /ForgetMe "), true);
  assert.equal(isDeleteCommand("please /deletemydata"), false);
  assert.equal(isDeleteCommand("delete my data"), false);
  assert.equal(isDeleteCommand(undefined), false);
});

test("session keys match a tenant by instance id, never by prefix", () => {
  const key = (parts: string[]) => `flue:sess:agent-session:${JSON.stringify(parts)}`;
  assert.equal(isTenantSessionKey(key(["123", "default", "123"]), "123"), true);
  assert.equal(isTenantSessionKey(key(["1234", "default", "1234"]), "123"), false);
  assert.equal(isTenantSessionKey(key(["im:+491701234567"]), "im:+491701234567"), true);
  assert.equal(isTenantSessionKey("flue:sess:agent-session:not-json", "123"), false);
  assert.equal(isTenantSessionKey("t:123:profile", "123"), false);
});

test("a tenant's keys are its t: keys plus its own conversation", async () => {
  const all = [
    "t:123:profile",
    "t:123:placelist:abc",
    "t:1234:profile",
    'flue:sess:agent-session:["123","default","123"]',
    'flue:sess:agent-session:["1234","default","1234"]',
    "ident:phone:+491701234567",
  ];
  const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  // Two pages per match, to exercise the cursor loop.
  const scan = (async (cursor: string, opts: { match: string }) => {
    const hits = all.filter((k) => glob(opts.match).test(k));
    return cursor === "0" ? ["7", hits.slice(0, 1)] : ["0", hits.slice(1)];
  }) as never;
  assert.deepEqual(await findTenantKeys("123", { scan }), [
    "t:123:profile",
    "t:123:placelist:abc",
    'flue:sess:agent-session:["123","default","123"]',
  ]);
});

test("dashboard links land on the right section", () => {
  assert.equal(dashboardPath("saved", "0123456789ab"), "/dashboard/saved/0123456789ab");
  assert.equal(dashboardPath("saved", "../../etc"), "/dashboard/saved");
  assert.equal(dashboardPath("you"), "/dashboard/you");
  assert.equal(dashboardPath("health"), "/dashboard");
});
