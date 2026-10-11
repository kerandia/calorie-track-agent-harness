import assert from "node:assert/strict";
import test from "node:test";
import { formatDistance, formatDuration, travelTimes } from "../.flue/lib/routes.js";
import { airQuality, formatAirQuality, formatDay, formatHour } from "../.flue/lib/weather.js";

test("travel times keep each destination's slot and mark unreachable ones", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  let body: Record<string, unknown> = {};
  let mask: string | null = null;
  const fake = (async (_input: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    mask = new Headers(init?.headers).get("x-goog-fieldmask");
    // Elements stream back in any order.
    return Response.json([
      { destinationIndex: 1, condition: "ROUTE_NOT_FOUND" },
      { destinationIndex: 0, condition: "ROUTE_EXISTS", duration: "1037s", distanceMeters: 1234 },
    ]);
  }) as typeof fetch;

  const future = new Date(Date.now() + 3_600_000).toISOString();
  const times = await travelTimes(
    { name: "Hotel", lat: 38.71, lon: -9.13 },
    [{ name: "Tasca", lat: 38.7, lon: -9.14 }, { name: "Island", address: "Somewhere offshore" }],
    "transit",
    future,
    fake,
  );
  assert.deepEqual(body.origins, [{ waypoint: { location: { latLng: { latitude: 38.71, longitude: -9.13 } } } }]);
  assert.deepEqual((body.destinations as unknown[])[1], { waypoint: { address: "Somewhere offshore" } });
  assert.equal(body.travelMode, "TRANSIT");
  assert.equal(body.departureTime, future);
  assert.equal(mask, "destinationIndex,duration,distanceMeters,condition");
  assert.deepEqual(times, [
    { name: "Tasca", reachable: true, seconds: 1037, meters: 1234 },
    { name: "Island", reachable: false },
  ]);

  await travelTimes({ lat: 1, lon: 2 }, [{ lat: 1, lon: 3 }], "drive", future, fake);
  assert.equal(body.departureTime, undefined); // live-traffic driving is the Pro SKU
  delete process.env.GOOGLE_MAPS_API_KEY;
});

test("durations and distances read naturally", () => {
  assert.equal(formatDuration(1037), "17 min");
  assert.equal(formatDuration(5856), "1 h 38 min");
  assert.equal(formatDuration(3600), "1 h");
  assert.equal(formatDistance(1234), "1.2 km");
  assert.equal(formatDistance(87), "90 m");
});

test("forecast hours and days compress to one line each, in local time", () => {
  assert.equal(
    formatHour({
      displayDateTime: { year: 2026, month: 10, day: 11, hours: 9, minutes: 0 },
      weatherCondition: { description: { text: "Cloudy" } },
      temperature: { degrees: 18.3 },
      feelsLikeTemperature: { degrees: 18 },
      precipitation: { probability: { percent: 10 } },
      wind: { speed: { value: 11 } },
      uvIndex: 0,
    }),
    "Sun 09:00 Cloudy 18°C (feels 18°C) rain 10% wind 11 km/h UV 0",
  );
  assert.equal(
    formatDay(
      {
        displayDate: { year: 2026, month: 10, day: 12 },
        daytimeForecast: { weatherCondition: { description: { text: "Sunny" } }, precipitation: { probability: { percent: 10 } } },
        nighttimeForecast: { weatherCondition: { description: { text: "Clear" } } },
        minTemperature: { degrees: 3.2 },
        maxTemperature: { degrees: 14.4 },
        sunEvents: { sunriseTime: "2026-10-12T05:26:00Z", sunsetTime: "2026-10-12T16:18:00Z" },
      },
      "Europe/Berlin",
    ),
    "Mon 12/10: Sunny (rain 10%), night Clear, 3–14°C, sun 07:26–18:18",
  );
});

test("air quality reports the worst coming hour and says higher is better", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  const fake = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("currentConditions")) {
      return Response.json({
        indexes: [{ code: "uaqi", aqi: 79, category: "Good air quality", dominantPollutant: "o3" }],
        healthRecommendations: { generalPopulation: "Enjoy the outdoors!", athletes: "Fine to train." },
      });
    }
    return Response.json({
      hourlyForecasts: [
        { dateTime: "2026-10-11T10:00:00Z", indexes: [{ code: "uaqi", aqi: 78, category: "Good air quality" }] },
        { dateTime: "2026-10-11T11:00:00Z", indexes: [{ code: "uaqi", aqi: 41, category: "Moderate air quality" }] },
      ],
    });
  }) as typeof fetch;

  const a = await airQuality(52.52, 13.4, 6, fake);
  assert.deepEqual(a.forecast, { minAqi: 41, maxAqi: 78, worstAt: "2026-10-11T11:00:00Z", worstCategory: "Moderate air quality" });
  const text = formatAirQuality(a, "Europe/Berlin");
  assert.match(text, /79 on Google's Universal AQI \(0–100, higher is better\)/);
  assert.match(text, /worst around 13:00 \(Moderate air quality\)/);
  assert.match(text, /For exercise: Fine to train\./);
  delete process.env.GOOGLE_MAPS_API_KEY;
});
