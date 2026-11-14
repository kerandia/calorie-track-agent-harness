// Apple Core Audio Format (CAF) → Ogg, without decoding a single sample.
//
// iMessage voice memos (iOS 12.2+) are Opus at 24 kHz inside a CAF container.
// The speech-to-text endpoints take Ogg/Opus but reject CAF, so the Opus
// packets are lifted out of the CAF `data` chunk and re-wrapped as Ogg pages
// (RFC 7845): same audio bytes, new envelope. Pure JS on purpose, like
// images.ts — no ffmpeg in the container.

const ascii = (bytes: Uint8Array, start: number, end: number): string =>
  String.fromCharCode(...bytes.subarray(start, end));

const latin1 = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

export const isCaf = (bytes: Uint8Array): boolean =>
  bytes.length >= 8 && ascii(bytes, 0, 4) === "caff";

type CafAudio = {
  sampleRate: number;
  channels: number;
  primingFrames: number;
  packets: Uint8Array[];
};

/** CAF packet-table sizes are big-endian base-128 varints. */
function readVarint(bytes: Uint8Array, pos: { at: number }, end: number): number {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (pos.at >= end) throw new Error("CAF packet table is truncated");
    const b = bytes[pos.at++]!;
    value = value * 128 + (b & 0x7f);
    if ((b & 0x80) === 0) return value;
  }
  throw new Error("CAF packet table has an oversized entry");
}

function parseOpusCaf(bytes: Uint8Array): CafAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let desc: { start: number } | undefined;
  let pakt: { start: number; end: number } | undefined;
  let audio: Uint8Array | undefined;

  for (let off = 8; off + 12 <= bytes.length; ) {
    const type = ascii(bytes, off, off + 4);
    const declared = view.getBigInt64(off + 4, false);
    const start = off + 12;
    // A `data` chunk may declare size -1: "runs to the end of the file".
    const size = declared === -1n && type === "data" ? bytes.length - start : Number(declared);
    if (size < 0 || start + size > bytes.length) throw new Error(`CAF ${type} chunk is truncated`);
    if (type === "desc" && size >= 32) desc = { start };
    else if (type === "pakt" && size >= 24) pakt = { start, end: start + size };
    else if (type === "data" && size >= 4) audio = bytes.subarray(start + 4, start + size); // skip mEditCount
    off = start + size;
  }
  if (!desc || !audio) throw new Error("CAF is missing its desc or data chunk");

  const sampleRate = view.getFloat64(desc.start, false);
  const formatId = ascii(bytes, desc.start + 8, desc.start + 12);
  const bytesPerPacket = view.getUint32(desc.start + 16, false);
  const framesPerPacket = view.getUint32(desc.start + 20, false);
  const channels = view.getUint32(desc.start + 24, false);
  if (formatId !== "opus") {
    throw new Error(`CAF holds ${formatId.trim() || "unknown"} audio; only Opus can be transcribed`);
  }
  if (channels < 1 || channels > 2) throw new Error(`CAF Opus with ${channels} channels isn't supported`);

  const packets: Uint8Array[] = [];
  let primingFrames = 0;
  if (bytesPerPacket > 0) {
    for (let at = 0; at + bytesPerPacket <= audio.length; at += bytesPerPacket) {
      packets.push(audio.subarray(at, at + bytesPerPacket));
    }
  } else {
    if (!pakt) throw new Error("variable-size CAF has no packet table");
    const count = Number(view.getBigInt64(pakt.start, false));
    primingFrames = view.getInt32(pakt.start + 16, false);
    const pos = { at: pakt.start + 24 };
    let at = 0;
    for (let i = 0; i < count; i++) {
      const size = readVarint(bytes, pos, pakt.end);
      if (framesPerPacket === 0) readVarint(bytes, pos, pakt.end);
      if (at + size > audio.length) throw new Error("CAF audio data is truncated");
      packets.push(audio.subarray(at, at + size));
      at += size;
    }
  }
  return { sampleRate, channels, primingFrames: Math.max(0, primingFrames), packets };
}

/** Samples (at 48 kHz, Ogg Opus's clock) in one Opus packet, from its TOC byte. */
export function opusPacketSamples(packet: Uint8Array): number {
  if (packet.length === 0) return 0;
  const toc = packet[0]!;
  const config = toc >> 3;
  const frame =
    config < 12
      ? [480, 960, 1920, 2880][config & 3]! // SILK: 10/20/40/60 ms
      : config < 16
        ? [480, 960][config & 1]! // hybrid: 10/20 ms
        : [120, 240, 480, 960][config & 3]!; // CELT: 2.5/5/10/20 ms
  const code = toc & 3;
  const frames = code === 0 ? 1 : code === 3 ? (packet[1] ?? 0) & 0x3f : 2;
  return frame * frames;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

/** Ogg's CRC-32: polynomial 0x04c11db7, unreflected, zero initial value. */
function oggCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b) & 0xff]!) >>> 0;
  return crc;
}

const OGG_BOS = 0x02;
const OGG_EOS = 0x04;
const SERIAL = 0x5e2a0001;

function oggPage(packets: Uint8Array[], granule: bigint, seq: number, flags: number): Uint8Array {
  const lacing: number[] = [];
  for (const p of packets) {
    let n = p.length;
    for (; n >= 255; n -= 255) lacing.push(255);
    lacing.push(n);
  }
  const bodyLength = packets.reduce((sum, p) => sum + p.length, 0);
  const page = new Uint8Array(27 + lacing.length + bodyLength);
  const view = new DataView(page.buffer);
  page.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
  page[5] = flags;
  view.setBigInt64(6, granule, true);
  view.setUint32(14, SERIAL, true);
  view.setUint32(18, seq, true);
  page[26] = lacing.length;
  page.set(lacing, 27);
  let at = 27 + lacing.length;
  for (const p of packets) {
    page.set(p, at);
    at += p.length;
  }
  view.setUint32(22, oggCrc(page), true);
  return page;
}

const lacingCount = (p: Uint8Array): number => Math.floor(p.length / 255) + 1;

/**
 * Re-wrap a CAF holding Opus (an iMessage voice memo) as an Ogg Opus file.
 * Throws on other codecs (pre-iOS 12.2 memos were AMR) and on damaged files.
 */
export function cafToOgg(bytes: Uint8Array): Uint8Array {
  const caf = parseOpusCaf(bytes);
  const packets = caf.packets.filter((p) => p.length > 0);
  if (packets.length === 0) throw new Error("CAF has no audio packets");

  const head = new Uint8Array(19);
  const headView = new DataView(head.buffer);
  head.set(latin1("OpusHead"), 0);
  head[8] = 1; // version
  head[9] = caf.channels;
  headView.setUint16(10, Math.min(0xffff, Math.round((caf.primingFrames * 48000) / caf.sampleRate)), true);
  headView.setUint32(12, Math.round(caf.sampleRate), true);
  // bytes 16–17 output gain 0, byte 18 channel mapping family 0 (mono/stereo)

  const vendor = new TextEncoder().encode("sezar caf remux");
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  tags.set(latin1("OpusTags"), 0);
  new DataView(tags.buffer).setUint32(8, vendor.length, true);
  tags.set(vendor, 12); // user comment count stays 0

  const pages: Uint8Array[] = [oggPage([head], 0n, 0, OGG_BOS), oggPage([tags], 0n, 1, 0)];
  let granule = 0n;
  let batch: Uint8Array[] = [];
  let segments = 0;
  const flush = (last: boolean) => {
    pages.push(oggPage(batch, granule, pages.length, last ? OGG_EOS : 0));
    batch = [];
    segments = 0;
  };
  for (const p of packets) {
    const need = lacingCount(p);
    if (need > 255) throw new Error("Opus packet too large for an Ogg page");
    if (segments + need > 255) flush(false);
    batch.push(p);
    segments += need;
    granule += BigInt(opusPacketSamples(p));
  }
  flush(true);

  const out = new Uint8Array(pages.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const p of pages) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
