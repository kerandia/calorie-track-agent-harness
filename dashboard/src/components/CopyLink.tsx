"use client";

import { useState } from "react";

/** Copies an absolute link (relative /p/… links resolve against this site). */
export default function CopyLink({ href }: { href: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="link-btn"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(new URL(href, window.location.origin).href);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard blocked: the Open link still works */
        }
      }}
    >
      {copied ? "Copied" : "Copy link"}
    </button>
  );
}
