import type { ToolDef } from "@flue/runtime";
import { Type } from "@flue/runtime";
import { exaConfigured, readPage, webSearch, type ExaPlace, type ExaSearchCategory } from "../lib/exa.js";
import { recordSpend } from "../lib/metrics.js";

export function createSearchCapability() {
  // ── Live web + place search (Exa) ─────────────────────────────────────────

  const placeLine = (p: ExaPlace, i: number): string => {
    const parts = [
      `${i + 1}. ${p.name}`,
      p.category,
      p.address ? `${p.address}${p.lat !== undefined ? ` (${p.lat},${p.lon})` : ""}` : undefined,
      p.rating !== undefined ? `${p.rating}★${p.ratingCount ? ` (${p.ratingCount.toLocaleString("en")})` : ""}` : undefined,
      p.hours?.length ? `hours: ${p.hours.join("; ")}` : undefined,
      p.website,
    ].filter(Boolean);
    const reviews = (p.reviews ?? []).map(
      (r) => `"${r.text}"${r.stars ? ` (${r.stars}★${r.when ? `, ${r.when}` : ""})` : ""}`,
    );
    return parts.join(" — ") + (reviews.length ? `\n   reviews: ${reviews.join(" ")}` : "");
  };

  const webSearchTool: ToolDef = {
    name: "web_search",
    description:
      "Live search of places, people, companies and the open web. Use it BEFORE recommending specific restaurants, cafés, bars, shops or venues (your memory goes stale and places close), to check hours or whether a place still exists, and for anything you have to look up: a person, who used to work somewhere, a startup, news, prices, whether a fact is still true. For a person or alumni question, run several different queries (former-employee wording, role + company, city, university) — one pass is not a search. Set category only to narrow the index: people (professional profiles), company (company pages), or news. Leave category unset for the open web, because a people-only search hides conference bios, startup sites and news posts. Place results come back with address, coordinates (use them for publish_map pins), rating, hours and recent reviews. Snippets are leads, including public profile previews: open the best URLs with read_page before you decide someone isn't findable. Nothing here is blocked and you are not logging in. The query goes to an external search engine (Exa): put ONLY what to find and where in it — never the user's name, health details or anything else personal.",
    parameters: Type.Object({
      query: Type.String(),
      country: Type.Optional(Type.String({ description: "ISO 3166-1 alpha-2 code of where the user is or is searching, e.g. 'DE'." })),
      lat: Type.Optional(Type.Number({ description: "Only for 'near me / near X' searches, together with lon. Two decimals is enough." })),
      lon: Type.Optional(Type.Number()),
      max_results: Type.Optional(Type.Number({ description: "Web results. Default 10, max 25. Ask for more than the default on people and company research." })),
      category: Type.Optional(
        Type.Union([Type.Literal("people"), Type.Literal("company"), Type.Literal("news")], {
          description:
            "Optional Exa index. people = professional profiles, company = company pages, news = news. Omit for a general web search (bios, startup sites, talks). Do not use people as a substitute for the open web.",
        }),
      ),
    }),
    execute: async (args) => {
      if (!exaConfigured()) return "Web search is switched off (no EXA_API_KEY). Answer from what you know and say it may be out of date.";
      const round = (n: number | undefined) => (n === undefined ? undefined : Math.round(n * 100) / 100);
      const r = await webSearch({
        query: args.query,
        country: args.country?.toUpperCase(),
        lat: round(args.lat),
        lon: round(args.lon),
        numResults: args.max_results,
        category: args.category as ExaSearchCategory | undefined,
      });
      console.log(
        JSON.stringify({
          evt: "web_search",
          places: r.places.length,
          pages: r.pages.length,
          category: args.category,
          costUsd: r.costUsd,
        }),
      );
      if (r.costUsd) await recordSpend("exa", r.costUsd);
      const out: string[] = [];
      if (r.places.length) {
        out.push(`Places (live, Exa):`, ...r.places.map(placeLine));
      }
      if (r.pages.length) {
        out.push(
          `Web:`,
          ...r.pages.map(
            (p) => `- ${p.title ?? p.url}${p.published ? ` (${p.published})` : ""} — ${p.url}${p.snippet ? `\n  ${p.snippet}` : ""}`,
          ),
        );
      }
      return out.length ? out.join("\n") : "No results.";
    },
  };

  const readPageTool: ToolDef = {
    name: "read_page",
    description:
      "Open a public page and read its text, via the same search provider (Exa /contents). It does not log in. Use it after web_search on the best result URLs: a conference bio, a company about page, a news article, a personal site, a public profile preview the search already showed. Snippets are short; read the page before you say someone isn't findable or quote a career path. A current team page only shows who works there now, so it cannot answer who used to. If a page comes back empty, say so and try another URL — don't tell the user the site blocked you. Not for Google Maps lists (import_google_maps_list) or a place's hours and reviews (place_details).",
    parameters: Type.Object({
      url: Type.String({ description: "http(s) URL from a web_search result." }),
    }),
    execute: async (args) => {
      if (!exaConfigured()) return "Page reading is switched off (no EXA_API_KEY). Answer from the search snippets and say you couldn't open the page.";
      const url = args.url.trim();
      if (!/^https?:\/\//i.test(url)) return "read_page needs an http(s) URL from a search result.";
      const page = await readPage(url);
      console.log(JSON.stringify({ evt: "read_page", url: page.url, chars: page.text.length, costUsd: page.costUsd }));
      if (page.costUsd) await recordSpend("exa", page.costUsd);
      const head = [page.title, page.url, page.published].filter(Boolean).join(" — ");
      const body = page.text.trim();
      return body
        ? `${head}\n\n${body}`
        : `${head}\n\n(No text extracted from this URL. Use the search snippet, or open a different result.)`;
    },
  };

  return { tools: [webSearchTool, readPageTool] };
}
