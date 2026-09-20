import assert from "node:assert/strict";
import test from "node:test";
import {
  formatInboundMessageLog,
  formatOutboundReplyLog,
  toolResultCharCount,
} from "../src/logging.js";

test("message telemetry keeps content and tenant identifiers out of logs", () => {
  const tenantId = "telegram:447700900123";
  const inboundSecret = "private diagnosis and travel details";
  const outboundSecret = "your private reply";

  const inbound = formatInboundMessageLog({
    tenantId,
    text: inboundSecret,
    imageCount: 2,
    voice: true,
    burstSize: 3,
  });
  const outbound = formatOutboundReplyLog({
    tenantId,
    text: outboundSecret,
    runId: "run-123",
  });

  assert.equal(inbound.includes(tenantId), false);
  assert.equal(inbound.includes(inboundSecret), false);
  assert.equal(outbound.includes(tenantId), false);
  assert.equal(outbound.includes(outboundSecret), false);
  assert.deepEqual(JSON.parse(inbound), {
    evt: "message_received",
    tenantRef: JSON.parse(outbound).tenantRef,
    textChars: inboundSecret.length,
    imageCount: 2,
    voice: true,
    burstSize: 3,
  });
  assert.equal(JSON.parse(outbound).textChars, outboundSecret.length);
});

test("tool telemetry records only result size", () => {
  const secret = "sensitive tool output";
  const result = { content: [{ text: secret }, { text: "more" }] };

  assert.equal(toolResultCharCount(result), secret.length + 4);
  assert.equal(toolResultCharCount("plain"), 5);
  assert.equal(toolResultCharCount({ ok: true }), JSON.stringify({ ok: true }).length);
});
