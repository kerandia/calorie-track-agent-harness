import { redirect } from "next/navigation";
import { getSessionTenantId } from "@/lib/auth";
import DashTabs from "@/components/DashTabs";

// The signed-in record: health, saved places, and what Sezar published.
// Every page under /dashboard is gated here; each page still reads the tenant
// itself, since a layout can't hand data to its children.

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const tenantId = await getSessionTenantId();
  if (!tenantId) redirect("/");

  return (
    <div className="dash">
      <header className="dash-head">
        <div className="dash-bar">
          <a className="dash-logo" href="/dashboard" aria-label="Sezar dashboard">
            <span className="dash-logo-mark" aria-hidden="true">S</span>
            sezar
          </a>
          <a className="dash-logout" href="/api/logout">Log out</a>
        </div>
        <DashTabs />
      </header>
      <main className="container">{children}</main>
    </div>
  );
}
