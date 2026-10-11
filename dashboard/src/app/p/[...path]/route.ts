// Pages Sezar publishes, shown inline.
//
// The agent stores each page in a public Upstash Blob bucket, but Blob serves
// every object with `Content-Disposition: attachment`, so its own URL
// downloads the file. This route streams the same object back as a page.
//
// It is model-written HTML on the dashboard's origin, so the response is
// locked down: the agent already sanitizes pages to an allowlist (no scripts,
// forms, iframes or remote images), and this CSP allows only the inline
// <style> of Sezar's page shell — even a sanitizer miss can't run a script,
// submit a form, load anything or be framed. The session cookie is httpOnly.

const BLOB_BASE = (process.env.PAGES_BLOB_BASE_URL ?? "https://b2a00fa636ae.blob.upstash.io").replace(/\/+$/, "");

// p/<sha256(tenant)[:16]>/<slug>-<random>.html — nothing else is a page.
const PAGE_PATH = /^[a-f0-9]{16}\/[A-Za-z0-9._-]{1,200}\.html$/;

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  // Unlisted, like a Docs "anyone with the link" share.
  "X-Robots-Tag": "noindex, nofollow",
};

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const rel = (await params).path.join("/");
  if (!PAGE_PATH.test(rel) || rel.includes("..")) return notFound();

  const upstream = await fetch(`${BLOB_BASE}/p/${rel}`, { cache: "no-store" }).catch(() => null);
  if (!upstream?.ok || !upstream.body) return notFound();

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": "inline",
      // Pages are updated in place ("add day 3"); always show the latest.
      "Cache-Control": "public, max-age=0, must-revalidate",
      ...SECURITY_HEADERS,
    },
  });
}

const notFound = () =>
  new Response("This page doesn't exist or was taken offline.", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS },
  });
