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

export const OG_TITLE = "Sezar — text the agent, keep the record";
export const OG_DESCRIPTION =
  "A personal agent in your chat — Telegram, and iMessage by invite. Log meals from a photo, plan around the places you've saved, and keep the record here.";

const meta = (attr: "property" | "name", key: string, content: string): string =>
  `<meta ${attr}="${key}" content="${content}">`;

/** Tags for the initial HTML `<head>`. No token, no stats, no page title. */
export function ogPreviewMetaTags(): string {
  return [
    meta("property", "og:type", "video.other"),
    meta("property", "og:title", OG_TITLE),
    meta("property", "og:description", OG_DESCRIPTION),
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
    meta("name", "twitter:description", OG_DESCRIPTION),
    meta("name", "twitter:image", OG_POSTER_URL),
  ].join("\n");
}

/**
 * Insert the preview tags into a stored share page that was published before
 * the shell included them. Pages that already have `og:video` are left alone.
 */
export function injectOgPreview(html: string): string {
  if (html.includes('property="og:video"') || html.includes("property='og:video'")) return html;
  const close = html.indexOf("</head>");
  if (close === -1) return html;
  return `${html.slice(0, close)}${ogPreviewMetaTags()}\n${html.slice(close)}`;
}
