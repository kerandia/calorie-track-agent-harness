import { createHash } from "node:crypto";
import { Bucket, uniquePath } from "@upstash/blob";
import sanitizeHtml from "sanitize-html";

// Hosted HTML pages the agent writes for a user (a travel plan, a weekly meal
// plan, a shopping list…), served from Upstash Blob.
//
// Tenancy: one public bucket, every object under a per-user prefix. The prefix
// is a hash of the tenant id, not the id itself, so a shared link doesn't leak
// the user's Telegram id. Isolation is by prefix + our own registry in Redis
// (recordArtifact); the bucket is storage, not the index. Object names carry an
// 8-char random suffix (uniquePath), so URLs are unguessable — unlisted, like
// a Google Docs "anyone with the link" share. Don't put secrets on a page.
//
// Requires UPSTASH_BLOB_TOKEN for a PUBLIC bucket. Private buckets have no
// public URL at all, and their signed URLs die with the signing credential
// (~7 minutes here), so the tool reports the limitation to the model and the
// agent falls back to sending the content as a message.

let _bucket: Bucket | null = null;
const bucket = (): Bucket => {
  if (!_bucket) _bucket = Bucket.fromEnv();
  return _bucket;
};

export const pagesConfigured = (): boolean => !!process.env.UPSTASH_BLOB_TOKEN;

export class PrivateBucketError extends Error {
  constructor() {
    super(
      "the configured Upstash Blob bucket is PRIVATE; pages need a public bucket for a shareable link",
    );
  }
}

const tenantHash = (tenantId: string): string =>
  createHash("sha256").update(tenantId).digest("hex").slice(0, 16);

export const tenantPrefix = (tenantId: string): string => `p/${tenantHash(tenantId)}`;

/** Path for a new page. `slug` is reduced to a safe filename and suffixed. */
export const newPagePath = (tenantId: string, slug: string): string =>
  // uniquePath keeps literal slashes as structure and reduces every ${} value
  // to ONE filename segment (so "p/x" inside a ${} would lose its slash — the
  // prefix's "p/" must be literal). A hostile slug can never escape the prefix.
  uniquePath`p/${tenantHash(tenantId)}/${(slug || "page").replace(/\.html?$/i, "") + ".html"}`;

export type PublishedPage = {
  path: string;
  url: string;
  bytes: number;
  etag: string;
};

export const MAX_PAGE_BYTES = 128 * 1024;

/**
 * Storage answers a read of a compressible object with a WEAK etag
 * (`W/"abc"`) because it serves the body gzipped, but a write returns the
 * STRONG one (`"abc"`) and `ifUnchanged` is compared against the strong form.
 * Handing the weak etag straight back therefore made every update of a real
 * page fail with `conflict` — invisible in tests using tiny documents, which
 * are below the compression threshold and come back strong. The validator
 * part is the same hash either way, so normalize to the strong form on both
 * sides of the round trip.
 */
export const normalizeEtag = (etag: string): string => etag.replace(/^W\//, "");
type PageStorage = Pick<Bucket, "put" | "get" | "del">;

export function assertPagePath(tenantId: string, path: string): void {
  const prefix = tenantPrefix(tenantId) + "/";
  const filename = path.slice(prefix.length);
  if (!path.startsWith(prefix) || !/^[A-Za-z0-9_.-]+$/.test(filename) || filename === "." || filename === "..") {
    throw new Error("page path outside tenant prefix");
  }
}

/** Write (or overwrite, when `path` is given) an HTML page and return its URL. */
export async function putPage(
  tenantId: string,
  html: string,
  opts: { slug?: string; path?: string; expectedEtag?: string },
  storage?: PageStorage,
): Promise<PublishedPage> {
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > MAX_PAGE_BYTES) {
    throw new Error(`page is ${bytes} bytes; max ${MAX_PAGE_BYTES}`);
  }
  const path = opts.path ?? newPagePath(tenantId, opts.slug ?? "page");
  assertPagePath(tenantId, path);
  if (opts.path && !opts.expectedEtag) throw new Error("Read the page before updating it");
  const blob = await (storage ?? bucket()).put(path, html, {
    contentType: "text/html; charset=utf-8",
    // Pages get updated in place ("add day 3 to my plan"); let browsers
    // revalidate on the etag instead of caching a stale version.
    cache: "revalidate",
    ...(opts.path
      ? { ifUnchanged: normalizeEtag(opts.expectedEtag!) }
      : { allowOverwrite: false }),
  });
  if (!blob.url) {
    // A private bucket has no public object URL, and its signed URLs are
    // capped by the signing credential (measured: ~7 minutes, whatever
    // expiresIn asks for) — useless for a link someone opens tomorrow.
    throw new PrivateBucketError();
  }
  return { path: blob.path, url: blob.url, bytes, etag: normalizeEtag(blob.etag) };
}

export async function getPage(tenantId: string, path: string, storage?: PageStorage): Promise<{ html: string; etag: string }> {
  assertPagePath(tenantId, path);
  const blob = await (storage ?? bucket()).get(path);
  const reader = blob.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_PAGE_BYTES) throw new Error("Page exceeds safe editing size");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return { html: Buffer.concat(chunks).toString("utf8"), etag: normalizeEtag(blob.etag) };
}

export async function deletePage(tenantId: string, path: string, storage?: PageStorage): Promise<void> {
  assertPagePath(tenantId, path);
  await (storage ?? bucket()).del(path);
}
