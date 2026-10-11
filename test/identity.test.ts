import assert from "node:assert/strict";
import test from "node:test";
import { normalizePhone } from "../.flue/lib/identity.js";
import { leadingRun, type InboxItem, type ReplyRoute } from "../.flue/lib/inbox.js";

test("Telegram and Apple number formats normalize to the same E.164 key", () => {
  assert.equal(normalizePhone("491701234567"), "+491701234567"); // Telegram contact
  assert.equal(normalizePhone("+491701234567"), "+491701234567"); // Apple handle
  assert.equal(normalizePhone(" +49 (170) 123-4567 "), "+491701234567");
});

test("email handles and junk are not phone numbers", () => {
  assert.equal(normalizePhone("jane.doe@icloud.com"), null);
  assert.equal(normalizePhone("12345"), null);
  assert.equal(normalizePhone("+0123456789"), null);
  assert.equal(normalizePhone("call me maybe"), null);
});

const tg: ReplyRoute = { channel: "telegram", chatId: 42 };
const im: ReplyRoute = { channel: "imessage", spaceId: "any;-;+491701234567", phone: "shared" };
const item = (id: string, via?: ReplyRoute): InboxItem => ({ id, received_at: 0, text: id, ...(via ? { via } : {}) });

test("a linked user's inbox is answered one conversation at a time, in order", () => {
  const items = [item("a", tg), item("b", tg), item("c", im), item("d", tg)];
  const first = leadingRun(items, tg);
  assert.deepEqual(first.route, tg);
  assert.deepEqual(first.items.map((i) => i.id), ["a", "b"]);
  assert.equal(first.closed, true);

  const second = leadingRun(items.slice(2), tg);
  assert.deepEqual(second.route, im);
  assert.deepEqual(second.items.map((i) => i.id), ["c"]);
});

test("items without a route belong to the draining job's conversation", () => {
  const run = leadingRun([item("old"), item("new", tg)], tg);
  assert.deepEqual(run.items.map((i) => i.id), ["old", "new"]);
  assert.equal(run.closed, false);
  assert.deepEqual(leadingRun([], im), { route: im, items: [], closed: false });
});
