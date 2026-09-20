import assert from "node:assert/strict";
import test from "node:test";
import {
  consumeArtifactApproval,
  requestArtifactApproval,
  type PendingArtifactAction,
} from "../.flue/lib/artifactApproval.js";

function approvalStore() {
  const values = new Map<string, unknown>();
  return {
    async set(key: string, value: unknown) {
      if (values.has(key)) return null;
      values.set(key, value);
      return "OK";
    },
    async getdel<T>(key: string): Promise<T | null> {
      const value = values.get(key);
      values.delete(key);
      return (value as T | undefined) ?? null;
    },
  };
}

test("artifact approval is standalone, one-time, and tenant-scoped", async () => {
  const db = approvalStore();
  const pending: PendingArtifactAction = {
    action: "publish_page",
    args: { title: "Private plan" },
  };
  const token = await requestArtifactApproval("tenant-a", pending, db as never);

  assert.match(token, /^[a-f0-9-]{36}$/);
  assert.equal(
    await consumeArtifactApproval("tenant-a", `please /approve ${token}`, db as never),
    undefined,
  );
  assert.equal(
    await consumeArtifactApproval("tenant-b", `/approve ${token}`, db as never),
    null,
  );
  assert.deepEqual(
    await consumeArtifactApproval("tenant-a", `/approve ${token}`, db as never),
    pending,
  );
  assert.equal(
    await consumeArtifactApproval("tenant-a", `/approve ${token}`, db as never),
    null,
  );
});
