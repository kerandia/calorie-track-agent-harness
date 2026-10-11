import decodeHeic from "heic-decode";
import jpeg from "jpeg-js";

// Inbound photos → something the vision models accept, at a sane size.
//
// Telegram already hands us a ≤2560px JPEG. iMessage hands over the original:
// usually a 12MP HEIC, which the vision endpoints reject, and which would be a
// ~5MB base64 payload per photo even as JPEG. HEIC (and oversized JPEG) is
// decoded, box-downscaled to at most MAX_EDGE px, and re-encoded as JPEG.
// Pure JS/wasm on purpose: no native image library in the container.

const MAX_EDGE = 1600;
const JPEG_QUALITY = 82;
/** JPEGs at or under this size pass through untouched. */
const PASSTHROUGH_JPEG_BYTES = 1_500_000;
const PASSTHROUGH_TYPES = new Set(["image/png", "image/webp", "image/gif"]);

export type VisionImage = { base64: string; mimeType: string };

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/** Average each k×k block of RGBA pixels into one. */
export function downscaleRgba(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  maxEdge = MAX_EDGE,
): { data: Uint8Array; width: number; height: number } {
  const k = Math.ceil(Math.max(width, height) / maxEdge);
  if (k <= 1) return { data: Uint8Array.from(data), width, height };
  const w = Math.floor(width / k);
  const h = Math.floor(height / k);
  const out = new Uint8Array(w * h * 4);
  const area = k * k;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < k; dy++) {
        let i = ((y * k + dy) * width + x * k) * 4;
        for (let dx = 0; dx < k; dx++, i += 4) {
          r += data[i]!;
          g += data[i + 1]!;
          b += data[i + 2]!;
          a += data[i + 3]!;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / area;
      out[o + 1] = g / area;
      out[o + 2] = b / area;
      out[o + 3] = a / area;
    }
  }
  return { data: out, width: w, height: h };
}

const encodeJpeg = (img: { data: Uint8Array; width: number; height: number }): VisionImage => ({
  base64: toBase64(jpeg.encode(img, JPEG_QUALITY).data),
  mimeType: "image/jpeg",
});

/** Null for anything that isn't a still image we can hand to vision. */
export async function prepareForVision(
  bytes: Uint8Array,
  mimeType: string,
): Promise<VisionImage | null> {
  const type = mimeType.toLowerCase();
  if (type === "image/heic" || type === "image/heif") {
    const decoded = await decodeHeic({ buffer: bytes });
    return encodeJpeg(downscaleRgba(decoded.data, decoded.width, decoded.height));
  }
  if (type === "image/jpeg" || type === "image/jpg") {
    if (bytes.length <= PASSTHROUGH_JPEG_BYTES) return { base64: toBase64(bytes), mimeType: "image/jpeg" };
    const decoded = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
    return encodeJpeg(downscaleRgba(decoded.data, decoded.width, decoded.height));
  }
  if (PASSTHROUGH_TYPES.has(type)) return { base64: toBase64(bytes), mimeType: type };
  return null;
}
