import assert from "node:assert/strict";
import test from "node:test";
import { parseExaPlaces, webSearch } from "../.flue/lib/exa.js";

// Same layout as an Exa Places page (synthetic venues).
const PLACES_PAGE = `# ramen in Example Town - Exa Places

Two places are listed here for "ramen in Example Town".

## Search area

The search covered Example Town, within 52.47°N–52.53°N.

## Noodle Bar One

Noodle Bar One is a japanese restaurant at Main St 1, Example Town. It is rated 4.5 from 4,408 ratings.

### Details

- Categories: Japanese Restaurant
- Address: Main St 1, Example Town 10961, DE (52.48953, 13.39043)
- Phone: +49300000000
- Rating: 4.5 stars (4408 ratings)
- URLs: website https://noodle-one.example/, facebook https://facebook.com/1

### Hours

- Monday–Sunday: 11:30 AM–10 PM

### Busiest times

- Monday: peaks around 6pm

### Reviews

Eight reviews, most recent first.

- 4 stars, Jun 2026: Great broth: rich, not salty.
- 5 stars, Apr 2026: Counter seats, fast.
- 3 stars, Mar 2026: Too loud.

## Quiet Udon

Quiet Udon is a noodle shop.

### Details

- Address: Side St 2, Example Town (52.5, -0.25)
- Rating: 4 stars
`;

test("an Exa Places page parses into compact venues with coordinates", () => {
  const places = parseExaPlaces(PLACES_PAGE);
  assert.equal(places.length, 2);
  assert.deepEqual(places[0], {
    name: "Noodle Bar One",
    summary: "Noodle Bar One is a japanese restaurant at Main St 1, Example Town. It is rated 4.5 from 4,408 ratings.",
    category: "Japanese Restaurant",
    address: "Main St 1, Example Town 10961, DE",
    lat: 52.48953,
    lon: 13.39043,
    phone: "+49300000000",
    rating: 4.5,
    ratingCount: 4408,
    website: "https://noodle-one.example/",
    hours: ["Monday–Sunday: 11:30 AM–10 PM"],
    reviews: [
      { stars: 4, when: "Jun 2026", text: "Great broth: rich, not salty." },
      { stars: 5, when: "Apr 2026", text: "Counter seats, fast." },
    ],
  });
  assert.equal(places[1]!.lon, -0.25);
  assert.equal(places[1]!.rating, 4);
  assert.equal(places[1]!.ratingCount, undefined);
});

test("search fetches the full Places page once and keeps other hits as web results", async () => {
  process.env.EXA_API_KEY = "test-key";
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url, body });
    if (url.endsWith("/search")) {
      return Response.json({
        results: [
          { url: "https://exa.ai/library/places?q=abc", title: "ramen - Exa Places", highlights: ["…"] },
          { url: "https://blog.example/ramen", title: "Best ramen", publishedDate: "2026-05-01T00:00:00Z", highlights: ["Try Noodle Bar One"] },
        ],
        costDollars: { total: 0.007 },
      });
    }
    return Response.json({ results: [{ text: PLACES_PAGE }], costDollars: { total: 0.001 } });
  }) as typeof fetch;

  const r = await webSearch({ query: "ramen in Example Town", country: "DE", lat: 52.49, lon: 13.39 }, fake);
  assert.deepEqual(calls[0]!.body.userLocation, { country: "DE", latitude: 52.49, longitude: 13.39 });
  assert.deepEqual(calls[1]!.body.urls, ["https://exa.ai/library/places?q=abc"]);
  assert.equal(r.places.length, 2);
  assert.deepEqual(r.pages, [
    { url: "https://blog.example/ramen", title: "Best ramen", published: "2026-05-01", snippet: "Try Noodle Bar One" },
  ]);
  assert.equal(r.costUsd, 0.008);

  calls.length = 0;
  const noPlaces = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Response.json({ results: [{ url: "https://news.example/a", title: "News" }] });
  }) as typeof fetch;
  const web = await webSearch({ query: "festival dates" }, noPlaces);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.body.userLocation, undefined);
  assert.equal(web.places.length, 0);
  delete process.env.EXA_API_KEY;
});
