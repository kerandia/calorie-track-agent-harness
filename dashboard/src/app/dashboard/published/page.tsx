import { redirect } from "next/navigation";
import { getSessionTenantId } from "@/lib/auth";
import { getArtifacts } from "@/lib/redis";
import { shortDate, viewableUrl } from "@/lib/places";
import CopyLink from "@/components/CopyLink";

export const dynamic = "force-dynamic";

export default async function Published() {
  const tenantId = await getSessionTenantId();
  if (!tenantId) redirect("/");
  const items = await getArtifacts(tenantId);

  return (
    <div className="narrow">
      <h1 className="page-title">Published</h1>
      <p className="page-meta">
        Pages and maps Sezar made for you. Anyone with a link can open it; to change or take one
        down, ask Sezar.
      </p>
      {items.length === 0 ? (
        <p className="empty">
          Nothing yet. Ask Sezar for a trip plan, a shopping list or a map of places and it lands
          here.
        </p>
      ) : (
        <ul className="pubs" aria-label="Published pages and maps">
          {items.map((a) => {
            const href = viewableUrl(a.url);
            return (
              <li key={a.id} className="pub">
                <span className={`kind kind-${a.kind}`}>{a.kind === "map" ? "Map" : "Page"}</span>
                <div className="pub-main">
                  <a className="pub-title" href={href} target="_blank" rel="noreferrer">
                    {a.title}
                  </a>
                  <span className="pub-meta">updated {shortDate(a.updated_at)}</span>
                </div>
                <div className="pub-actions">
                  <a href={href} target="_blank" rel="noreferrer">
                    Open <span aria-hidden="true">↗</span>
                  </a>
                  <CopyLink href={href} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
