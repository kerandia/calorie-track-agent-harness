"use client";

import { usePathname } from "next/navigation";

const TABS = [
  { href: "/dashboard", label: "Health" },
  { href: "/dashboard/saved", label: "Saved" },
  { href: "/dashboard/published", label: "Published" },
  { href: "/dashboard/you", label: "You" },
] as const;

export default function DashTabs() {
  const path = usePathname();
  const active = (href: string) => (href === "/dashboard" ? path === href : path.startsWith(href));
  return (
    <nav className="dash-tabs" aria-label="Sections">
      {TABS.map((t) => (
        <a key={t.href} href={t.href} aria-current={active(t.href) ? "page" : undefined}>
          {t.label}
        </a>
      ))}
    </nav>
  );
}
