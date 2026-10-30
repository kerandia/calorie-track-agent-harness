/**
 * iMessage link preview for Sezar pages.
 *
 * Messages builds the bubble by fetching the page itself (Apple TN3156). It
 * does not run JavaScript, and it autoplays a directly downloadable MP4 on a
 * loop, muted. HLS needs a tap. The icon, image and video together must stay
 * under 10 MB — this clip is ~328 KB and the poster ~22 KB.
 *
 * The URLs are absolute https on the production dashboard. A relative URL, or
 * the host of whoever happens to be rendering the HTML, is not something the
 * sender's phone can fetch.
 *
 * The copy is generic on purpose. Login links carry a one-time token, and
 * dashboard pages carry someone's meals. Neither may show up in the preview.
 */

export const OG_ORIGIN = "https://calorie-track-agent-harness.vercel.app";

export const OG_POSTER_PATH = "/og/A2_grok_inout_key_og_poster.jpg";
export const OG_VIDEO_PATH = "/og/A2_grok_inout_key_og.mp4";

export const OG_POSTER_URL = `${OG_ORIGIN}${OG_POSTER_PATH}`;
export const OG_VIDEO_URL = `${OG_ORIGIN}${OG_VIDEO_PATH}`;

/**
 * A long title or description makes Messages use the compact card, where the
 * words take the bubble and the 1200×630 loop is a thin strip. "Sezar" alone
 * leaves the video as the main element. No description: a paragraph there
 * does the same thing, and it must not carry a token or anyone's stats.
 */
export const OG_TITLE = "Sezar";

const meta = (attr: "property" | "name", key: string, content: string): string =>
  `<meta ${attr}="${key}" content="${content}">`;

/** Tags for the initial HTML `<head>`. No token, no stats, no page title. */
export function ogPreviewMetaTags(): string {
  return [
    meta("property", "og:type", "video.other"),
    meta("property", "og:title", OG_TITLE),
    meta("property", "og:image", OG_POSTER_URL),
    meta("property", "og:image:secure_url", OG_POSTER_URL),
    meta("property", "og:image:type", "image/jpeg"),
    meta("property", "og:image:width", "1200"),
    meta("property", "og:image:height", "630"),
    meta("property", "og:video", OG_VIDEO_URL),
    meta("property", "og:video:secure_url", OG_VIDEO_URL),
    meta("property", "og:video:type", "video/mp4"),
    meta("property", "og:video:width", "1200"),
    meta("property", "og:video:height", "630"),
    meta("name", "twitter:card", "summary_large_image"),
    meta("name", "twitter:title", OG_TITLE),
    meta("name", "twitter:image", OG_POSTER_URL),
  ].join("\n");
}

/** Our preview tags, including ones baked in by an older shell (long title). */
const PREVIEW_META =
  /<meta\s+(?:property|name)=["'](?:og:(?:type|title|description|image|image:[a-z_]+|video|video:[a-z_]+)|twitter:(?:card|title|description|image))["'][^>]*>\n?/gi;

/**
 * Put the current preview tags in a share page. Replaces a previous set, so a
 * page stored with the long title picks up "Sezar" the next time it is served.
 */
export function injectOgPreview(html: string): string {
  const stripped = html.replace(PREVIEW_META, "");
  const close = stripped.toLowerCase().indexOf("</head>");
  if (close === -1) return html;
  return `${stripped.slice(0, close)}${ogPreviewMetaTags()}\n${stripped.slice(close)}`;
}
