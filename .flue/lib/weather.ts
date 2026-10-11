import { googleMapsKey } from "./googleMaps.js";

// Outdoor conditions: Weather API (hourly ≤24h, daily ≤10 days) and Air
// Quality API (now + hourly forecast). Both 10,000 calls free a month.
//
// Air quality uses Google's Universal AQI, where HIGHER IS BETTER (100 =
// excellent, 0 = poor) — the opposite of the US AQI people know, so every
// line we hand the model says so.

type Fetch = typeof fetch;

const WEATHER = "https://weather.googleapis.com/v1";
const AIR = "https://airquality.googleapis.com/v1";

type DisplayDateTime = { year: number; month: number; day: number; hours?: number; minutes?: number };
type Temp = { degrees?: number };

type RawHour = {
  displayDateTime?: DisplayDateTime;
  weatherCondition?: { description?: { text?: string } };
  temperature?: Temp;
  feelsLikeTemperature?: Temp;
  precipitation?: { probability?: { percent?: number } };
  wind?: { speed?: { value?: number } };
  uvIndex?: number;
};

type RawDay = {
  displayDate?: { year: number; month: number; day: number };
  daytimeForecast?: {
    weatherCondition?: { description?: { text?: string } };
    precipitation?: { probability?: { percent?: number } };
  };
  nighttimeForecast?: { weatherCondition?: { description?: { text?: string } } };
  maxTemperature?: Temp;
  minTemperature?: Temp;
  sunEvents?: { sunriseTime?: string; sunsetTime?: string };
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const weekday = (d: { year: number; month: number; day: number }): string =>
  WEEKDAYS[new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay()]!;
const pad = (n: number | undefined): string => String(n ?? 0).padStart(2, "0");
const deg = (t: Temp | undefined): string => (t?.degrees === undefined ? "?" : `${Math.round(t.degrees)}°C`);

/** "Sun 09:00 Cloudy 18°C (feels 18°C) rain 10% wind 11 km/h UV 0" */
export function formatHour(h: RawHour): string {
  const d = h.displayDateTime;
  const when = d ? `${weekday(d)} ${pad(d.hours)}:${pad(d.minutes)}` : "?";
  const parts = [
    when,
    h.weatherCondition?.description?.text ?? "",
    `${deg(h.temperature)} (feels ${deg(h.feelsLikeTemperature)})`,
    `rain ${h.precipitation?.probability?.percent ?? 0}%`,
    h.wind?.speed?.value !== undefined ? `wind ${Math.round(h.wind.speed.value)} km/h` : "",
    h.uvIndex !== undefined ? `UV ${h.uvIndex}` : "",
  ];
  return parts.filter(Boolean).join(" ");
}

const localClock = (iso: string | undefined, timeZone: string | undefined): string | undefined => {
  if (!iso) return undefined;
  try {
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, ...(timeZone ? { timeZone } : {}) }).format(new Date(iso));
  } catch {
    return undefined;
  }
};

/** "Sun 11 Oct: Light rain (rain 25%), night Cloudy, 7–13°C, sun 07:24–18:20" */
export function formatDay(d: RawDay, timeZone?: string): string {
  const date = d.displayDate;
  const head = date ? `${weekday(date)} ${date.day}/${date.month}` : "?";
  const sunrise = localClock(d.sunEvents?.sunriseTime, timeZone);
  const sunset = localClock(d.sunEvents?.sunsetTime, timeZone);
  return [
    `${head}: ${d.daytimeForecast?.weatherCondition?.description?.text ?? "?"} (rain ${d.daytimeForecast?.precipitation?.probability?.percent ?? 0}%)`,
    d.nighttimeForecast?.weatherCondition?.description?.text ? `night ${d.nighttimeForecast.weatherCondition.description.text}` : "",
    `${deg(d.minTemperature).replace("°C", "")}–${deg(d.maxTemperature)}`,
    sunrise && sunset ? `sun ${sunrise}–${sunset}` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

const get = async <T>(url: string, fetchImpl: Fetch): Promise<T> => {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Weather failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
};

export async function weatherForecast(
  lat: number,
  lon: number,
  opts: { hours?: number; days?: number },
  fetchImpl: Fetch = fetch,
): Promise<{ timeZone?: string; hours: string[]; days: string[] }> {
  const where = `key=${encodeURIComponent(googleMapsKey())}&location.latitude=${lat}&location.longitude=${lon}`;
  const hours = Math.min(Math.max(Math.round(opts.hours ?? 0), 0), 24);
  const days = Math.min(Math.max(Math.round(opts.days ?? 0), 0), 10);
  const [h, d] = await Promise.all([
    hours
      ? get<{ forecastHours?: RawHour[]; timeZone?: { id?: string } }>(
          `${WEATHER}/forecast/hours:lookup?${where}&hours=${hours}&pageSize=${hours}`,
          fetchImpl,
        )
      : undefined,
    days
      ? get<{ forecastDays?: RawDay[]; timeZone?: { id?: string } }>(
          `${WEATHER}/forecast/days:lookup?${where}&days=${days}&pageSize=${days}`,
          fetchImpl,
        )
      : undefined,
  ]);
  const timeZone = h?.timeZone?.id ?? d?.timeZone?.id;
  return {
    ...(timeZone ? { timeZone } : {}),
    hours: (h?.forecastHours ?? []).map(formatHour),
    days: (d?.forecastDays ?? []).map((day) => formatDay(day, timeZone)),
  };
}

type AqIndex = { code?: string; aqi?: number; category?: string; dominantPollutant?: string };

const universal = (indexes: AqIndex[] | undefined): AqIndex | undefined =>
  indexes?.find((i) => i.code === "uaqi") ?? indexes?.[0];

export type AirQuality = {
  aqi?: number;
  category?: string;
  dominant?: string;
  general?: string;
  athletes?: string;
  /** Worst hour over the forecast window (lowest Universal AQI). */
  forecast?: { minAqi: number; maxAqi: number; worstAt: string; worstCategory?: string };
};

export async function airQuality(
  lat: number,
  lon: number,
  hours: number,
  fetchImpl: Fetch = fetch,
): Promise<AirQuality> {
  const key = encodeURIComponent(googleMapsKey());
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const res = await fetchImpl(`${AIR}/${path}?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Air quality failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  };
  const location = { latitude: lat, longitude: lon };

  const window = Math.min(Math.max(Math.round(hours), 0), 24);
  const start = new Date(Date.now() + 60 * 60 * 1000);
  start.setUTCMinutes(0, 0, 0);
  const end = new Date(start.getTime() + Math.max(window - 1, 0) * 60 * 60 * 1000);

  const [now, fc] = await Promise.all([
    post<{ indexes?: AqIndex[]; healthRecommendations?: { generalPopulation?: string; athletes?: string } }>(
      "currentConditions:lookup",
      { location, extraComputations: ["HEALTH_RECOMMENDATIONS"], languageCode: "en" },
    ),
    window > 1
      ? post<{ hourlyForecasts?: { dateTime?: string; indexes?: AqIndex[] }[] }>("forecast:lookup", {
          location,
          period: { startTime: start.toISOString(), endTime: end.toISOString() },
          universalAqi: true,
          languageCode: "en",
          pageSize: window,
        })
      : undefined,
  ]);

  const idx = universal(now.indexes);
  const result: AirQuality = {
    ...(idx?.aqi !== undefined ? { aqi: idx.aqi } : {}),
    ...(idx?.category ? { category: idx.category } : {}),
    ...(idx?.dominantPollutant ? { dominant: idx.dominantPollutant } : {}),
    ...(now.healthRecommendations?.generalPopulation ? { general: now.healthRecommendations.generalPopulation } : {}),
    ...(now.healthRecommendations?.athletes ? { athletes: now.healthRecommendations.athletes } : {}),
  };
  const hoursAqi = (fc?.hourlyForecasts ?? [])
    .map((h) => ({ at: h.dateTime, idx: universal(h.indexes) }))
    .filter((h): h is { at: string; idx: AqIndex & { aqi: number } } => Boolean(h.at && h.idx?.aqi !== undefined));
  if (hoursAqi.length) {
    const worst = hoursAqi.reduce((a, b) => (b.idx.aqi < a.idx.aqi ? b : a));
    result.forecast = {
      minAqi: Math.min(...hoursAqi.map((h) => h.idx.aqi)),
      maxAqi: Math.max(...hoursAqi.map((h) => h.idx.aqi)),
      worstAt: worst.at,
      ...(worst.idx.category ? { worstCategory: worst.idx.category } : {}),
    };
  }
  return result;
}

export function formatAirQuality(a: AirQuality, timeZone?: string): string {
  if (a.aqi === undefined) return "Air quality: no data for this spot.";
  const lines = [
    `Air quality now: ${a.aqi} on Google's Universal AQI (0–100, higher is better) — ${a.category ?? "?"}${a.dominant ? `, mostly ${a.dominant}` : ""}.`,
  ];
  if (a.forecast) {
    lines.push(
      `Next hours: ${a.forecast.minAqi}–${a.forecast.maxAqi}; worst around ${localClock(a.forecast.worstAt, timeZone) ?? a.forecast.worstAt}${a.forecast.worstCategory ? ` (${a.forecast.worstCategory})` : ""}.`,
    );
  }
  if (a.general) lines.push(`Advice: ${a.general}`);
  if (a.athletes) lines.push(`For exercise: ${a.athletes}`);
  return lines.join("\n");
}
