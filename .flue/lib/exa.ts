// Exa web search — live results for places ("Exa Places"), people, companies,
// and the open web.
//
// One search (with query-relevant highlights per result). When Exa answers
// with one of its Places pages (exa.ai/library/places?q=…), we fetch that
// page's full text through the shared contents helper: it holds one markdown
// section per venue with address + coordinates, rating, hours and recent
// reviews (no reviewer names), which we parse into compact records. The
// coordinates go straight onto MapToAgent pins.
//
// read_page uses the same helper to open an ordinary URL (a bio, a company
// site, a news article) after search. Public profile previews that show up
// in search are readable this way; nothing here logs into LinkedIn.
//
// Queries and URLs leave our infrastructure (Exa, US): callers must keep
// personal and health details out of them.

const API = "https://api.exa.ai";
const PLACES_PAGE = "https://exa.ai/library/places";

/**
 * Exa search `category` values this app passes through.
 * Confirmed on the Search API: `people` (professional profiles), `company`,
 * and `news` are real categories. A general search omits `category` so bios,
 * startup sites and talks stay in the index — `people` would hide them.
 */
export const EXA_SEARCH_CATEGORIES = ["people", "company", "news"] as const;
export type ExaSearchCategory = (typeof EXA_SEARCH_CATEGORIES)[number];

/** Exa allows up to 100. Cap below that so a research turn stays bounded. */
export const SEARCH_RESULTS_DEFAULT = 10;
export const SEARCH_RESULTS_MAX = 25;
/** Highlight budget per URL. A headline plus a career blurb, not a 300-char clip. */
export const SEARCH_HIGHLIGHT_CHARS = 2_000;
/** What we hand the model after joining a result's highlights. */
export const SEARCH_SNIPPET_CHARS = 2_000;
/** Page text for read_page. Places pages ask for the full venue list instead. */
export const PAGE_TEXT_CHARS = 12_000;
export const PLACES_PAGE_CHARS = 60_000;

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

const clampResults = (n: number | undefined): number => {
  const requested = n === undefined || !Number.isFinite(n) ? SEARCH_RESULTS_DEFAULT : Math.trunc(n);
  return Math.min(Math.max(requested, 1), SEARCH_RESULTS_MAX);
};

const normalizeCategory = (category: string | undefined): ExaSearchCategory | undefined => {
  if (!category) return undefined;
  if ((EXA_SEARCH_CATEGORIES as readonly string[]).includes(category)) return category as ExaSearchCategory;
  throw new Error(`Unsupported Exa category "${category}". Use people, company, or news, or omit it.`);
};

export type ExaDocument = {
  url: string;
  title?: string;
  text?: string;
  published?: string;
};

type ContentsResponse = {
  results?: { url?: string; title?: string; text?: string; publishedDate?: string }[];
  costDollars?: { total?: number };
};

type ContentsOutcome =
  | { ok: true; pages: ExaDocument[]; costUsd?: number }
  | { ok: false; error: string };

/** POST /contents. HTTP errors come back as `{ ok: false }`; network errors throw. */
async function requestContents(
  urls: string[],
  opts: { maxCharacters?: number },
  fetchImpl: Fetch,
): Promise<ContentsOutcome> {
  const res = await fetchImpl(`${API}/contents`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      urls,
      text: { maxCharacters: opts.maxCharacters },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    return { ok: false, error: `Exa /contents failed (${res.status}): ${(await res.text()).slice(0, 200)}` };
  }
  const data = (await res.json()) as ContentsResponse;
  const pages: ExaDocument[] = (data.results ?? []).map((r, i) => ({
    url: r.url || urls[i] || "",
    ...(r.title ? { title: r.title } : {}),
    ...(r.text ? { text: r.text } : {}),
    ...(r.publishedDate ? { published: r.publishedDate.slice(0, 10) } : {}),
  }));
  return { ok: true, pages, ...(data.costDollars?.total !== undefined ? { costUsd: data.costDollars.total } : {}) };
}

/**
 * POST /contents. Shared by Places-page enrichment and read_page.
 * Throws on a non-OK response.
 */
export async function fetchExaContents(
  urls: string[],
  opts: { maxCharacters?: number } = {},
  fetchImpl: Fetch = fetch,
): Promise<{ pages: ExaDocument[]; costUsd?: number }> {
  const outcome = await requestContents(urls, { maxCharacters: opts.maxCharacters ?? PAGE_TEXT_CHARS }, fetchImpl);
  if (!outcome.ok) throw new Error(outcome.error);
  return { pages: outcome.pages, ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}) };
}

export type ReadPageResult = {
  url: string;
  title?: string;
  text: string;
  published?: string;
  costUsd?: number;
};

/** Open one public URL via Exa /contents and return its text. */
export async function readPage(url: string, fetchImpl: Fetch = fetch): Promise<ReadPageResult> {
  const { pages, costUsd } = await fetchExaContents([url], { maxCharacters: PAGE_TEXT_CHARS }, fetchImpl);
  const page = pages[0];
  const text = page?.text ?? "";
  return {
    url: page?.url || url,
    ...(page?.title ? { title: page.title } : {}),
    text: text.length <= PAGE_TEXT_CHARS ? text : `${text.slice(0, PAGE_TEXT_CHARS)}…`,
    ...(page?.published ? { published: page.published } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

export async function webSearch(
  opts: {
    query: string;
    country?: string;
    lat?: number;
    lon?: number;
    numResults?: number;
    category?: ExaSearchCategory;
  },
  fetchImpl: Fetch = fetch,
): Promise<WebSearchResult> {
  const category = normalizeCategory(opts.category);
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
      numResults: clampResults(opts.numResults),
      ...(category ? { category } : {}),
      ...(userLocation ? { userLocation } : {}),
      contents: { highlights: { maxCharacters: SEARCH_HIGHLIGHT_CHARS } },
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
    // Expanding the Places page is best-effort: a non-OK contents response
    // leaves the other hits in place. A network failure still throws.
    const contents = await requestContents([placesHit.url], { maxCharacters: PLACES_PAGE_CHARS }, fetchImpl);
    if (contents.ok) {
      places = parseExaPlaces(contents.pages[0]?.text ?? "");
      if (cost !== undefined && contents.costUsd !== undefined) cost += contents.costUsd;
    }
  }

  const pages: ExaPage[] = results
    .filter((r) => r !== placesHit)
    .map((r) => ({
      url: r.url,
      ...(r.title ? { title: r.title } : {}),
      ...(r.publishedDate ? { published: r.publishedDate.slice(0, 10) } : {}),
      ...(r.highlights?.length
        ? { snippet: clip(r.highlights.join(" … ").replace(/\s+/g, " "), SEARCH_SNIPPET_CHARS) }
        : {}),
    }));
  return { places, pages, ...(cost !== undefined ? { costUsd: cost } : {}) };
}
