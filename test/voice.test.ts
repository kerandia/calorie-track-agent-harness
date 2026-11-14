import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isCaf, opusPacketSamples } from "../.flue/lib/caf.js";
import { sttAudio } from "../.flue/lib/stt.js";

// An Opus-in-CAF voice memo as Apple's own encoder writes it (afconvert,
// 24 kHz mono — the iMessage format): 145 packets, ~2.9 s of synthetic speech.
const memo = new Uint8Array(readFileSync(new URL("./fixtures/imessage-voice.caf", import.meta.url)));

const ascii = (b: Uint8Array, start: number, end: number) => String.fromCharCode(...b.subarray(start, end));

/** Bit-by-bit Ogg CRC, written independently of caf.ts's table-driven one. */
function oggCrcBitwise(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) {
    crc = (crc ^ (b << 24)) >>> 0;
    for (let i = 0; i < 8; i++) crc = (crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1) >>> 0;
  }
  return crc;
}

type Page = { flags: number; granule: bigint; seq: number; packets: Uint8Array[] };

/** Split an Ogg stream into pages and packets, checking every page's CRC. */
function readOgg(bytes: Uint8Array): Page[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pages: Page[] = [];
  for (let off = 0; off < bytes.length; ) {
    assert.equal(ascii(bytes, off, off + 4), "OggS");
    const lacing = bytes.subarray(off + 27, off + 27 + bytes[off + 26]!);
    assert.notEqual(lacing.at(-1), 255, "every packet ends on its own page");
    const end = off + 27 + lacing.length + lacing.reduce((s, n) => s + n, 0);
    const blanked = bytes.slice(off, end);
    blanked.fill(0, 22, 26);
    assert.equal(oggCrcBitwise(blanked), view.getUint32(off + 22, true), `page CRC at ${off}`);

    const packets: Uint8Array[] = [];
    let at = off + 27 + lacing.length;
    let size = 0;
    for (const n of lacing) {
      size += n;
      if (n < 255) {
        packets.push(bytes.subarray(at, at + size));
        at += size;
        size = 0;
      }
    }
    pages.push({
      flags: bytes[off + 5]!,
      granule: view.getBigInt64(off + 6, true),
      seq: view.getUint32(off + 18, true),
      packets,
    });
    off = end;
  }
  return pages;
}

/** The raw Opus bytes in a CAF's data chunk (after its 4-byte edit count). */
function cafAudioBytes(caf: Uint8Array): Uint8Array {
  const view = new DataView(caf.buffer, caf.byteOffset, caf.byteLength);
  for (let off = 8; off + 12 <= caf.length; ) {
    const size = Number(view.getBigInt64(off + 4, false));
    if (ascii(caf, off, off + 4) === "data") return caf.subarray(off + 16, off + 12 + size);
    off += 12 + size;
  }
  throw new Error("no data chunk");
}

test("an iMessage CAF voice memo is re-wrapped as valid Ogg Opus without touching the audio", () => {
  assert.ok(isCaf(memo));
  const { audio, format } = sttAudio(memo, "audio/x-caf");
  assert.equal(format, "ogg");

  const pages = readOgg(audio);
  assert.deepEqual(pages.map((p) => p.seq), pages.map((_, i) => i));
  assert.equal(pages[0]!.flags, 0x02, "first page opens the stream");
  assert.equal(pages.at(-1)!.flags, 0x04, "last page closes it");

  const head = pages[0]!.packets[0]!;
  const headView = new DataView(head.buffer, head.byteOffset, head.byteLength);
  assert.equal(ascii(head, 0, 8), "OpusHead");
  assert.equal(head[9], 1, "mono");
  assert.equal(headView.getUint16(10, true), 312, "pre-skip: 156 priming frames at 24 kHz = 312 at 48 kHz");
  assert.equal(headView.getUint32(12, true), 24000);
  assert.equal(ascii(pages[1]!.packets[0]!, 0, 8), "OpusTags");

  // Every Opus byte arrives, in order, and nothing else is added.
  const audioPackets = pages.slice(2).flatMap((p) => p.packets);
  assert.equal(audioPackets.length, 145);
  assert.deepEqual(Buffer.concat(audioPackets), Buffer.from(cafAudioBytes(memo)));

  // Granule positions count 48 kHz samples: 145 × 20 ms = 2.9 s.
  const granules = pages.map((p) => p.granule);
  assert.deepEqual([...granules].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), granules);
  assert.equal(granules.at(-1), 145n * 960n);
});

test("Opus packet durations come from the TOC byte", () => {
  assert.equal(opusPacketSamples(Uint8Array.of(0x08)), 960); // SILK 20 ms, one frame
  assert.equal(opusPacketSamples(Uint8Array.of(0x69)), 1920); // hybrid 20 ms, two frames
  assert.equal(opusPacketSamples(Uint8Array.of(0xfb, 0x03)), 2880); // CELT 20 ms, three frames
  assert.equal(opusPacketSamples(Uint8Array.of(0x80)), 120); // CELT 2.5 ms
  assert.equal(opusPacketSamples(new Uint8Array(0)), 0);
});

test("old AMR memos and damaged CAFs fail loudly; other audio passes through untouched", () => {
  // A pre-iOS 12.2 memo: CAF holding AMR ('samr').
  const amr = new Uint8Array(8 + 12 + 32 + 12 + 8);
  const v = new DataView(amr.buffer);
  amr.set(Buffer.from("caff\x00\x01\x00\x00desc", "latin1"), 0);
  v.setBigInt64(12, 32n);
  v.setFloat64(20, 8000);
  amr.set(Buffer.from("samr", "latin1"), 28);
  v.setUint32(40, 160); // frames per packet
  v.setUint32(44, 1); // channels
  amr.set(Buffer.from("data", "latin1"), 52);
  v.setBigInt64(56, 8n);
  assert.throws(() => sttAudio(amr, "audio/x-caf"), /samr audio; only Opus/);

  assert.throws(() => sttAudio(memo.subarray(0, memo.length - 2000), "audio/x-caf"), /truncated/i);

  const telegramOgg = Uint8Array.from(Buffer.from("OggS\x00\x02rest-of-a-voice-note", "latin1"));
  const passed = sttAudio(telegramOgg, "audio/ogg");
  assert.equal(passed.audio, telegramOgg);
  assert.equal(passed.format, "ogg");
  assert.equal(sttAudio(Uint8Array.of(0, 0, 0, 0x20), "audio/x-m4a").format, "m4a");
});
