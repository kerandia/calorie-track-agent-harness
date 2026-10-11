import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchSharedList,
  getPlaceList,
  importSharedList,
  movePlaceLists,
  listIdFromMapsUrl,
  listPlaceLists,
  mapsLinkFor,
  parseSharedList,
  resolveSharedListId,
  savePlaceList,
  SharedListError,
  unsignedCid,
  type PlaceListStore,
} from "../.flue/lib/placeLists.js";
import { cidFromMapsUrl, findPlaceId, placeDetails } from "../.flue/lib/placesApi.js";

const LIST_ID = "AbCdEfGhIjKlMnOpQrStUvWxYz01";
const OWNER = ["Owner Person", "https://lh3.example/avatar", "123456789012345678901"];

// Same positional shape as Google's getlist response (synthetic data).
function getlistBody(
  places: { name: string; note?: string; cid: string; lat: number; lon: number }[],
  continuation = "",
) {
  const items = places.map((p) => [
    null,
    [null, null, `${p.name}, 1 Example St, Lisbon, Portugal`, null, "Portugal, Lisbon, 1 Example St", [null, null, p.lat, p.lon], ["111", p.cid], "/g/x"],
    p.name,
    p.note ?? "",
    null, null, null, [], [[1], ["111", p.cid]], [1, 0], [1, 0], null,
    OWNER, null, null, [OWNER],
  ]);
  const list = [[LIST_ID, 1, [[1], [9]], 1, 1], 4, [2, 1, `https://www.google.com/maps/placelists/list/${LIST_ID}`], OWNER, "Lisbon eats", "", null, null, items, [], [1, 0], [1, 0], places.length];
  return `)]}'\n${JSON.stringify([list, continuation, null, null, null, null, "y"])}`;
}

function memoryDb(): PlaceListStore {
  const strings = new Map<string, string>();
  const hashes = new Map<string, Record<string, string>>();
  return {
    get: (async (key: string) => strings.get(key) ?? null) as PlaceListStore["get"],
    set: (async (key: string, value: string) => {
      strings.set(key, value);
      return "OK";
    }) as PlaceListStore["set"],
    del: (async (...keys: string[]) => keys.filter((k) => strings.delete(k)).length) as PlaceListStore["del"],
    hset: (async (key: string, fields: Record<string, string>) => {
      hashes.set(key, { ...(hashes.get(key) ?? {}), ...fields });
      return Object.keys(fields).length;
    }) as PlaceListStore["hset"],
    hgetall: (async (key: string) => hashes.get(key) ?? null) as PlaceListStore["hgetall"],
    hdel: (async (key: string, ...fields: string[]) => {
      const h = hashes.get(key) ?? {};
      fields.forEach((f) => delete h[f]);
      return fields.length;
    }) as PlaceListStore["hdel"],
  };
}

function fakeGoogle(body: string): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://maps.app.goo.gl/")) {
      return new Response(null, {
        status: 302,
        headers: { location: `https://www.google.com/maps/placelists/list/${LIST_ID}?g_ep=x` },
      });
    }
    if (url.startsWith("https://www.google.com/maps/preview/entitylist/getlist")) {
      assert.ok(url.includes(`!1s${LIST_ID}!`));
      return new Response(body);
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

test("a shared list parses to places and notes, never the owner's identity", () => {
  const data = parseSharedList(
    getlistBody([
      { name: "Taberna X", note: "order the octopus", cid: "4503869456705953711", lat: 38.71, lon: -9.14 },
      { name: "Café Y", cid: "17", lat: 38.72, lon: -9.15 },
    ]),
  );
  assert.equal(data.name, "Lisbon eats");
  assert.equal(data.declaredCount, 2);
  assert.equal(data.hasMore, false);
  assert.equal(data.unreadable, 0);
  assert.deepEqual(data.places[0], {
    name: "Taberna X",
    address: "1 Example St, Lisbon, Portugal",
    lat: 38.71,
    lon: -9.14,
    note: "order the octopus",
    cid: "4503869456705953711",
  });
  assert.equal(data.places[1]!.note, undefined);
  const serialized = JSON.stringify(data);
  for (const field of OWNER) assert.ok(!serialized.includes(field));
});

test("negative (signed int64) CIDs become the unsigned ids Maps URLs use", () => {
  assert.equal(unsignedCid("-6132233778034352245"), "12314510295675199371");
  assert.equal(unsignedCid("4503869456705953711"), "4503869456705953711");
  assert.equal(unsignedCid("0x12"), undefined);
});

test("dropped pins are kept, and only Google's continuation token means truncation", () => {
  const body = JSON.parse(getlistBody([{ name: "Café Y", cid: "17", lat: 1, lon: 2 }]).slice(5));
  const items = body[0][8];
  // A dropped pin: coordinates and a note, no name anywhere.
  items.push([null, [null, null, "", null, "", [null, null, 48.85, 2.35]], "", "picnic spot", null]);
  // Junk: no name, no coordinates.
  items.push([null, [null, null, "", null, ""], "", "", null]);
  body[0][12] = 3;
  const data = parseSharedList(JSON.stringify(body));
  assert.equal(data.places.length, 2);
  assert.deepEqual(data.places[1], { name: "Dropped pin", lat: 48.85, lon: 2.35, note: "picnic spot" });
  assert.equal(data.unreadable, 1);
  assert.equal(data.hasMore, false); // fewer places than declared is not truncation

  assert.equal(parseSharedList(getlistBody([{ name: "A", cid: "1", lat: 0, lon: 0 }], "CgsI_token")).hasMore, true);
});

test("a changed or private response fails loudly instead of importing nothing", () => {
  assert.throws(() => parseSharedList(")]}'\n[[]]"), SharedListError);
  assert.throws(() => parseSharedList("<html>sign in</html>"), SharedListError);
});

test("list ids come out of both full share-link formats", () => {
  assert.equal(listIdFromMapsUrl(new URL(`https://www.google.com/maps/placelists/list/${LIST_ID}?g_ep=1`)), LIST_ID);
  assert.equal(listIdFromMapsUrl(new URL(`https://www.google.com/maps/@/data=!3m1!4b1!4m3!11m2!2s${LIST_ID}!3e3`)), LIST_ID);
  assert.equal(listIdFromMapsUrl(new URL("https://www.google.com/maps/place/Somewhere")), null);
});

test("only Google hosts are ever fetched while resolving a pasted link", async () => {
  let fetched = 0;
  const spy = (async () => {
    fetched++;
    return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } });
  }) as typeof fetch;
  await assert.rejects(resolveSharedListId("https://evil.example/maps/placelists/list/x", spy), SharedListError);
  await assert.rejects(resolveSharedListId("not a url", spy), SharedListError);
  assert.equal(fetched, 0);
  // A short link that redirects off-Google is refused, not followed.
  await assert.rejects(resolveSharedListId("https://maps.app.goo.gl/abc", spy), SharedListError);
  assert.equal(fetched, 1);
  assert.equal(await resolveSharedListId("https://maps.app.goo.gl/abc", fakeGoogle("")), LIST_ID);
});

test("importing the same list again refreshes it in place and keeps resolved place ids", async () => {
  const db = memoryDb();
  const first = await importSharedList(
    "t1",
    "https://maps.app.goo.gl/abc",
    { db, fetchImpl: fakeGoogle(getlistBody([{ name: "Taberna X", note: "octopus", cid: "42", lat: 1, lon: 2 }])) },
  );
  assert.equal(first.refreshed, false);
  assert.equal(first.list.places[0]!.id, "c42");

  // The user renamed the list in Sezar and a place got its Places API id.
  await savePlaceList("t1", {
    ...first.list,
    name: "My Lisbon",
    places: first.list.places.map((p) => ({ ...p, place_id: "ChIJ_example_place" })),
  }, db);

  const second = await importSharedList(
    "t1",
    `https://www.google.com/maps/placelists/list/${LIST_ID}`,
    {
      db,
      fetchImpl: fakeGoogle(
        getlistBody([
          { name: "Taberna X", note: "octopus!", cid: "42", lat: 1, lon: 2 },
          { name: "New spot", cid: "43", lat: 3, lon: 4 },
        ]),
      ),
    },
  );
  assert.equal(second.refreshed, true);
  assert.equal(second.list.id, first.list.id);
  assert.equal(second.list.name, "My Lisbon");
  assert.equal(second.list.places.length, 2);
  assert.equal(second.list.places[0]!.place_id, "ChIJ_example_place");
  assert.equal(second.list.places[0]!.note, "octopus!");

  const lists = await listPlaceLists("t1", db);
  assert.equal(lists.length, 1);
  assert.equal(lists[0]!.count, 2);
  assert.equal((await getPlaceList("t1", first.list.id, db))?.places.length, 2);
  assert.deepEqual(await listPlaceLists("t2", db), []);
});

test("Google Maps links prefer the CID, then the place id, then a search", () => {
  assert.equal(mapsLinkFor({ name: "X", cid: "42" }), "https://maps.google.com/?cid=42");
  assert.equal(
    mapsLinkFor({ name: "Café Y", address: "Lisbon", place_id: "ChIJabc" }),
    "https://www.google.com/maps/search/?api=1&query=Caf%C3%A9%20Y%2C%20Lisbon&query_place_id=ChIJabc",
  );
  assert.equal(mapsLinkFor({ name: "Z" }), "https://www.google.com/maps/search/?api=1&query=Z");
});

test("Places lookups use the free IDs-only search, then one details call", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  const calls: { url: string; mask: string | null }[] = [];
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const mask = new Headers(init?.headers).get("x-goog-fieldmask");
    calls.push({ url, mask });
    if (url.endsWith("places:searchText")) return Response.json({ places: [{ id: "ChIJ_test_place" }] });
    return Response.json({
      id: "ChIJ_test_place",
      displayName: { text: "Taberna X" },
      rating: 4.6,
      userRatingCount: 812,
      priceLevel: "PRICE_LEVEL_MODERATE",
      googleMapsUri: "https://maps.google.com/?cid=42",
      reviews: [{ rating: 5, relativePublishTimeDescription: "a week ago", text: { text: "Great octopus" }, authorAttribution: { displayName: "A. Reviewer" } }],
    });
  }) as typeof fetch;

  const id = await findPlaceId({ name: "Taberna X", address: "Lisbon", lat: 38.7, lon: -9.1 }, fake);
  const d = await placeDetails(id!, { languageCode: "en" }, fake);
  assert.equal(calls[0]!.mask, "places.id");
  assert.ok(calls[1]!.url.includes("/places/ChIJ_test_place?languageCode=en"));
  assert.ok(calls[1]!.mask?.includes("reviews"));
  assert.equal(d.priceLevel, "moderate");
  assert.equal(cidFromMapsUrl(d.mapsUrl), "42");
  assert.deepEqual(d.reviews[0], { rating: 5, when: "a week ago", author: "A. Reviewer", text: "Great octopus" });
  delete process.env.GOOGLE_MAPS_API_KEY;
});

test("Google rate limits are retried briefly, then reported as such", async () => {
  const waits: number[] = [];
  const sleep = async (ms: number) => void waits.push(ms);
  const statuses = [429, 503, 200];
  const flaky = (async () => {
    const status = statuses.shift()!;
    return status === 200 ? new Response(getlistBody([{ name: "A", cid: "1", lat: 0, lon: 0 }])) : new Response("", { status });
  }) as typeof fetch;
  const data = await fetchSharedList(LIST_ID, flaky, sleep);
  assert.equal(data.places.length, 1);
  assert.deepEqual(waits, [2000, 6000]);

  const blocked = (async () => new Response("", { status: 429 })) as typeof fetch;
  await assert.rejects(fetchSharedList(LIST_ID, blocked, sleep), (err: unknown) => err instanceof SharedListError && err.rateLimited);
});

test("a rate-limited refresh answers from the saved copy instead of failing", async () => {
  const db = memoryDb();
  const sleep = async () => {};
  await importSharedList("t1", "https://maps.app.goo.gl/abc", {
    db,
    sleep,
    fetchImpl: fakeGoogle(getlistBody([{ name: "Taberna X", cid: "42", lat: 1, lon: 2 }])),
  });
  const limited = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://maps.app.goo.gl/")) {
      return new Response(null, { status: 302, headers: { location: `https://www.google.com/maps/placelists/list/${LIST_ID}` } });
    }
    return new Response("", { status: 429 });
  }) as typeof fetch;
  const r = await importSharedList("t1", "https://maps.app.goo.gl/abc", { db, sleep, fetchImpl: limited });
  assert.equal(r.stale, true);
  assert.equal(r.list.places[0]!.name, "Taberna X");
  // With nothing saved, the rate limit surfaces.
  await assert.rejects(importSharedList("t2", "https://maps.app.goo.gl/abc", { db, sleep, fetchImpl: limited }), SharedListError);
});

test("joining accounts moves lists across, keeping the newer copy of the same Google list", async () => {
  const db = memoryDb();
  const now = new Date().toISOString();
  const mk = (id: string, name: string, listId?: string) => ({
    id, name, places: [], created_at: now, updated_at: now,
    ...(listId ? { source: { kind: "google_shared_list" as const, list_id: listId, imported_at: now } } : {}),
  });
  await savePlaceList("im:+4915200000000", mk("aaaaaaaaaaaa", "KYOTO", "kyoto"), db);
  await savePlaceList("im:+4915200000000", mk("bbbbbbbbbbbb", "Old copy", "berlin"), db);
  await savePlaceList("main", mk("cccccccccccc", "Berlin", "berlin"), db); // saved later → newer
  const moved = await movePlaceLists("im:+4915200000000", "main", db);
  assert.deepEqual(moved, ["KYOTO"]);
  assert.deepEqual((await listPlaceLists("main", db)).map((l) => l.name).sort(), ["Berlin", "KYOTO"]);
  assert.deepEqual(await listPlaceLists("im:+4915200000000", db), []);
});
