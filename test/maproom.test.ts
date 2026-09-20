import assert from "node:assert/strict";
import test from "node:test";
import {
  describeWarnings,
  updateMap,
  type MapSpec,
} from "../.flue/lib/maproom.js";

const spec: MapSpec = {
  title: "Lisbon",
  places: [{ name: "Hotel", lat: 38.72, lon: -9.14 }],
  route: true,
};

test("map updates send the exact version as If-Match", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.MAPROOM_API_KEY;
  let request:
    | { url: string; init: RequestInit }
    | undefined;
  process.env.MAPROOM_API_KEY = "test-key";
  globalThis.fetch = (async (input, init) => {
    request = { url: String(input), init: init ?? {} };
    return new Response(
      JSON.stringify({
        id: "map-1",
        url: "https://map.example/map-1",
        version: 8,
        warnings: [],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const result = await updateMap("map-1", spec, 7);
    const headers = request?.init.headers as Record<string, string>;
    const body = JSON.parse(String(request?.init.body));

    assert.equal(request?.url, "https://maptoagent.xyz/v1/artifacts/map-1");
    assert.equal(request?.init.method, "PATCH");
    assert.equal(headers["If-Match"], '"7"');
    assert.equal(body.title, "Lisbon");
    assert.deepEqual(body.data.places, spec.places);
    assert.equal(result.version, 8);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.MAPROOM_API_KEY;
    else process.env.MAPROOM_API_KEY = originalKey;
  }
});

test("map updates reject missing versions before making a request", async () => {
  await assert.rejects(updateMap("map-1", spec, 0), /Read the map before updating it/);
});

test("map warnings are made useful without hiding failed pins", () => {
  assert.equal(
    describeWarnings([{ place: "Cafe", issue: "geocode_low_confidence" }]),
    '"Cafe": pin might be slightly off',
  );
});
