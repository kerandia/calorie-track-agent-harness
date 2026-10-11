import type { ToolDef } from "@flue/runtime";
import { Type } from "@flue/runtime";
import { exaConfigured, webSearch, type ExaPlace } from "../lib/exa.js";
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
      "Live search of places and the web. Use it BEFORE recommending specific restaurants, cafés, bars, shops or venues (your memory goes stale and places close), to check hours or whether a place still exists, and for anything current: events, openings, news, prices. Describe it like asking a local: what, where, the attributes that matter ('late-night ramen in Kreuzberg with counter seating'). Place results come back with address, coordinates (use them for publish_map pins), rating, hours and recent reviews. The query goes to an external search engine (Exa): put ONLY what to find and where in it — never the user's name, health details or anything else personal.",
    parameters: Type.Object({
      query: Type.String(),
      country: Type.Optional(Type.String({ description: "ISO 3166-1 alpha-2 code of where the user is or is searching, e.g. 'DE'." })),
      lat: Type.Optional(Type.Number({ description: "Only for 'near me / near X' searches, together with lon. Two decimals is enough." })),
      lon: Type.Optional(Type.Number()),
      max_results: Type.Optional(Type.Number({ description: "Web results, default 6, max 10." })),
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
      });
      console.log(
        JSON.stringify({ evt: "web_search", places: r.places.length, pages: r.pages.length, costUsd: r.costUsd }),
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

  return { tools: [webSearchTool] };
}
