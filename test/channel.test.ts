import assert from "node:assert/strict";
import test from "node:test";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { toBubbles } from "../.flue/lib/channel.js";
import {
  downscaleRgba,
  flattenAlphaToWhite,
  prepareForVision,
  sniffImageMime,
} from "../.flue/lib/images.js";
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

test("transparent PNG pixels composite onto white instead of turning black", async () => {
  // Left pixel: dark foreground (10, 10, 10, 255). Right pixel: transparent (0, 0, 0, 0).
  const png = new PNG({ width: 2, height: 1 });
  png.data = Buffer.from([10, 10, 10, 255, 0, 0, 0, 0]);
  const rawPng = new Uint8Array(PNG.sync.write(png));

  const out = await prepareForVision(rawPng, "image/png");
  assert.ok(out);
  assert.equal(out.mimeType, "image/jpeg");
  const decoded = jpeg.decode(Buffer.from(out.base64, "base64"), { useTArray: true });
  // Left stays dark; right becomes bright white instead of (0, 0, 0) black.
  assert.ok(decoded.data[0]! < 40);
  assert.ok(decoded.data[4]! > 220 && decoded.data[5]! > 220 && decoded.data[6]! > 220);

  const flat = flattenAlphaToWhite(Uint8Array.from([20, 40, 60, 0, 10, 20, 30, 255]));
  assert.deepEqual(Array.from(flat), [255, 255, 255, 255, 10, 20, 30, 255]);
});

test("opaque small PNGs pass through; oversized PNG screenshots are downscaled", async () => {
  const smallPng = new PNG({ width: 8, height: 8 });
  smallPng.data.fill(255);
  const smallBytes = new Uint8Array(PNG.sync.write(smallPng));
  const kept = await prepareForVision(smallBytes, "image/png");
  assert.equal(kept?.mimeType, "image/png");
  assert.equal(kept?.base64, Buffer.from(smallBytes).toString("base64"));

  const tallPng = new PNG({ width: 400, height: 2400 });
  tallPng.data.fill(200);
  for (let i = 3; i < tallPng.data.length; i += 4) tallPng.data[i] = 255;
  const shrunk = await prepareForVision(new Uint8Array(PNG.sync.write(tallPng)), "image/png");
  assert.ok(shrunk);
  assert.equal(shrunk.mimeType, "image/jpeg");
  const decoded = jpeg.decode(Buffer.from(shrunk.base64, "base64"), { useTArray: true });
  assert.ok(Math.max(decoded.width, decoded.height) <= 1600);
});

test("empty or truncated images are rejected instead of sent blank", async () => {
  assert.equal(await prepareForVision(new Uint8Array(0), "image/jpeg"), null);
  assert.equal(await prepareForVision(new Uint8Array(0), "image/png"), null);

  const validJpeg = jpeg.encode({ data: new Uint8Array(16 * 16 * 4).fill(180), width: 16, height: 16 }, 80).data;
  const truncatedJpeg = validJpeg.subarray(0, validJpeg.length - 4);
  await assert.rejects(() => prepareForVision(truncatedJpeg, "image/jpeg"), /Truncated/i);

  const png = new PNG({ width: 16, height: 16 });
  png.data.fill(180);
  const validPng = new Uint8Array(PNG.sync.write(png));
  const truncatedPng = validPng.subarray(0, Math.floor(validPng.length / 2));
  await assert.rejects(() => prepareForVision(truncatedPng, "image/png"));
});

test("magic bytes override mislabeled iMessage MIME headers", async () => {
  const jpg = jpeg.encode({ data: new Uint8Array(8 * 8 * 4).fill(200), width: 8, height: 8 }, 80).data;
  const fromHeicLabel = await prepareForVision(jpg, "image/heic");
  assert.equal(fromHeicLabel?.mimeType, "image/jpeg");
  const fromOctet = await prepareForVision(jpg, "application/octet-stream");
  assert.equal(fromOctet?.mimeType, "image/jpeg");

  // iOS 18 adaptive-HDR 52-byte ftyp (heic + tmap) and mif3 mini-box ftyp sniff as HEIC; QuickTime mov does not.
  const ios18Ftyp = Buffer.from(
    "\x00\x00\x00\x24ftypheic\x00\x00\x00\x00mif1miafMiHBtmapheic",
    "latin1",
  );
  assert.equal(sniffImageMime(ios18Ftyp, "image/jpeg"), "image/heic");
  const mif3Ftyp = Buffer.from("\x00\x00\x00\x14ftypmif3\x00\x00\x00\x00heic", "latin1");
  assert.equal(sniffImageMime(mif3Ftyp, "application/octet-stream"), "image/heic");
  const movFtyp = Buffer.from("\x00\x00\x00\x14ftypqt  \x00\x00\x00\x00qt  ", "latin1");
  assert.equal(sniffImageMime(movFtyp, "image/heic"), null);
});
