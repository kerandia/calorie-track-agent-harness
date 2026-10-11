import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { parseImessageWebhook } from "../.flue/lib/imessage.js";

const SECRET = "test-signing-secret";
const NOW = Date.parse("2026-10-05T12:00:00Z");

const dm = { id: "any;-;+15550100", platform: "iMessage", type: "dm", phone: "shared" };

function delivery(content: unknown, overrides: Record<string, unknown> = {}) {
  return {
    event: "messages",
    space: dm,
    message: {
      id: "spc-msg-00000000-0000-4000-8000-000000000001",
      platform: "iMessage",
      direction: "inbound",
      timestamp: "2026-10-05T11:59:58.000Z",
      sender: { id: "+15550100", platform: "iMessage" },
      space: dm,
      content,
      ...overrides,
    },
  };
}

function signed(body: unknown, opts: { secret?: string; ts?: number } = {}) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor((opts.ts ?? NOW) / 1000));
  const sig = createHmac("sha256", opts.secret ?? SECRET).update(`v0:${ts}:${raw}`).digest("hex");
  return {
    rawBody: new TextEncoder().encode(raw),
    headers: {
      "content-type": "application/json",
      "x-spectrum-event": "messages",
      "x-spectrum-timestamp": ts,
      "x-spectrum-signature": `v0=${sig}`,
    },
    secret: SECRET,
    now: NOW,
  };
}

test("a signed text DM becomes an inbox item for the sender's tenant", async () => {
  const r = await parseImessageWebhook(signed(delivery({ type: "text", text: " hi, had 2 eggs " })));
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.delivery);
  assert.equal(r.delivery.tenantId, "im:+15550100");
  assert.equal(r.delivery.spaceId, "any;-;+15550100");
  assert.equal(r.delivery.phone, "shared");
  assert.equal(r.delivery.handle, "+15550100");
  assert.deepEqual(r.delivery.item?.via, { channel: "imessage", spaceId: "any;-;+15550100", phone: "shared" });
  assert.equal(r.delivery.item?.id, "spc-msg-00000000-0000-4000-8000-000000000001");
  assert.equal(r.delivery.item?.text, "hi, had 2 eggs");
});

test("a wrong signature or a stale timestamp is rejected with 401", async () => {
  const body = delivery({ type: "text", text: "hi" });
  const forged = await parseImessageWebhook({ ...signed(body, { secret: "other" }), secret: SECRET });
  assert.deepEqual(forged, { ok: false, status: 401, reason: "signature-mismatch" });

  const stale = await parseImessageWebhook(signed(body, { ts: NOW - 10 * 60_000 }));
  assert.deepEqual(stale, { ok: false, status: 401, reason: "expired" });
});

test("a tampered body fails verification", async () => {
  const req = signed(delivery({ type: "text", text: "hi" }));
  const tampered = new TextDecoder().decode(req.rawBody).replace("hi", "yo");
  const r = await parseImessageWebhook({ ...req, rawBody: new TextEncoder().encode(tampered) });
  assert.equal(r.ok, false);
});

test("an album keeps every photo; an audio attachment becomes the voice note", async () => {
  const album = {
    type: "group",
    items: [
      { id: "p:0/m1", content: { type: "attachment", id: "GUID-1", name: "IMG_1.HEIC", mimeType: "image/heic", size: 1 } },
      { id: "p:1/m1", content: { type: "attachment", id: "GUID-2", name: "IMG_2.HEIC", mimeType: "IMAGE/HEIC", size: 1 } },
      { id: "p:2/m1", content: { type: "text", text: "lunch + dinner" } },
    ],
  };
  const r = await parseImessageWebhook(signed(delivery(album)));
  assert.ok(r.ok && r.delivery?.item);
  assert.deepEqual(r.delivery.item.photos, [
    { ref: "GUID-1", mimeType: "image/heic" },
    { ref: "GUID-2", mimeType: "image/heic" },
  ]);
  assert.equal(r.delivery.item.text, "lunch + dinner");

  const memo = await parseImessageWebhook(
    signed(delivery({ type: "attachment", id: "GUID-3", name: "Audio.m4a", mimeType: "audio/x-m4a" })),
  );
  assert.ok(memo.ok && memo.delivery?.item);
  assert.deepEqual(memo.delivery.item.voice, { ref: "GUID-3", mimeType: "audio/x-m4a" });
});

test("tapbacks, outbound echoes and group chats are acknowledged but not queued", async () => {
  const tapback = await parseImessageWebhook(
    signed(delivery({ type: "reaction", emoji: "❤️", target: { id: "spc-msg-x" } })),
  );
  assert.ok(tapback.ok);
  assert.equal(tapback.delivery?.item, null);

  const outbound = await parseImessageWebhook(
    signed(delivery({ type: "text", text: "hi" }, { direction: "outbound" })),
  );
  assert.deepEqual(outbound, { ok: true, delivery: null });

  const groupSpace = { ...dm, id: "chat123456", type: "group" };
  const group = await parseImessageWebhook(
    signed({ ...delivery({ type: "text", text: "hi all" }), space: groupSpace }),
  );
  assert.deepEqual(group, { ok: true, delivery: null });
});

test("email handles are lowercased into a stable tenant id", async () => {
  const r = await parseImessageWebhook(
    signed(
      delivery({ type: "text", text: "hey" }, { sender: { id: "Jane.Doe@iCloud.com", platform: "iMessage" } }),
    ),
  );
  assert.ok(r.ok && r.delivery);
  assert.equal(r.delivery.tenantId, "im:jane.doe@icloud.com");
});
