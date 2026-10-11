import type { ToolDef } from "@flue/runtime";
import { Type } from "@flue/runtime";
import {
  deletePlaceList,
  getPlaceList,
  importSharedList,
  listPlaceLists,
  mapsLinkFor,
  newListId,
  newPlaceId,
  savePlaceList,
  SharedListError,
  type PlaceList,
  type SavedPlace,
} from "../lib/placeLists.js";
import { cidFromMapsUrl, findPlaceId, placeDetails, placesConfigured } from "../lib/placesApi.js";

export function createPlacesCapability(tenantId: string) {
  // ── Place lists (Sezar's own) + Google Maps shared-list import + details ──

  const placeLine = (p: SavedPlace): string => {
    const where = p.address ? ` — ${p.address}` : "";
    const coords = p.lat !== undefined && p.lon !== undefined ? ` (${p.lat.toFixed(5)},${p.lon.toFixed(5)})` : "";
    const note = p.note ? ` — note: "${p.note}"` : "";
    return `[${p.id}] ${p.name}${where}${coords}${note} — ${mapsLinkFor(p)}`;
  };

  const requireList = async (listId: string): Promise<PlaceList> => {
    const list = await getPlaceList(tenantId, listId);
    if (!list) throw new Error(`No place list with id ${listId}. Call get_place_lists to see the lists.`);
    return list;
  };

  const importTool: ToolDef = {
    name: "import_google_maps_list",
    description:
      "Import a Google Maps list the user shared by link (maps.app.goo.gl/… or google.com/maps/placelists/…) into a Sezar place list: every place with its address, coordinates and the owner's note. Importing the same link again refreshes that Sezar list instead of duplicating it. Works for any list shared by link — the user's own or a friend's. It cannot read private lists, and nothing can edit the user's Google lists.",
    parameters: Type.Object({
      url: Type.String({ description: "The share link exactly as the user sent it." }),
    }),
    execute: async (args) => {
      try {
        const { list, refreshed, truncated, unreadable, stale } = await importSharedList(tenantId, args.url);
        if (stale) {
          return [
            `Couldn't refresh "${list.name}": Google is rate-limiting list requests from our server right now. Using the saved copy [${list.id}] from ${(list.source?.imported_at ?? list.updated_at).slice(0, 10)} (${list.places.length} places) — get_place_lists reads it.`,
            "Answer from that copy and tell the user it may be missing their latest changes; they can resend the link in ~15 minutes to refresh. Don't retry, wait, or fetch the list any other way.",
          ].join("\n");
        }
        const noted = list.places.filter((p) => p.note);
        const sample = [...noted, ...list.places.filter((p) => !p.note)].slice(0, 25);
        return [
          `${refreshed ? "Refreshed" : "Imported"} "${list.name}" as Sezar list [${list.id}]: ${list.places.length} places, ${noted.length} with the owner's notes.` +
            (truncated ? ` The list is longer than ${list.places.length} places; only the first ${list.places.length} were imported.` : " That's the whole list.") +
            (unreadable ? ` ${unreadable} entr${unreadable === 1 ? "y" : "ies"} had no name or location and were skipped.` : ""),
          ...sample.map(placeLine),
          list.places.length > sample.length ? `…and ${list.places.length - sample.length} more (get_place_lists to see all).` : "",
          "The list name, the kinds of places and especially the notes are the owner's own taste. If it's the user's own list and a clear pattern shows, record it with note_assumption. Don't claim you changed anything in their Google Maps.",
        ]
          .filter(Boolean)
          .join("\n");
      } catch (err) {
        if (err instanceof SharedListError) {
          return err.rateLimited
            ? `Couldn't import: ${err.message} Tell the user to resend the link in ~15 minutes. Don't retry, wait, or fetch the list any other way (no curl, no sandbox).`
            : `Couldn't import: ${err.message}`;
        }
        throw err;
      }
    },
  };

  const getListsTool: ToolDef = {
    name: "get_place_lists",
    description:
      "Without list_id: the user's Sezar place lists (name, size, source). With list_id: that list's places with notes, coordinates and a Google Maps link each, optionally filtered by a text query over name, address and note.",
    parameters: Type.Object({
      list_id: Type.Optional(Type.String()),
      query: Type.Optional(Type.String({ description: "Case-insensitive filter, e.g. 'ramen' or 'Shibuya'." })),
      limit: Type.Optional(Type.Number({ description: "Max places to return. Default 40, max 200." })),
    }),
    execute: async (args) => {
      if (!args.list_id) {
        const lists = await listPlaceLists(tenantId);
        if (lists.length === 0) return "No place lists yet. The user can share a Google Maps list link to import one.";
        return lists
          .map(
            (l) =>
              `[${l.id}] "${l.name}" — ${l.count} places` +
              (l.source ? ` (imported from a shared Google Maps list ${l.source.imported_at.slice(0, 10)})` : ""),
          )
          .join("\n");
      }
      const list = await requireList(args.list_id);
      const q = args.query?.trim().toLowerCase();
      const matches = q
        ? list.places.filter((p) => [p.name, p.address, p.note].some((f) => f?.toLowerCase().includes(q)))
        : list.places;
      const limit = Math.min(Math.max(args.limit ?? 40, 1), 200);
      return [
        `"${list.name}" [${list.id}]: ${matches.length}${q ? ` of ${list.places.length}` : ""} places.`,
        ...matches.slice(0, limit).map(placeLine),
        matches.length > limit ? `…${matches.length - limit} more; narrow with query.` : "",
      ]
        .filter(Boolean)
        .join("\n");
    },
  };

  const placeInput = Type.Object({
    name: Type.String(),
    address: Type.Optional(Type.String()),
    note: Type.Optional(Type.String({ description: "The user's own note, in their words." })),
    lat: Type.Optional(Type.Number()),
    lon: Type.Optional(Type.Number()),
  });

  const updateListTool: ToolDef = {
    name: "update_place_list",
    description:
      "Create or change one of the user's Sezar place lists (never their Google Maps lists — for those, give the place's Google Maps link so they can tap Save). Omit list_id to create a list (name required). Can rename, add places, remove places by id, set notes, or delete the whole list (only when the user asks).",
    parameters: Type.Object({
      list_id: Type.Optional(Type.String()),
      name: Type.Optional(Type.String({ description: "New list name, or the name of the list being created." })),
      add: Type.Optional(Type.Array(placeInput, { description: "Places to add." })),
      remove: Type.Optional(Type.Array(Type.String(), { description: "Place ids to remove." })),
      notes: Type.Optional(
        Type.Array(Type.Object({ place_id: Type.String(), note: Type.String() }), {
          description: "Set (or with an empty string, clear) the note on places.",
        }),
      ),
      delete_list: Type.Optional(Type.Boolean()),
    }),
    execute: async (args) => {
      const now = new Date().toISOString();
      if (args.list_id && args.delete_list) {
        const list = await requireList(args.list_id);
        await deletePlaceList(tenantId, list.id);
        return `Deleted Sezar list "${list.name}".`;
      }
      let list: PlaceList;
      if (args.list_id) {
        list = await requireList(args.list_id);
      } else {
        if (!args.name?.trim()) return "Give the new list a name.";
        list = { id: newListId(), name: args.name.trim(), places: [], created_at: now, updated_at: now };
      }
      if (args.list_id && args.name?.trim()) list.name = args.name.trim();

      const removed = new Set(args.remove ?? []);
      let places = list.places.filter((p) => !removed.has(p.id));
      const removedCount = list.places.length - places.length;

      const notes = new Map<string, string>(
        (args.notes ?? []).map((n: { place_id: string; note: string }) => [n.place_id, n.note.trim()] as const),
      );
      places = places.map((p) => {
        if (!notes.has(p.id)) return p;
        const note = notes.get(p.id)!;
        const { note: _old, ...rest } = p;
        return note ? { ...rest, note: note.slice(0, 500) } : rest;
      });

      const added: SavedPlace[] = (args.add ?? []).map(
        (a: { name: string; address?: string; note?: string; lat?: number; lon?: number }) => ({
          id: newPlaceId(),
          name: a.name.trim(),
          ...(a.address ? { address: a.address } : {}),
          ...(a.note ? { note: a.note.slice(0, 500) } : {}),
          ...(a.lat !== undefined && a.lon !== undefined ? { lat: a.lat, lon: a.lon } : {}),
          added_at: now,
        }),
      );
      const saved = await savePlaceList(tenantId, { ...list, places: [...places, ...added] });
      const parts = [
        args.list_id ? `Updated "${saved.name}" [${saved.id}]` : `Created "${saved.name}" [${saved.id}]`,
        added.length ? `added ${added.length}` : "",
        removedCount ? `removed ${removedCount}` : "",
        notes.size ? `set ${notes.size} note(s)` : "",
      ].filter(Boolean);
      return [
        `${parts.join(", ")} — ${saved.places.length} places now.`,
        ...added.map(placeLine),
      ].join("\n");
    },
  };

  const placeDetailsTool: ToolDef = {
    name: "place_details",
    description:
      "Google's current info on a place: rating, number of ratings, price level, opening hours, website and up to 5 Google reviews. Pass list_id + place_id for a place in a Sezar list, or query ('Marcy Land ramen Tokyo') for any place. Quote reviews as Google reviews (with the author's name). Ratings and reviews belong in the chat reply only — never put them into publish_map notes or onto a map (Google's EEA terms).",
    parameters: Type.Object({
      list_id: Type.Optional(Type.String()),
      place_id: Type.Optional(Type.String({ description: "A place id from get_place_lists." })),
      query: Type.Optional(Type.String({ description: "Name plus city or address, when the place isn't in a list." })),
      language: Type.Optional(Type.String({ description: "Language code for reviews, e.g. 'en', 'tr'." })),
    }),
    execute: async (args) => {
      if (!placesConfigured()) return "Place details are switched off (no Google Maps API key configured). Answer from what you know and say so.";

      let target: { name: string; address?: string; lat?: number; lon?: number; cid?: string; place_id?: string };
      let list: PlaceList | null = null;
      if (args.list_id && args.place_id) {
        list = await requireList(args.list_id);
        const place = list.places.find((p) => p.id === args.place_id);
        if (!place) return `No place ${args.place_id} in "${list.name}".`;
        target = place;
      } else if (args.query?.trim()) {
        target = { name: args.query.trim() };
      } else {
        return "Pass list_id + place_id, or a query.";
      }

      const placeId = target.place_id ?? (await findPlaceId({ ...target, languageCode: args.language }));
      if (!placeId) return `Google found no place for "${target.name}".`;
      const d = await placeDetails(placeId, { languageCode: args.language });

      // A list place carries Google's CID: confirm the name search found that exact place.
      const returnedCid = cidFromMapsUrl(d.mapsUrl);
      const mismatch = Boolean(target.cid && returnedCid && target.cid !== returnedCid);
      if (list && args.place_id && !mismatch && !target.place_id) {
        await savePlaceList(tenantId, {
          ...list,
          places: list.places.map((p) => (p.id === args.place_id ? { ...p, place_id: d.id } : p)),
        });
      }

      const lines = [
        mismatch ? `⚠ Google matched "${d.name}", which may not be the exact place in the list.` : "",
        `${d.name ?? target.name}${d.type ? ` (${d.type})` : ""}${d.address ? ` — ${d.address}` : ""}`,
        d.rating !== undefined ? `Google rating ${d.rating} from ${d.ratingCount ?? "?"} ratings` : "No Google rating",
        d.priceLevel ? `Price: ${d.priceLevel}` : "",
        d.openNow !== undefined ? (d.openNow ? "Open now" : "Closed now") : "",
        d.hours?.length ? `Hours: ${d.hours.join("; ")}` : "",
        d.website ? `Website: ${d.website}` : "",
        d.mapsUrl ? `Google Maps: ${d.mapsUrl}` : "",
        ...d.reviews.map(
          (r) => `Google review${r.author ? ` by ${r.author}` : ""}${r.rating ? ` (${r.rating}★)` : ""}${r.when ? `, ${r.when}` : ""}: ${r.text ?? ""}`,
        ),
      ];
      return lines.filter(Boolean).join("\n");
    },
  };

  /** One context line naming the user's lists, so the model knows they exist. */
  const contextLine = async (): Promise<string | undefined> => {
    const lists = await listPlaceLists(tenantId);
    if (lists.length === 0) return undefined;
    return (
      `Place lists the user has in Sezar (get_place_lists to read; Google's own lists can't be edited — give Google Maps links to save there): ` +
      lists
        .slice(0, 8)
        .map((l) => `[${l.id}] "${l.name}" ${l.count} places${l.source ? " (from Google Maps)" : ""}`)
        .join("; ") +
      "."
    );
  };

  return {
    tools: [importTool, getListsTool, updateListTool, placeDetailsTool],
    contextLine,
  };
}
