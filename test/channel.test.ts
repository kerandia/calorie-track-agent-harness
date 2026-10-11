import assert from "node:assert/strict";
import test from "node:test";
import jpeg from "jpeg-js";
import { toBubbles } from "../.flue/lib/channel.js";
import { downscaleRgba, prepareForVision } from "../.flue/lib/images.js";
import { audioFormatFor } from "../.flue/lib/stt.js";
import { telegramInboxItem } from "../.flue/lib/telegramApi.js";

test("replies past the bubble cap stay together instead of being dropped", () => {
  const reply = "logged. 480 kcal\n\nyou're at 1.4k today\n\nday 1: lisbon\n\nday 2: sintra";
  assert.deepEqual(toBubbles(reply, 3), [
    "logged. 480 kcal",
    "you're at 1.4k today",
    "day 1: lisbon\n\nday 2: sintra",
  ]);
  assert.deepEqual(toBubbles(reply, 1), [
    "logged. 480 kcal\n\nyou're at 1.4k today\n\nday 1: lisbon\n\nday 2: sintra",
  ]);
  assert.deepEqual(toBubbles("one thought", 3), ["one thought"]);
});

test("a Telegram message normalizes to the largest photo and keeps the album flag", () => {
  const item = telegramInboxItem(
    42,
    {
      message_id: 7,
      caption: " dinner ",
      media_group_id: "album-1",
      photo: [{ file_id: "small" }, { file_id: "large" }],
    },
    1000,
  );
  assert.deepEqual(item, {
    id: "42",
    received_at: 1000,
    text: "dinner",
    photos: [{ ref: "large", mimeType: "image/jpeg" }],
    album: true,
  });
});

test("voice-note MIME types map to transcription formats", () => {
  assert.equal(audioFormatFor("audio/ogg"), "ogg");
  assert.equal(audioFormatFor("audio/x-m4a"), "m4a");
  assert.equal(audioFormatFor("audio/mp4; codecs=mp4a.40.2"), "m4a");
  assert.equal(audioFormatFor(undefined), "ogg");
});

test("downscaling averages each block of pixels", () => {
  // 4×2 image: left 2×2 block black, right 2×2 block white → 2×1 at maxEdge 2.
  const px = (v: number) => [v, v, v, 255];
  const data = Uint8Array.from([...px(0), ...px(0), ...px(255), ...px(255), ...px(0), ...px(0), ...px(255), ...px(255)]);
  const out = downscaleRgba(data, 4, 2, 2);
  assert.equal(out.width, 2);
  assert.equal(out.height, 1);
  assert.deepEqual(Array.from(out.data), [...px(0), ...px(255)]);
});

test("an oversized JPEG is shrunk to the vision size; a small one passes through", async () => {
  const width = 3200;
  const height = 2400;
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 2654435761) >>> 24; // noise: big file
  const big = jpeg.encode({ data, width, height }, 95).data;
  assert.ok(big.length > 1_500_000);

  const shrunk = await prepareForVision(big, "image/jpeg");
  assert.ok(shrunk);
  const decoded = jpeg.decode(Buffer.from(shrunk.base64, "base64"), { useTArray: true });
  assert.ok(Math.max(decoded.width, decoded.height) <= 1600);

  const small = jpeg.encode({ data: new Uint8Array(16 * 16 * 4), width: 16, height: 16 }, 80).data;
  const same = await prepareForVision(small, "image/jpeg");
  assert.equal(same?.base64, Buffer.from(small).toString("base64"));

  assert.equal(await prepareForVision(small, "video/quicktime"), null);
});
