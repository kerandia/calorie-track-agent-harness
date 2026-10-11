import { redirect } from "next/navigation";
import { getSessionTenantId } from "@/lib/auth";
import { getPlaceListSummaries } from "@/lib/redis";
import { shortDate } from "@/lib/places";

export const dynamic = "force-dynamic";

export default async function Saved() {
  const tenantId = await getSessionTenantId();
  if (!tenantId) redirect("/");
  const lists = await getPlaceListSummaries(tenantId);

  return (
    <div className="narrow">
      <h1 className="page-title">Saved places</h1>
      {lists.length === 0 ? (
        <p className="empty">
          Nothing saved yet. Send Sezar a Google Maps list link (in Maps: the list → Share → Copy
          link) and it shows up here, notes included.
        </p>
      ) : (
        <ul className="cards" aria-label="Your place lists">
          {lists.map((l) => (
            <li key={l.id}>
              <a className="card" href={`/dashboard/saved/${l.id}`}>
                <span className="card-title">{l.name}</span>
                <span className="card-meta">
                  {l.count} {l.count === 1 ? "place" : "places"} ·{" "}
                  {l.source ? `from Google Maps, ${shortDate(l.source.imported_at)}` : `updated ${shortDate(l.updated_at)}`}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
