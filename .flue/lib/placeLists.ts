import { Redis } from "@upstash/redis";

// Place lists: Sezar's own lists of places, per tenant, plus import from
// Google Maps shared-list links.
//
// Google has no API that reads or writes a user's Maps lists. A list shared by
// link, though, is public: the Maps web app loads it from an undocumented JSON
// endpoint (/maps/preview/entitylist/getlist) that answers without cookies or
// the EU consent interstitial. We read that once per import. It is
// undocumented, so the parser is defensive and fails with a clear message
// when the shape changes rather than importing garbage.
//
// Each item in that response also carries the list owner's name, avatar and
// Google account id. We never read those fields: only the place, and the note
// written on it, are kept.
//
// Writing back to Google's lists is impossible without driving a logged-in
// browser, so Sezar keeps its own lists here and hands out "open in Google
// Maps" links; the user taps Save in the Maps app.

let _redis: Redis | null = null;
const getRedis = (): Redis => {
  if (!_redis) _redis = Redis.fromEnv();
  return _redis;
};

export type SavedPlace = {
  /** Stable within its list: "c<cid>" for Google places, else random. */
  id: string;
  name: string;
  address?: string;
  lat?: number;
  lon?: number;
  /** The list owner's own note on this place. */
  note?: string;
  /** Google Maps CID (decimal), from the shared list. */
  cid?: string;
  /** Places API id — the only Places API field Google lets us keep. */
  place_id?: string;
  added_at: string;
};

export type PlaceList = {
  id: string;
  name: string;
  description?: string;
  source?: { kind: "google_shared_list"; list_id: string; imported_at: string };
  places: SavedPlace[];
  created_at: string;
  updated_at: string;
};

export type PlaceListSummary = Pick<PlaceList, "id" | "name" | "source" | "updated_at"> & {
  count: number;
};

const MAX_PLACES = 1000;
const MAX_NOTE = 500;

// ── Shared Google Maps lists ──────────────────────────────────────────────

const SHORT_HOSTS = new Set(["maps.app.goo.gl", "goo.gl"]);
const isGoogleHost = (host: string): boolean =>
  /^(?:www\.|maps\.)?google\.(?:[a-z]{2,3}|co\.[a-z]{2}|com\.[a-z]{2})$/.test(host);

const LIST_ID = /^[A-Za-z0-9_-]{10,80}$/;

/** The list id inside a full Google Maps list URL, if there is one. */
export function listIdFromMapsUrl(url: URL): string | null {
  const path = /\/maps\/placelists\/list\/([A-Za-z0-9_-]+)/.exec(url.pathname)?.[1];
  if (path && LIST_ID.test(path)) return path;
  // Older share links: /maps/@/data=!3m1!4b1!4m3!11m2!2s<id>!3e3
  const data = /!11m\d+!2s([A-Za-z0-9_-]+)/.exec(decodeURIComponent(url.pathname + url.search))?.[1];
  return data && LIST_ID.test(data) ? data : null;
}

export class SharedListError extends Error {}

type Fetch = typeof fetch;

/**
 * Resolve a pasted link (short or full) to a Google list id. Only Google
 * hosts are fetched, so a pasted URL can't make the server request anything else.
 */
export async function resolveSharedListId(raw: string, fetchImpl: Fetch = fetch): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new SharedListError("That isn't a link. Share the list in Google Maps → Share → Copy link.");
  }
  for (let hop = 0; hop < 4; hop++) {
    if (url.protocol !== "https:" && url.protocol !== "http:") break;
    if (isGoogleHost(url.hostname)) {
      const id = listIdFromMapsUrl(url);
      if (id) return id;
      throw new SharedListError(
        "That Google Maps link isn't a list. In Google Maps open the list → Share → Copy link.",
      );
    }
    if (!SHORT_HOSTS.has(url.hostname)) break;
    const res = await fetchImpl(url.href, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
    const next = res.headers.get("location");
    if (!next) throw new SharedListError("That short link didn't lead anywhere — is the list still shared?");
    url = new URL(next, url);
  }
  throw new SharedListError("Only Google Maps list links work here (maps.app.goo.gl/… or google.com/maps/placelists/…).");
}

/** Safe nested index into Google's positional JSON. */
const at = (x: unknown, ...path: number[]): unknown => {
  let cur = x;
  for (const i of path) {
    if (!Array.isArray(cur)) return undefined;
    cur = cur[i];
  }
  return cur;
};
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/**
 * The CID is an unsigned 64-bit id, but getlist serializes it as a signed
 * int64, so about half arrive negative. Maps URLs (?cid=) want it unsigned.
 */
export const unsignedCid = (raw: string | undefined): string | undefined => {
  if (!raw || !/^-?\d{1,20}$/.test(raw)) return undefined;
  const n = BigInt(raw);
  return (n < 0n ? n + (1n << 64n) : n).toString();
};

export type SharedListData = {
  name: string;
  description?: string;
  /** What Google says the list holds; more than places.length means truncation. */
  declaredCount?: number;
  places: Omit<SavedPlace, "id" | "added_at">[];
};

/** Parse a getlist response body (with or without the )]}' prefix). */
export function parseSharedList(body: string): SharedListData {
  const json = body.startsWith(")]}'") ? body.slice(body.indexOf("\n") + 1) : body;
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch {
    throw new SharedListError("Google returned something that isn't a list. The link may be private or expired.");
  }
  const list = at(root, 0);
  const items = at(list, 8);
  const name = str(at(list, 4));
  if (!Array.isArray(list) || !Array.isArray(items) || name === undefined) {
    throw new SharedListError("Couldn't read that list — Google may have changed its format. Try again later.");
  }

  const places: SharedListData["places"] = [];
  for (const item of items.slice(0, MAX_PLACES)) {
    // item[1]: place — [_, _, "Name, address", _, address, [_, _, lat, lon], [fid, cid], kgId]
    // item[2]: name; item[3]: the owner's note. item[12+] is the owner — never read.
    const title = str(at(item, 2)) ?? str(at(item, 1, 2))?.split(",")[0];
    if (!title) continue;
    const full = str(at(item, 1, 2));
    const address =
      full && full.startsWith(`${title}, `) ? full.slice(title.length + 2) : str(at(item, 1, 4));
    const cid = unsignedCid(str(at(item, 1, 6, 1)));
    const note = str(at(item, 3));
    places.push({
      name: title,
      ...(address ? { address } : {}),
      ...(num(at(item, 1, 5, 2)) !== undefined ? { lat: num(at(item, 1, 5, 2)) } : {}),
      ...(num(at(item, 1, 5, 3)) !== undefined ? { lon: num(at(item, 1, 5, 3)) } : {}),
      ...(note ? { note: note.slice(0, MAX_NOTE) } : {}),
      ...(cid ? { cid } : {}),
    });
  }
  return {
    name,
    ...(str(at(list, 5)) ? { description: str(at(list, 5)) } : {}),
    ...(num(at(list, 12)) !== undefined ? { declaredCount: num(at(list, 12)) } : {}),
    places,
  };
}

/** Fetch and parse a shared list by its Google list id. */
export async function fetchSharedList(listId: string, fetchImpl: Fetch = fetch): Promise<SharedListData> {
  if (!LIST_ID.test(listId)) throw new SharedListError("Invalid list id");
  const url =
    "https://www.google.com/maps/preview/entitylist/getlist?authuser=0&hl=en&gl=us" +
    `&pb=!1m1!1s${listId}!2e2!3e2!4i${MAX_PLACES}!16b1`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    throw new SharedListError(
      res.status === 404 ? "Google says that list doesn't exist (or isn't shared anymore)." : `Google returned ${res.status} for that list.`,
    );
  }
  return parseSharedList(await res.text());
}

// ── Links ─────────────────────────────────────────────────────────────────

/** Opens the place in Google Maps (the app, when installed), where the user can tap Save. */
export function mapsLinkFor(place: Pick<SavedPlace, "name" | "address" | "cid" | "place_id">): string {
  if (place.cid) return `https://maps.google.com/?cid=${place.cid}`;
  const query = encodeURIComponent([place.name, place.address].filter(Boolean).join(", "));
  return place.place_id
    ? `https://www.google.com/maps/search/?api=1&query=${query}&query_place_id=${encodeURIComponent(place.place_id)}`
    : `https://www.google.com/maps/search/?api=1&query=${query}`;
}

// ── Storage ───────────────────────────────────────────────────────────────
//
// One JSON value per list (t:{tenant}:placelist:{id}) plus a small index hash
// (t:{tenant}:placelists) so the per-turn context can name the lists without
// loading every place.

export type PlaceListStore = Pick<Redis, "get" | "set" | "del" | "hset" | "hgetall" | "hdel">;

const listKey = (tenantId: string, id: string): string => `t:${tenantId}:placelist:${id}`;
const indexKey = (tenantId: string): string => `t:${tenantId}:placelists`;

const assertListId = (id: string): void => {
  if (!/^[a-f0-9]{12}$/.test(id)) throw new Error("Invalid list id");
};

/** Upstash JSON-decodes stored values; a test double may hand back the raw string. */
const decode = <T>(v: unknown): T | null =>
  v === null || v === undefined ? null : typeof v === "string" ? (JSON.parse(v) as T) : (v as T);

const summarize = (list: PlaceList): PlaceListSummary => ({
  id: list.id,
  name: list.name,
  count: list.places.length,
  updated_at: list.updated_at,
  ...(list.source ? { source: list.source } : {}),
});

export const newListId = (): string => crypto.randomUUID().replace(/-/g, "").slice(0, 12);
export const newPlaceId = (): string => `p${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;

export async function listPlaceLists(tenantId: string, db: PlaceListStore = getRedis()): Promise<PlaceListSummary[]> {
  const raw = (await db.hgetall<Record<string, unknown>>(indexKey(tenantId))) ?? {};
  return Object.values(raw)
    .map((v) => decode<PlaceListSummary>(v))
    .filter((s): s is PlaceListSummary => s !== null)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export async function getPlaceList(
  tenantId: string,
  id: string,
  db: PlaceListStore = getRedis(),
): Promise<PlaceList | null> {
  assertListId(id);
  return decode<PlaceList>(await db.get(listKey(tenantId, id)));
}

export async function savePlaceList(
  tenantId: string,
  list: PlaceList,
  db: PlaceListStore = getRedis(),
): Promise<PlaceList> {
  assertListId(list.id);
  const saved: PlaceList = {
    ...list,
    places: list.places.slice(0, MAX_PLACES),
    updated_at: new Date().toISOString(),
  };
  await db.set(listKey(tenantId, list.id), JSON.stringify(saved));
  await db.hset(indexKey(tenantId), { [list.id]: JSON.stringify(summarize(saved)) });
  return saved;
}

export async function deletePlaceList(
  tenantId: string,
  id: string,
  db: PlaceListStore = getRedis(),
): Promise<boolean> {
  assertListId(id);
  const removed = await db.del(listKey(tenantId, id));
  await db.hdel(indexKey(tenantId), id);
  return removed > 0;
}

/**
 * Import (or refresh) a shared Google Maps list as a Sezar list. Re-importing
 * the same Google list updates the existing Sezar list instead of copying it,
 * keeping place ids that were already resolved.
 */
export async function importSharedList(
  tenantId: string,
  link: string,
  deps: { fetchImpl?: Fetch; db?: PlaceListStore } = {},
): Promise<{ list: PlaceList; refreshed: boolean; truncated: boolean }> {
  const db = deps.db ?? getRedis();
  const googleId = await resolveSharedListId(link, deps.fetchImpl);
  const data = await fetchSharedList(googleId, deps.fetchImpl);

  const existingSummary = (await listPlaceLists(tenantId, db)).find(
    (s) => s.source?.list_id === googleId,
  );
  const existing = existingSummary ? await getPlaceList(tenantId, existingSummary.id, db) : null;
  const known = new Map((existing?.places ?? []).map((p) => [p.id, p]));

  const now = new Date().toISOString();
  const places: SavedPlace[] = data.places.map((p) => {
    const id = p.cid ? `c${p.cid}` : newPlaceId();
    const prev = known.get(id);
    return {
      ...p,
      id,
      added_at: prev?.added_at ?? now,
      ...(prev?.place_id ? { place_id: prev.place_id } : {}),
    };
  });

  const list = await savePlaceList(
    tenantId,
    {
      id: existing?.id ?? newListId(),
      name: existing?.name ?? data.name,
      ...(data.description ? { description: data.description } : {}),
      source: { kind: "google_shared_list", list_id: googleId, imported_at: now },
      places,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    },
    db,
  );
  return {
    list,
    refreshed: Boolean(existing),
    truncated: (data.declaredCount ?? 0) > data.places.length,
  };
}
