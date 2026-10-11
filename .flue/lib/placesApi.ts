// Google Places API (New) — reviews, rating, price level and hours for a place.
//
// Two calls per lookup, to keep cost down:
//   1. Text Search with only `places.id` in the field mask — the IDs Only SKU,
//      free and unlimited.
//   2. Place Details for that id — the Enterprise + Atmosphere SKU (reviews),
//      1,000 free a month, then ~$25 per 1,000.
//
// Terms that shape how this is used:
//   - Only the place id may be stored; everything else is fetched on demand
//     and must not be cached (lib/placeLists.ts keeps just `place_id`).
//   - Under the EEA terms (since Jul 2025) Places content other than the id and
//     coordinates must not be shown on or beside a map — so ratings and
//     reviews go into chat replies, never into publish_map notes.
//   - Reviews are shown as Google reviews, with their authors.

const BASE = "https://places.googleapis.com/v1";

export const placesConfigured = (): boolean => Boolean(process.env.GOOGLE_MAPS_API_KEY);

const key = (): string => {
  const k = process.env.GOOGLE_MAPS_API_KEY;
  if (!k) throw new Error("GOOGLE_MAPS_API_KEY not set");
  return k;
};

type Fetch = typeof fetch;

export type PlaceQuery = {
  name: string;
  address?: string;
  lat?: number;
  lon?: number;
  languageCode?: string;
};

/** The best-matching place id for a name (+ address / coordinates). Free (IDs Only SKU). */
export async function findPlaceId(q: PlaceQuery, fetchImpl: Fetch = fetch): Promise<string | null> {
  const body: Record<string, unknown> = {
    textQuery: [q.name, q.address].filter(Boolean).join(", "),
    pageSize: 1,
    ...(q.languageCode ? { languageCode: q.languageCode } : {}),
  };
  if (q.lat !== undefined && q.lon !== undefined) {
    body.locationBias = { circle: { center: { latitude: q.lat, longitude: q.lon }, radius: 500 } };
  }
  const res = await fetchImpl(`${BASE}/places:searchText`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key(),
      "X-Goog-FieldMask": "places.id",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Places search failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { places?: { id?: string }[] };
  return data.places?.[0]?.id ?? null;
}

export type PlaceDetails = {
  id: string;
  name?: string;
  address?: string;
  rating?: number;
  ratingCount?: number;
  priceLevel?: string;
  type?: string;
  openNow?: boolean;
  hours?: string[];
  website?: string;
  mapsUrl?: string;
  reviews: { rating?: number; when?: string; author?: string; text?: string }[];
};

const DETAILS_FIELDS = [
  "id",
  "displayName",
  "formattedAddress",
  "rating",
  "userRatingCount",
  "priceLevel",
  "primaryTypeDisplayName",
  "currentOpeningHours.openNow",
  "regularOpeningHours.weekdayDescriptions",
  "websiteUri",
  "googleMapsUri",
  "reviews",
].join(",");

type RawDetails = {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string;
  primaryTypeDisplayName?: { text?: string };
  currentOpeningHours?: { openNow?: boolean };
  regularOpeningHours?: { weekdayDescriptions?: string[] };
  websiteUri?: string;
  googleMapsUri?: string;
  reviews?: {
    rating?: number;
    relativePublishTimeDescription?: string;
    text?: { text?: string };
    originalText?: { text?: string };
    authorAttribution?: { displayName?: string };
  }[];
};

export async function placeDetails(
  placeId: string,
  opts: { languageCode?: string } = {},
  fetchImpl: Fetch = fetch,
): Promise<PlaceDetails> {
  if (!/^[A-Za-z0-9_-]{10,300}$/.test(placeId)) throw new Error("Invalid place id");
  const qs = opts.languageCode ? `?languageCode=${encodeURIComponent(opts.languageCode)}` : "";
  const res = await fetchImpl(`${BASE}/places/${placeId}${qs}`, {
    headers: { "X-Goog-Api-Key": key(), "X-Goog-FieldMask": DETAILS_FIELDS },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Place details failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const d = (await res.json()) as RawDetails;
  return {
    id: d.id,
    name: d.displayName?.text,
    address: d.formattedAddress,
    rating: d.rating,
    ratingCount: d.userRatingCount,
    priceLevel: d.priceLevel?.replace(/^PRICE_LEVEL_/, "").toLowerCase(),
    type: d.primaryTypeDisplayName?.text,
    openNow: d.currentOpeningHours?.openNow,
    hours: d.regularOpeningHours?.weekdayDescriptions,
    website: d.websiteUri,
    mapsUrl: d.googleMapsUri,
    reviews: (d.reviews ?? []).map((r) => ({
      rating: r.rating,
      when: r.relativePublishTimeDescription,
      author: r.authorAttribution?.displayName,
      text: (r.text?.text ?? r.originalText?.text)?.slice(0, 600),
    })),
  };
}

/** The CID in a Google Maps URL (…?cid=123…), used to confirm a name match. */
export const cidFromMapsUrl = (url: string | undefined): string | undefined =>
  url ? /[?&]cid=(\d+)/.exec(url)?.[1] : undefined;
