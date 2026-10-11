import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sezar — text the agent, keep the record",
  description:
    "A personal agent in your chat — Telegram, and iMessage by invite. Log meals from a photo, plan around the places you've saved, and keep the record here.",
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
