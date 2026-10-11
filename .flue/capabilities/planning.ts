import type { ToolDef } from "@flue/runtime";
import { Type } from "@flue/runtime";
import { googleMapsConfigured } from "../lib/googleMaps.js";
import { formatDistance, formatDuration, MAX_DESTINATIONS, travelTimes, type TravelMode } from "../lib/routes.js";
import { airQuality, formatAirQuality, weatherForecast } from "../lib/weather.js";

export function createPlanningCapability() {
  // ── Getting there and what it's like outside (Routes, Weather, Air Quality) ──

  const OFF = "switched off (no Google Maps API key configured)";

  const place = Type.Object({
    name: Type.Optional(Type.String()),
    lat: Type.Optional(Type.Number()),
    lon: Type.Optional(Type.Number()),
    address: Type.Optional(Type.String({ description: "Used when lat/lon aren't known." })),
  });

  const travelTimesTool: ToolDef = {
    name: "travel_times",
    description:
      `Real travel times from one place to up to ${MAX_DESTINATIONS} others, sorted fastest first. Use it instead of guessing distances: picking the closest of several options, checking a plan fits ("can we do Belém before an 8pm dinner?"), ordering stops. Pass coordinates when you have them (web_search and place lists give them), otherwise an address. Driving times are typical, not live traffic.`,
    parameters: Type.Object({
      origin: place,
      destinations: Type.Array(place),
      mode: Type.Optional(
        Type.Union([Type.Literal("walk"), Type.Literal("transit"), Type.Literal("drive"), Type.Literal("bicycle")], {
          description: "Default walk.",
        }),
      ),
      depart_at: Type.Optional(Type.String({ description: "ISO time, transit only — e.g. tonight's departure." })),
    }),
    execute: async (args) => {
      if (!googleMapsConfigured()) return `Travel times are ${OFF}. Estimate and say it's rough.`;
      const mode = (args.mode ?? "walk") as TravelMode;
      const times = await travelTimes(args.origin, args.destinations, mode, args.depart_at);
      const label = { walk: "walk", transit: "by transit", drive: "drive", bicycle: "by bike" }[mode];
      const from = args.origin.name ?? args.origin.address ?? "the start";
      return [
        `From ${from}, ${label}:`,
        ...times
          .slice()
          .sort((a, b) => (a.seconds ?? Infinity) - (b.seconds ?? Infinity))
          .map((t) =>
            t.reachable && t.seconds !== undefined
              ? `- ${t.name}: ${formatDuration(t.seconds)}${t.meters !== undefined ? ` (${formatDistance(t.meters)})` : ""}`
              : `- ${t.name}: no ${mode} route found`,
          ),
        args.destinations.length > MAX_DESTINATIONS ? `(only the first ${MAX_DESTINATIONS} were checked)` : "",
      ]
        .filter(Boolean)
        .join("\n");
    },
  };

  const conditionsTool: ToolDef = {
    name: "outdoor_conditions",
    description:
      "Weather and air quality for a spot: hourly forecast (up to 24 h — rain chance, temperature, feels-like, wind, UV), daily forecast (up to 10 days, sunrise/sunset) and air quality now plus the coming hours, with health advice for exercise. Use it when a plan depends on being outside — terrace or indoor dinner, a walking day, an outdoor run or workout, packing — and say how it changed your suggestion. Times are local to the spot.",
    parameters: Type.Object({
      lat: Type.Number(),
      lon: Type.Number(),
      hours: Type.Optional(Type.Number({ description: "Hourly forecast window, default 12, max 24." })),
      days: Type.Optional(Type.Number({ description: "Daily forecast for trips or the weekend, max 10. Default 0." })),
      air_quality: Type.Optional(Type.Boolean({ description: "Default true; most relevant for exercise and sensitive users." })),
    }),
    execute: async (args) => {
      if (!googleMapsConfigured()) return `Weather and air quality are ${OFF}. Say you can't check the forecast.`;
      const hours = args.hours ?? 12;
      const [weather, air] = await Promise.all([
        weatherForecast(args.lat, args.lon, { hours, days: args.days ?? 0 }),
        args.air_quality === false ? undefined : airQuality(args.lat, args.lon, hours).catch(() => undefined),
      ]);
      return [
        weather.hours.length ? `Hourly (${weather.timeZone ?? "local time"}):\n${weather.hours.join("\n")}` : "",
        weather.days.length ? `Daily:\n${weather.days.join("\n")}` : "",
        air ? formatAirQuality(air, weather.timeZone) : "",
      ]
        .filter(Boolean)
        .join("\n\n");
    },
  };

  return { tools: [travelTimesTool, conditionsTool] };
}
