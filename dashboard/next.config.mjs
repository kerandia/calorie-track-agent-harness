import path from "node:path";
import { fileURLToPath } from "node:url";

const dashboardDir = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Messages does not run the script Next uses to hoist streamed metadata
  // into <head>, and TN3156 says the preview must not depend on User-Agent.
  // Treat every client as HTML-limited so og:* is in the first <head>.
  htmlLimitedBots: /.*/,
  // The preview helper lives in .flue so the agent and the dashboard share it.
  // Vercel's project root is `dashboard/`; tracing has to start at the repo
  // root or the route that imports the helper won't see it at runtime.
  outputFileTracingRoot: path.join(dashboardDir, ".."),
  // Public files under /og (see .flue/lib/ogPreview.ts). These are fetched by
  // Messages with no session cookie, so they must stay outside any auth
  // middleware. `send` fills Content-Type from the extension and honours
  // Range; Cache-Control is set here because `send` only writes it when the
  // response doesn't already have one.
  async headers() {
    const cache = "public, max-age=86400, stale-while-revalidate=604800";
    const shared = [
      { key: "Cache-Control", value: cache },
      { key: "Accept-Ranges", value: "bytes" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Content-Disposition", value: "inline" },
    ];
    return [
      {
        source: "/og/A2_grok_inout_key_og.mp4",
        headers: [{ key: "Content-Type", value: "video/mp4" }, ...shared],
      },
      {
        source: "/og/A2_grok_inout_key_og_poster.jpg",
        headers: [{ key: "Content-Type", value: "image/jpeg" }, ...shared],
      },
    ];
  },
};

export default nextConfig;
