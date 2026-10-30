import { OG_ORIGIN } from "./ogPreview.js";

/**
 * Messages shows the large media preview only when the URL is the entire
 * message. A dashboard or share link that shares a bubble with other text
 * falls back to the compact card (a thin strip of video, title underneath).
 * These helpers pull those URLs out so the iMessage channel can send each one
 * alone. Other URLs stay in the prose.
 */

const URL_RE = /https?:\/\/[^\s<>"']+/g;
const TRAILING = /[.,;:!?)\]]+$/;

const PRODUCTION_HOST = new URL(OG_ORIGIN).host;

function dashboardHosts(): Set<string> {
  const hosts = new Set<string>([PRODUCTION_HOST]);
  const raw = process.env.DASHBOARD_URL;
  if (!raw) return hosts;
  try {
    hosts.add(new URL(raw).host.toLowerCase());
  } catch {
    // A bad DASHBOARD_URL must not make every link look like a preview.
  }
  return hosts;
}

/** A login link, a published page, or a MapToAgent map — the links we preview. */
export function isPreviewLink(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.host.toLowerCase();
  if (host === "maptoagent.xyz" || host.endsWith(".maptoagent.xyz")) {
    return parsed.pathname !== "/" && !parsed.pathname.startsWith("/docs") && !parsed.pathname.startsWith("/v1");
  }
  if (host.endsWith(".blob.upstash.io") && /^\/p\/[a-f0-9]{16}\//.test(parsed.pathname)) return true;
  if (!dashboardHosts().has(host)) return false;
  return /^\/(?:login\/confirm\b|dashboard(?:\/|$)|p\/)/.test(parsed.pathname);
}

/**
 * Split a reply into bubbles. Preview links become their own entries, with
 * nothing before or after the URL. Text that isn't one of those links is
 * returned unchanged when there is nothing to split.
 */
export function splitPreviewLinks(text: string): string[] {
  const parts: string[] = [];
  let cursor = 0;
  let found = false;
  for (const match of text.matchAll(URL_RE)) {
    const raw = match[0];
    const url = raw.replace(TRAILING, "");
    if (!isPreviewLink(url)) continue;
    found = true;
    const before = text.slice(cursor, match.index ?? 0).trim();
    if (before) parts.push(before);
    parts.push(url);
    cursor = (match.index ?? 0) + raw.length;
  }
  if (!found) return [text];
  const after = text.slice(cursor).trim();
  if (after) parts.push(after);
  return parts;
}
