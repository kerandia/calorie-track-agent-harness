import type { SavedPlace } from "./types";

/** Opens the place in Google Maps (the app, when installed), where the user can tap Save. */
export function mapsLinkFor(place: Pick<SavedPlace, "name" | "address" | "cid" | "place_id">): string {
  if (place.cid) return `https://maps.google.com/?cid=${place.cid}`;
  const query = encodeURIComponent([place.name, place.address].filter(Boolean).join(", "));
  return place.place_id
    ? `https://www.google.com/maps/search/?api=1&query=${query}&query_place_id=${encodeURIComponent(place.place_id)}`
    : `https://www.google.com/maps/search/?api=1&query=${query}`;
}

/**
 * Pages are stored in Upstash Blob, which forces downloads; this site serves
 * them inline at /p/… (app/p/[...path]/route.ts). Old storage links map there.
 */
export function viewableUrl(url: string): string {
  const m = /^https:\/\/[a-z0-9-]+\.blob\.upstash\.io(\/p\/[a-f0-9]{16}\/[A-Za-z0-9._-]+\.html)$/.exec(url);
  return m ? m[1]! : url;
}

/** "11 Oct", or "11 Oct 2025" outside the current year. */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameYear = d.getUTCFullYear() === new Date().getUTCFullYear();
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
}
