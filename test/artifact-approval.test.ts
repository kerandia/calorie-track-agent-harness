import assert from "node:assert/strict";
import test from "node:test";
import {
  requestArtifactApproval,
  resolveApprovalReply,
  type PendingArtifactAction,
} from "../.flue/lib/artifactApproval.js";

function approvalStore() {
  const values = new Map<string, unknown>();
  return {
    async set(key: string, value: unknown, opts?: { nx?: boolean }) {
      if (opts?.nx && values.has(key)) return null;
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

const pending: PendingArtifactAction = { action: "publish_page", args: { title: "Private plan" } };

test("the explicit command is standalone, one-time, and tenant-scoped", async () => {
  const db = approvalStore();
  const token = await requestArtifactApproval("tenant-a", pending, db as never);

  assert.match(token, /^[a-f0-9-]{36}$/);
  assert.equal(await resolveApprovalReply("tenant-a", `please /approve ${token}`, db as never), undefined);
  assert.deepEqual(await resolveApprovalReply("tenant-b", `/approve ${token}`, db as never), {
    decision: "approve",
    pending: null,
  });
  assert.deepEqual(await resolveApprovalReply("tenant-a", `/approve ${token}`, db as never), {
    decision: "approve",
    pending,
  });
  assert.deepEqual(await resolveApprovalReply("tenant-a", `/approve ${token}`, db as never), {
    decision: "approve",
    pending: null,
  });
});

test("a plain yes approves the latest draft once; with nothing pending it's just a message", async () => {
  const db = approvalStore();
  await requestArtifactApproval("tenant-a", { action: "publish_map", args: { title: "older" } }, db as never);
  await requestArtifactApproval("tenant-a", pending, db as never);

  assert.equal(await resolveApprovalReply("tenant-b", "yes", db as never), undefined);
  assert.deepEqual(await resolveApprovalReply("tenant-a", "  Yes! ", db as never), { decision: "approve", pending });
  // The latest draft is used up, and an older one never rides on a later "yes".
  assert.equal(await resolveApprovalReply("tenant-a", "yes", db as never), undefined);
  // Sentences are never decisions, even with a draft waiting.
  await requestArtifactApproval("tenant-a", pending, db as never);
  assert.equal(await resolveApprovalReply("tenant-a", "yes but change the title", db as never), undefined);
  assert.deepEqual(await resolveApprovalReply("tenant-a", "evet", db as never), { decision: "approve", pending });
});

test("no / iptal / a cancel tap scraps the draft", async () => {
  const db = approvalStore();
  await requestArtifactApproval("tenant-a", pending, db as never);
  assert.deepEqual(await resolveApprovalReply("tenant-a", "iptal", db as never), { decision: "cancel", cancelled: true });
  assert.equal(await resolveApprovalReply("tenant-a", "yes", db as never), undefined);

  const token = await requestArtifactApproval("tenant-a", pending, db as never);
  assert.deepEqual(await resolveApprovalReply("tenant-a", `/cancel ${token}`, db as never), {
    decision: "cancel",
    cancelled: true,
  });
  // The button already decided it: a later "yes" is just a message.
  assert.equal(await resolveApprovalReply("tenant-a", "yes", db as never), undefined);
});
