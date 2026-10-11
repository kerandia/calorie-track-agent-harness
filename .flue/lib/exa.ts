// Exa web search — live results for places ("Exa Places") and the open web.
//
// One search ($0.007, with query-relevant highlights per result). When Exa
// answers with one of its Places pages (exa.ai/library/places?q=…), we fetch
// that page's full text in a second call ($0.001): it holds one markdown
// section per venue with address + coordinates, rating, hours and recent
// reviews (no reviewer names), which we parse into compact records. The
// coordinates go straight onto MapToAgent pins.
//
// Queries leave our infrastructure (Exa, US): callers must keep personal and
// health details out of them.

const API = "https://api.exa.ai";
const PLACES_PAGE = "https://exa.ai/library/places";

export const exaConfigured = (): boolean => Boolean(process.env.EXA_API_KEY);

type Fetch = typeof fetch;

export type ExaPlace = {
  name: string;
  summary?: string;
  category?: string;
  address?: string;
  lat?: number;
  lon?: number;
  phone?: string;
  rating?: number;
  ratingCount?: number;
  website?: string;
  hours?: string[];
  reviews?: { stars?: number; when?: string; text: string }[];
};

export type ExaPage = { title?: string; url: string; snippet?: string; published?: string };

export type WebSearchResult = { places: ExaPlace[]; pages: ExaPage[]; costUsd?: number };

const bullets = (block: string | undefined): string[] =>
  (block ?? "")
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim());

const clip = (s: string, max = 200): string =>
  s.length <= max ? s : `${s.slice(0, s.lastIndexOf(" ", max - 1) > 0 ? s.lastIndexOf(" ", max - 1) : max)}…`;

/** Split one venue's markdown into its "### Heading" blocks. */
const subsections = (body: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const part of body.split(/^### /m).slice(1)) {
    const nl = part.indexOf("\n");
    out.set(part.slice(0, nl).trim().toLowerCase(), part.slice(nl + 1));
  }
  return out;
};

/** Parse the venue sections of an Exa Places page. */
export function parseExaPlaces(text: string, maxReviews = 2): ExaPlace[] {
  const places: ExaPlace[] = [];
  for (const section of text.split(/^## /m).slice(1)) {
    const nl = section.indexOf("\n");
    const name = section.slice(0, nl === -1 ? undefined : nl).trim();
    if (!name || name.toLowerCase() === "search area") continue;
    const body = nl === -1 ? "" : section.slice(nl + 1);
    const summary = body.split(/^### /m)[0]!.trim().split("\n\n")[0]?.trim();
    const subs = subsections(body);

    const place: ExaPlace = { name, ...(summary ? { summary } : {}) };
    for (const line of bullets(subs.get("details"))) {
      const [label, ...rest] = line.split(": ");
      const value = rest.join(": ").trim();
      switch (label?.toLowerCase()) {
        case "categories":
          place.category = value;
          break;
        case "address": {
          const m = /^(.*?)\s*\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)\s*$/.exec(value);
          place.address = m ? m[1] : value;
          if (m) {
            place.lat = Number(m[2]);
            place.lon = Number(m[3]);
          }
          break;
        }
        case "phone":
          place.phone = value;
          break;
        case "rating": {
          const m = /([\d.]+)\s*stars?(?:\s*\((\d[\d,]*)\s*ratings?\))?/i.exec(value);
          if (m) {
            place.rating = Number(m[1]);
            if (m[2]) place.ratingCount = Number(m[2].replace(/,/g, ""));
          }
          break;
        }
        case "urls": {
          const site = /website\s+(https?:\/\/\S+?)(?:,|\s|$)/i.exec(value);
          // Booking links carry long tracking tokens; the bare URL is enough.
          if (site) place.website = site[1]!.split("?")[0];
          break;
        }
      }
    }
    const hours = bullets(subs.get("hours"));
    if (hours.length) place.hours = hours;
    const reviews = bullets(subs.get("reviews"))
      .slice(0, maxReviews)
      .map((r) => {
        const m = /^(\d)\s*stars?,\s*([^:]+):\s*(.*)$/i.exec(r);
        return m
          ? { stars: Number(m[1]), when: m[2]!.trim(), text: clip(m[3]!) }
          : { text: clip(r) };
      });
    if (reviews.length) place.reviews = reviews;
    places.push(place);
  }
  return places;
}

const headers = (): Record<string, string> => {
  const key = process.env.EXA_API_KEY;
  if (!key) throw new Error("EXA_API_KEY not set");
  return { "x-api-key": key, "Content-Type": "application/json" };
};

export async function webSearch(
  opts: { query: string; country?: string; lat?: number; lon?: number; numResults?: number },
  fetchImpl: Fetch = fetch,
): Promise<WebSearchResult> {
  const userLocation =
    opts.lat !== undefined && opts.lon !== undefined
      ? { ...(opts.country ? { country: opts.country } : {}), latitude: opts.lat, longitude: opts.lon }
      : opts.country;
  const res = await fetchImpl(`${API}/search`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      query: opts.query,
      type: "auto",
      numResults: Math.min(Math.max(opts.numResults ?? 6, 1), 10),
      ...(userLocation ? { userLocation } : {}),
      contents: { highlights: { maxCharacters: 300 } },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Exa search failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as {
    results?: { title?: string; url: string; publishedDate?: string; highlights?: string[] }[];
    costDollars?: { total?: number };
  };
  const results = data.results ?? [];
  let cost = data.costDollars?.total;

  const placesHit = results.find((r) => r.url.startsWith(PLACES_PAGE));
  let places: ExaPlace[] = [];
  if (placesHit) {
    const c = await fetchImpl(`${API}/contents`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ urls: [placesHit.url], text: { maxCharacters: 60_000 } }),
      signal: AbortSignal.timeout(20_000),
    });
    if (c.ok) {
      const cd = (await c.json()) as { results?: { text?: string }[]; costDollars?: { total?: number } };
      places = parseExaPlaces(cd.results?.[0]?.text ?? "");
      if (cost !== undefined && cd.costDollars?.total !== undefined) cost += cd.costDollars.total;
    }
  }

  const pages: ExaPage[] = results
    .filter((r) => r !== placesHit)
    .map((r) => ({
      url: r.url,
      ...(r.title ? { title: r.title } : {}),
      ...(r.publishedDate ? { published: r.publishedDate.slice(0, 10) } : {}),
      ...(r.highlights?.length ? { snippet: r.highlights.join(" … ").replace(/\s+/g, " ").slice(0, 400) } : {}),
    }));
  return { places, pages, ...(cost !== undefined ? { costUsd: cost } : {}) };
}
