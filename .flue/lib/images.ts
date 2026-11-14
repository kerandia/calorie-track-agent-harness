/// <reference path="./libheif-js.d.ts" />
import jpeg from "jpeg-js";
import libheif from "libheif-js/wasm-bundle.js";
import { PNG } from "pngjs";

// Inbound photos → something the vision models accept, at a sane size.
//
// Telegram already hands us a ≤2560px JPEG. iMessage hands over the original:
// usually a 12–48MP HEIC or Retina PNG screenshot, which vision endpoints
// either reject or mishandle (e.g. stripping alpha to solid black), and which
// would be a multi-MB base64 payload per photo. HEIC, transparent/oversized
// PNG, and oversized JPEG are decoded, alpha-composited onto white,
// box-downscaled to at most MAX_EDGE px, and re-encoded as JPEG.
// Pure JS/wasm on purpose: no native image library in the container.

const MAX_EDGE = 1600;
const JPEG_QUALITY = 82;
/** Opaque JPEGs/PNGs at or under this size (and MAX_EDGE for PNG) pass through. */
const PASSTHROUGH_BYTES = 1_500_000;

const HEIF_BRANDS = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "hevm",
  "hevs",
  "mif1",
  "mif2",
  "mif3",
  "msf1",
  "miaf",
  "MiHB",
  "MiHE",
  "MiPr",
  "tmap",
]);

export type VisionImage = { base64: string; mimeType: string };

const toBase64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

const ascii = (bytes: Uint8Array, start: number, end: number): string =>
  String.fromCharCode(...bytes.subarray(start, end));

function isHeifContainer(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || ascii(bytes, 4, 8) !== "ftyp") return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rawSize = view.getUint32(0, false);
  const boxEnd = Math.min(bytes.length, rawSize >= 16 ? rawSize : bytes.length);
  const major = ascii(bytes, 8, 12).replace(/\0/g, "").trim();
  if (HEIF_BRANDS.has(major)) return true;
  for (let offset = 16; offset + 4 <= boxEnd; offset += 4) {
    const brand = ascii(bytes, offset, offset + 4).replace(/\0/g, "").trim();
    if (HEIF_BRANDS.has(brand)) return true;
  }
  return false;
}

/**
 * Sniff the real container format from magic bytes before trusting the
 * channel's MIME header (iMessage/macOS attachments occasionally arrive with
 * `application/octet-stream` or a `.jpg` MIME on HEIC bytes and vice versa).
 */
export function sniffImageMime(bytes: Uint8Array, declaredMime: string): string | null {
  if (bytes.length < 12) return null;
  const clean = (declaredMime.split(";")[0] ?? "").trim().toLowerCase();
  if (clean && clean !== "application/octet-stream" && !clean.startsWith("image/")) {
    return null;
  }

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  const head6 = ascii(bytes, 0, 6);
  if (head6 === "GIF87a" || head6 === "GIF89a") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  if (ascii(bytes, 4, 8) === "ftyp") return isHeifContainer(bytes) ? "image/heic" : null;

  if (clean === "image/jpg") return "image/jpeg";
  if (
    clean === "image/heic" ||
    clean === "image/heif" ||
    clean === "image/jpeg" ||
    clean === "image/png" ||
    clean === "image/webp" ||
    clean === "image/gif"
  ) {
    return clean;
  }
  return null;
}

/**
 * Composite any transparent or semi-transparent RGBA pixels onto solid white.
 * Without this, JPEG encoding (and server-side `RGB` conversion on PNGs) drops
 * the alpha byte and turns `(0, 0, 0, 0)` backgrounds into solid black —
 * making dark text/labels or lifted stickers render as black-on-black.
 */
export function flattenAlphaToWhite(
  data: Uint8Array | Uint8ClampedArray,
  premultiplied = false,
): Uint8Array {
  let hasAlpha = false;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i]! < 255) {
      hasAlpha = true;
      break;
    }
  }
  if (!hasAlpha) {
    return data instanceof Uint8Array
      ? data
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]!;
    if (a === 255) {
      out[i] = data[i]!;
      out[i + 1] = data[i + 1]!;
      out[i + 2] = data[i + 2]!;
      out[i + 3] = 255;
    } else if (a === 0) {
      out[i] = 255;
      out[i + 1] = 255;
      out[i + 2] = 255;
      out[i + 3] = 255;
    } else if (premultiplied) {
      const bg = 255 - a;
      out[i] = Math.min(255, data[i]! + bg);
      out[i + 1] = Math.min(255, data[i + 1]! + bg);
      out[i + 2] = Math.min(255, data[i + 2]! + bg);
      out[i + 3] = 255;
    } else {
      const bg = 255 * (255 - a);
      out[i] = Math.round((data[i]! * a + bg) / 255);
      out[i + 1] = Math.round((data[i + 1]! * a + bg) / 255);
      out[i + 2] = Math.round((data[i + 2]! * a + bg) / 255);
      out[i + 3] = 255;
    }
  }
  return out;
}

/** Average each k×k block of RGBA pixels into one. */
export function downscaleRgba(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  maxEdge = MAX_EDGE,
): { data: Uint8Array; width: number; height: number } {
  const k = Math.ceil(Math.max(width, height) / maxEdge);
  if (k <= 1) return { data: Uint8Array.from(data), width, height };
  const w = Math.max(1, Math.floor(width / k));
  const h = Math.max(1, Math.floor(height / k));
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

/**
 * Decode the primary image in a HEIC/HEIF container via libheif-wasm.
 * Rejects truncated grid images (`_heif_image_get_decoding_warnings > 0`) and
 * missing interleaved output rather than returning blank/solid-filled bitmaps.
 */
async function decodeHeicRgba(bytes: Uint8Array): Promise<{
  data: Uint8Array;
  width: number;
  height: number;
  premultiplied: boolean;
}> {
  await libheif.ready;
  const contiguous =
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes
      : new Uint8Array(bytes);

  const ctx = libheif.heif_context_alloc();
  if (!ctx) throw new Error("Could not allocate HEIF context");
  try {
    const readErr = libheif.heif_context_read_from_memory(ctx, contiguous);
    if (readErr.code !== libheif.heif_error_code.heif_error_Ok) {
      throw new Error(`HEIF parse error: ${readErr.message || "invalid container"}`);
    }

    let handle = libheif.heif_context_get_primary_image_handle(ctx);
    if (!handle || handle.code) {
      const ids = libheif.heif_context_get_list_of_top_level_image_IDs(ctx);
      if (!Array.isArray(ids) || ids.length === 0) {
        throw new Error("HEIF image not found");
      }
      handle = libheif.heif_context_get_image_handle(ctx, ids[0]!);
    }
    if (!handle || handle.code) {
      throw new Error(`HEIF handle error: ${handle?.message || "missing image handle"}`);
    }

    try {
      const decoded = libheif.heif_js_decode_image2(
        handle,
        libheif.heif_colorspace.heif_colorspace_RGB,
        libheif.heif_chroma.heif_chroma_interleaved_RGBA,
      );
      if (!decoded || decoded.code) {
        throw new Error(`HEIF decode error: ${decoded?.message || "decode failed"}`);
      }

      try {
        const imagePtr = decoded.image.ptr ?? decoded.image.$$?.ptr;
        if (
          typeof imagePtr === "number" &&
          libheif._heif_image_get_decoding_warnings(imagePtr, 0, 0, 0) > 0
        ) {
          throw new Error("HEIF image has incomplete or corrupted tiles");
        }

        const interleaved = decoded.channels.find(
          (c) => c.id === libheif.heif_channel.heif_channel_interleaved,
        );
        if (!interleaved || interleaved.width <= 0 || interleaved.height <= 0) {
          throw new Error("HEIF decode produced no interleaved RGBA channel");
        }

        const { width, height, stride } = interleaved;
        const rowBytes = width * 4;
        const rgba = new Uint8Array(rowBytes * height);
        if (stride === rowBytes) {
          rgba.set(interleaved.data.subarray(0, rgba.length));
        } else {
          for (let y = 0; y < height; y++) {
            const srcStart = y * stride;
            rgba.set(interleaved.data.subarray(srcStart, srcStart + rowBytes), y * rowBytes);
          }
        }

        const premultiplied = Boolean(
          libheif.heif_image_is_premultiplied_alpha?.(decoded.image) ||
            libheif.heif_image_handle_is_premultiplied_alpha(handle),
        );
        return { data: rgba, width, height, premultiplied };
      } finally {
        libheif.heif_image_release(decoded.image);
      }
    } finally {
      libheif.heif_image_handle_release(handle);
    }
  } finally {
    libheif.heif_context_free(ctx);
  }
}

function isCompleteJpeg(bytes: Uint8Array): boolean {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    return false;
  }
  let end = bytes.length - 1;
  while (end > 2 && bytes[end] === 0x00) end--;
  return bytes[end - 1] === 0xff && bytes[end] === 0xd9;
}

function isCompleteWebp(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riffPayload = view.getUint32(4, true);
  return bytes.length >= riffPayload + 8;
}

function isCompleteGif(bytes: Uint8Array): boolean {
  let end = bytes.length - 1;
  while (end > 6 && bytes[end] === 0x00) end--;
  return bytes[end] === 0x3b;
}

/** Null for anything that isn't a still image; throws on truncated/corrupt image data. */
export async function prepareForVision(
  bytes: Uint8Array,
  mimeType: string,
): Promise<VisionImage | null> {
  const type = sniffImageMime(bytes, mimeType);
  if (!type) return null;

  if (type === "image/heic" || type === "image/heif") {
    const decoded = await decodeHeicRgba(bytes);
    const opaque = flattenAlphaToWhite(decoded.data, decoded.premultiplied);
    return encodeJpeg(downscaleRgba(opaque, decoded.width, decoded.height));
  }

  if (type === "image/jpeg") {
    if (!isCompleteJpeg(bytes)) throw new Error("Truncated or invalid JPEG");
    if (bytes.length <= PASSTHROUGH_BYTES) {
      return { base64: toBase64(bytes), mimeType: "image/jpeg" };
    }
    const decoded = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
    return encodeJpeg(downscaleRgba(decoded.data, decoded.width, decoded.height));
  }

  if (type === "image/png") {
    const png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    const opaque = flattenAlphaToWhite(png.data, false);
    const hadTransparency = opaque !== png.data;
    const oversized =
      bytes.length > PASSTHROUGH_BYTES || png.width > MAX_EDGE || png.height > MAX_EDGE;
    if (!hadTransparency && !oversized) {
      return { base64: toBase64(bytes), mimeType: "image/png" };
    }
    return encodeJpeg(downscaleRgba(opaque, png.width, png.height));
  }

  if (type === "image/webp") {
    if (!isCompleteWebp(bytes)) throw new Error("Truncated WebP");
    return { base64: toBase64(bytes), mimeType: "image/webp" };
  }

  if (type === "image/gif") {
    if (!isCompleteGif(bytes)) throw new Error("Truncated GIF");
    return { base64: toBase64(bytes), mimeType: "image/gif" };
  }

  return null;
}
