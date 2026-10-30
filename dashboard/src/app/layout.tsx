import type { Metadata } from "next";
import "./globals.css";
import {
  OG_ORIGIN,
  OG_POSTER_URL,
  OG_TITLE,
  OG_VIDEO_URL,
} from "../../../.flue/lib/ogPreview";

// Static metadata, resolved into the first HTML chunk. Messages fetches the
// link with a plain GET and does not run the client bundle, so these tags
// have to be here rather than injected after hydration. og:title is only
// "Sezar" and there is no og:description: a long title or description is what
// made the preview a compact text card. The same tags apply to /login/confirm
// and to signed-in dashboard pages, and they never include a token or stats.
// The document <title> stays the longer line for the browser tab.
export const metadata: Metadata = {
  metadataBase: new URL(OG_ORIGIN),
  title: "Sezar — text the agent, keep the record",
  openGraph: {
    title: OG_TITLE,
    type: "video.other",
    images: [
      {
        url: OG_POSTER_URL,
        secureUrl: OG_POSTER_URL,
        width: 1200,
        height: 630,
        type: "image/jpeg",
      },
    ],
    videos: [
      {
        url: OG_VIDEO_URL,
        secureUrl: OG_VIDEO_URL,
        type: "video/mp4",
        width: 1200,
        height: 630,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: OG_TITLE,
    images: [OG_POSTER_URL],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
