import assert from "node:assert/strict";
import test from "node:test";
import {
  PAGE_TEXT_CHARS,
  PLACES_PAGE_CHARS,
  SEARCH_HIGHLIGHT_CHARS,
  SEARCH_RESULTS_DEFAULT,
  SEARCH_RESULTS_MAX,
  fetchExaContents,
  parseExaPlaces,
  readPage,
  webSearch,
} from "../.flue/lib/exa.js";

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
  assert.equal(calls[0]!.body.numResults, SEARCH_RESULTS_DEFAULT);
  assert.equal(calls[0]!.body.category, undefined);
  assert.deepEqual(calls[0]!.body.contents, { highlights: { maxCharacters: SEARCH_HIGHLIGHT_CHARS } });
  assert.deepEqual(calls[0]!.body.userLocation, { country: "DE", latitude: 52.49, longitude: 13.39 });
  assert.equal(String(calls[1]!.url).endsWith("/contents"), true);
  assert.deepEqual(calls[1]!.body.urls, ["https://exa.ai/library/places?q=abc"]);
  assert.deepEqual(calls[1]!.body.text, { maxCharacters: PLACES_PAGE_CHARS });
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

test("search asks for more results, keeps a long snippet, and passes a people category", async () => {
  process.env.EXA_API_KEY = "test-key";
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const blurb = `${"former Chief Software Architect at Example Labs in Berlin. ".repeat(20)}Now co-founder and CTO of Sample Startup.`;
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Response.json({
      results: [{ url: "https://conf.example/speakers/example", title: "Speaker", highlights: [blurb] }],
    });
  }) as typeof fetch;

  const r = await webSearch({ query: "ex Example Labs founder Berlin", numResults: 100, category: "people" }, fake);
  assert.equal(calls[0]!.body.numResults, SEARCH_RESULTS_MAX);
  assert.equal(calls[0]!.body.category, "people");
  assert.ok((r.pages[0]!.snippet ?? "").includes("Sample Startup"));
  assert.ok((r.pages[0]!.snippet ?? "").length > 400);
  delete process.env.EXA_API_KEY;
});

test("an unknown search category is rejected before Exa is called", async () => {
  process.env.EXA_API_KEY = "test-key";
  let called = false;
  const fake = (async () => {
    called = true;
    return Response.json({ results: [] });
  }) as typeof fetch;
  await assert.rejects(
    () => webSearch({ query: "x", category: "linkedin" as "people" }, fake),
    /Unsupported Exa category/,
  );
  assert.equal(called, false);
  delete process.env.EXA_API_KEY;
});

test("readPage and fetchExaContents share /contents and return the page text", async () => {
  process.env.EXA_API_KEY = "test-key";
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Response.json({
      results: [
        {
          url: "https://conf.example/speakers/jane-doe",
          title: "Jane Doe",
          text: "CTO of Sample Startup. Formerly Chief Software Architect at Example Labs.",
          publishedDate: "2026-01-02T00:00:00.000Z",
        },
      ],
      costDollars: { total: 0.001 },
    });
  }) as typeof fetch;

  const page = await readPage("https://conf.example/speakers/jane-doe", fake);
  assert.equal(String(calls[0]!.url).endsWith("/contents"), true);
  assert.deepEqual(calls[0]!.body.urls, ["https://conf.example/speakers/jane-doe"]);
  assert.deepEqual(calls[0]!.body.text, { maxCharacters: PAGE_TEXT_CHARS });
  assert.equal(page.title, "Jane Doe");
  assert.equal(page.published, "2026-01-02");
  assert.match(page.text, /Sample Startup/);
  assert.equal(page.costUsd, 0.001);

  calls.length = 0;
  const many = await fetchExaContents(
    ["https://startup.example/", "https://example.com/team"],
    { maxCharacters: 1000 },
    fake,
  );
  assert.deepEqual(calls[0]!.body.urls, ["https://startup.example/", "https://example.com/team"]);
  assert.deepEqual(calls[0]!.body.text, { maxCharacters: 1000 });
  assert.equal(many.pages[0]!.title, "Jane Doe");
  delete process.env.EXA_API_KEY;
});

test("a non-OK contents response fails readPage and is ignored for a Places page", async () => {
  process.env.EXA_API_KEY = "test-key";
  const deny = (async () => new Response("nope", { status: 403 })) as typeof fetch;
  await assert.rejects(() => readPage("https://example.com/bio", deny), /Exa \/contents failed \(403\)/);

  const search = (async (input: string | URL | Request) => {
    if (String(input).endsWith("/search")) {
      return Response.json({
        results: [{ url: "https://exa.ai/library/places?q=abc", title: "Places" }],
        costDollars: { total: 0.007 },
      });
    }
    return new Response("nope", { status: 503 });
  }) as typeof fetch;
  const r = await webSearch({ query: "ramen" }, search);
  assert.equal(r.places.length, 0);
  assert.equal(r.costUsd, 0.007);
  delete process.env.EXA_API_KEY;
});
