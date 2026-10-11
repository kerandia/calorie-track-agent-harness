import { googleMapsKey } from "./googleMaps.js";

// Travel times from one place to several (Routes API, Compute Route Matrix,
// Essentials SKU: 10,000 elements free a month, then $5 per 1,000). Traffic-
// aware driving would move to the Pro SKU, so driving times are typical,
// not live. Transit takes an optional departure time.

export type Waypoint = { name?: string; lat?: number; lon?: number; address?: string };
export type TravelMode = "walk" | "transit" | "drive" | "bicycle";
export type TravelTime = {
  name: string;
  reachable: boolean;
  seconds?: number;
  meters?: number;
};

const MODES: Record<TravelMode, string> = {
  walk: "WALK",
  transit: "TRANSIT",
  drive: "DRIVE",
  bicycle: "BICYCLE",
};

export const MAX_DESTINATIONS = 25;

type Fetch = typeof fetch;

const toWaypoint = (w: Waypoint) => {
  if (w.lat !== undefined && w.lon !== undefined) {
    return { waypoint: { location: { latLng: { latitude: w.lat, longitude: w.lon } } } };
  }
  if (w.address?.trim()) return { waypoint: { address: w.address.trim() } };
  throw new Error(`"${w.name ?? "a place"}" needs coordinates or an address`);
};

const labelOf = (w: Waypoint, i: number): string => w.name ?? w.address ?? `place ${i + 1}`;

export async function travelTimes(
  origin: Waypoint,
  destinations: Waypoint[],
  mode: TravelMode = "walk",
  departAt?: string,
  fetchImpl: Fetch = fetch,
): Promise<TravelTime[]> {
  if (destinations.length === 0) return [];
  const dests = destinations.slice(0, MAX_DESTINATIONS);
  const body: Record<string, unknown> = {
    origins: [toWaypoint(origin)],
    destinations: dests.map(toWaypoint),
    travelMode: MODES[mode],
  };
  if (mode === "transit" && departAt) {
    const t = Date.parse(departAt);
    if (Number.isFinite(t) && t > Date.now()) body.departureTime = new Date(t).toISOString();
  }
  const res = await fetchImpl("https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": googleMapsKey(),
      "X-Goog-FieldMask": "destinationIndex,duration,distanceMeters,condition",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Routes failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const elements = (await res.json()) as {
    destinationIndex?: number;
    duration?: string;
    distanceMeters?: number;
    condition?: string;
  }[];

  const out: TravelTime[] = dests.map((d, i) => ({ name: labelOf(d, i), reachable: false }));
  for (const e of elements) {
    const i = e.destinationIndex ?? 0;
    if (!out[i] || e.condition !== "ROUTE_EXISTS") continue;
    const seconds = e.duration ? Number.parseInt(e.duration, 10) : undefined;
    out[i] = {
      ...out[i],
      reachable: true,
      ...(Number.isFinite(seconds) ? { seconds } : {}),
      ...(e.distanceMeters !== undefined ? { meters: e.distanceMeters } : {}),
    };
  }
  return out;
}

export const formatDuration = (seconds: number): string => {
  const m = Math.max(1, Math.round(seconds / 60));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h${m % 60 ? ` ${m % 60} min` : ""}`;
};

export const formatDistance = (meters: number): string =>
  meters < 1000 ? `${Math.round(meters / 10) * 10} m` : `${(meters / 1000).toFixed(1)} km`;
