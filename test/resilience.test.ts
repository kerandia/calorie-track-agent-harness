import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { shellQuote } from "../.flue/lib/box.js";
import { aliasKey } from "../.flue/lib/identity.js";
import { isDegraded } from "../.flue/lib/modelHealth.js";

test("the provider counts as degraded only on a slow median of enough calls", () => {
  assert.equal(isDegraded([90_000, 120_000]), false); // too few to judge
  assert.equal(isDegraded([3_000, 4_000, 250_000]), false); // one outlier
  assert.equal(isDegraded([70_000, 3_000, 140_000]), true);
  assert.equal(isDegraded([3_100, 3_500, 4_000, 2_900, 3_800]), false);
});

test("wrapped sandbox commands keep their exact meaning", () => {
  const cmd = `echo 'it''s' "a \\"b\\"" $HOME; printf '%s' x`;
  const direct = execFileSync("sh", ["-c", cmd], { env: { HOME: "/h" } }).toString();
  const wrapped = execFileSync("sh", ["-c", `sh -c ${shellQuote(cmd)}`], { env: { HOME: "/h" } }).toString();
  assert.equal(wrapped, direct);
});

test("linked iMessage handles key by number or by Apple ID email", () => {
  assert.equal(aliasKey("+49 152 0529 2972"), "ident:phone:+4915205292972");
  assert.equal(aliasKey("Jane.Doe@iCloud.com"), "ident:handle:jane.doe@icloud.com");
});
