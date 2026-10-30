import type { Metadata } from "next";
import "./globals.css";
import {
  OG_DESCRIPTION,
  OG_ORIGIN,
  OG_POSTER_URL,
  OG_TITLE,
  OG_VIDEO_URL,
} from "../../../.flue/lib/ogPreview";

// Static metadata, resolved into the first HTML chunk. Messages fetches the
// link with a plain GET and does not run the client bundle, so these tags
// have to be here rather than injected after hydration. The same tags apply
// to /login/confirm (the /login link) and to signed-in dashboard pages: the
// preview stays the generic Sezar card and never includes a token or stats.
export const metadata: Metadata = {
  metadataBase: new URL(OG_ORIGIN),
  title: OG_TITLE,
  description: OG_DESCRIPTION,
  openGraph: {
    title: OG_TITLE,
    description: OG_DESCRIPTION,
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
    description: OG_DESCRIPTION,
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
