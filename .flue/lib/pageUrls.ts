// Where a published page can actually be viewed.
//
// Upstash Blob serves every public object with `Content-Disposition:
// attachment`, so opening a page's storage URL downloads the HTML instead of
// showing it. The dashboard re-serves the same object inline at
// /p/<tenant-hash>/<file>.html (dashboard/src/app/p/[...path]/route.ts) under
// a script-free Content-Security-Policy. Old storage links in the artifact
// registry map to the same place.

const STORED = /^https:\/\/[a-z0-9-]+\.blob\.upstash\.io\/(p\/[a-f0-9]{16}\/[A-Za-z0-9._-]+\.html)$/;

export function viewablePageUrl(storedUrl: string): string {
  const base = process.env.DASHBOARD_URL?.replace(/\/+$/, "");
  const m = STORED.exec(storedUrl);
  return base && m ? `${base}/${m[1]}` : storedUrl;
}
