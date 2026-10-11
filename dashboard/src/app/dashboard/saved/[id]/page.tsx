import { notFound, redirect } from "next/navigation";
import { getSessionTenantId } from "@/lib/auth";
import { getPlaceList } from "@/lib/redis";
import { mapsLinkFor, shortDate } from "@/lib/places";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [k: string]: string | string[] | undefined }>;
};

export default async function SavedList({ params, searchParams }: Props) {
  const tenantId = await getSessionTenantId();
  if (!tenantId) redirect("/");
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const list = await getPlaceList(tenantId, id);
  if (!list) notFound();

  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const needle = q.toLowerCase();
  const places = needle
    ? list.places.filter((p) => [p.name, p.address, p.note].some((f) => f?.toLowerCase().includes(needle)))
    : list.places;
  const noted = list.places.filter((p) => p.note).length;

  return (
    <div className="narrow">
      <a className="back" href="/dashboard/saved">← All lists</a>
      <h1 className="page-title">{list.name}</h1>
      <p className="page-meta">
        {list.places.length} places · {noted} with your notes
        {list.source ? ` · from Google Maps, refreshed ${shortDate(list.source.imported_at)}` : ""}
      </p>

      <form className="search" role="search" action={`/dashboard/saved/${list.id}`}>
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search names, streets, notes…"
          aria-label="Search this list"
        />
      </form>

      {q ? (
        <p className="page-meta">
          {places.length} {places.length === 1 ? "match" : "matches"} for “{q}” ·{" "}
          <a href={`/dashboard/saved/${list.id}`}>clear</a>
        </p>
      ) : null}

      <ul className="places" aria-label="Places">
        {places.map((p) => (
          <li key={p.id} className="place">
            <div className="place-main">
              <span className="place-name">{p.name}</span>
              {p.note ? <span className="place-note">{p.note}</span> : null}
              {p.address ? <span className="place-addr">{p.address}</span> : null}
            </div>
            <a className="place-open" href={mapsLinkFor(p)} target="_blank" rel="noreferrer">
              Maps <span aria-hidden="true">↗</span>
            </a>
          </li>
        ))}
      </ul>
      {places.length === 0 ? <p className="empty">Nothing matches that.</p> : null}
    </div>
  );
}
