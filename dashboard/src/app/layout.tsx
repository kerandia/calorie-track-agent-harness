import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sezar — text the agent, keep the record",
  description:
    "Sezar lives in Telegram. Log meals, make plans, and reopen pages from chat. The dashboard is your record, not another conversation.",
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
