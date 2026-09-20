import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sezar — track calories by just texting",
  description:
    "A health agent on Telegram: text or photograph your meals, Sezar logs calories and macros, remembers what works for you, and turns it into a calendar.",
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
