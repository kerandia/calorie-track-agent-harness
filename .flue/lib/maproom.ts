// MapToAgent ("maproom") — hosted interactive maps for agents.
// Plain HTTPS, no SDK. Contract verified live against https://maptoagent.xyz/docs:
//   POST   /v1/artifacts            → 201 {id, url, version, warnings[]}
//   GET    /v1/artifacts/{id}       → canonical {type, title, description, data, version, url}
//   PATCH  /v1/artifacts/{id}       → wholesale replacement; needs If-Match: "<version>";
//                                     409 = stale (GET again, retry), 428 = header missing
//   DELETE /v1/artifacts/{id}       → 204
// One service-level API key (MAPROOM_API_KEY, registered as "sezar-agent"); which
// user owns which map is our own registry in Redis (see recordArtifact).

const BASE = "https://maptoagent.xyz";

export type ReachMode = "walk" | "bicycle" | "drive";

export type MapPlace = {
  name: string;
  lat?: number;
  lon?: number;
  address?: string;
  note?: string;
  group?: string;
  tags?: string[];
  url?: string;
  /** YYYY-MM-DD */
  date?: string;
  reach?: { mode: ReachMode; minutes: number | number[] };
};

export type MapSpec = {
  title: string;
  description?: string;
  places: MapPlace[];
  /** Draw the path between places of each group (use with group = "Day 1" etc). */
  route?: boolean;
  theme?: "light" | "dark";
};

export type MapWarning = { place?: string; issue: string };

export type PublishedMap = {
  id: string;
  url: string;
  version: number;
  warnings: MapWarning[];
};

export class MaproomError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
  }
}

export const maproomConfigured = (): boolean => !!process.env.MAPROOM_API_KEY;

const key = (): string => {
  const k = process.env.MAPROOM_API_KEY;
  if (!k) throw new MaproomError(0, "MAPROOM_API_KEY not set");
  return k;
};

const toBody = (spec: MapSpec) => ({
  type: "map",
  title: spec.title,
  ...(spec.description ? { description: spec.description } : {}),
  data: {
    ...(spec.route !== undefined ? { route: spec.route } : {}),
    ...(spec.theme ? { theme: spec.theme } : {}),
    places: spec.places,
  },
});

async function call<T>(
  method: string,
  path: string,
  init: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; data: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key()}`,
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(45_000),
  });
  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const err = (data as { error?: unknown } | undefined)?.error;
    const detail =
      typeof err === "string" ? err : err ? JSON.stringify(err) : text.slice(0, 300);
    throw new MaproomError(res.status, `maproom ${method} ${path} → ${res.status}: ${detail}`, data);
  }
  return { status: res.status, data: data as T };
}

export async function publishMap(spec: MapSpec): Promise<PublishedMap> {
  const { data } = await call<PublishedMap>("POST", "/v1/artifacts", {
    body: toBody(spec),
  });
  return { ...data, warnings: data.warnings ?? [] };
}

export type CanonicalMap = {
  id: string;
  type: "map";
  title: string;
  description?: string;
  data: { places: MapPlace[]; route?: boolean; theme?: "light" | "dark" };
  version: number;
  url: string;
};

export async function getMap(id: string): Promise<CanonicalMap> {
  const { data } = await call<CanonicalMap>("GET", `/v1/artifacts/${encodeURIComponent(id)}`);
  return data;
}

/**
 * Replace exactly the version the caller read. Never retry stale content with
 * a newer version: that silently discards concurrent edits.
 */
export async function updateMap(id: string, spec: MapSpec, expectedVersion: number): Promise<PublishedMap> {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new Error("Read the map before updating it");
      const { data } = await call<PublishedMap>(
        "PATCH",
        `/v1/artifacts/${encodeURIComponent(id)}`,
        {
          body: toBody(spec),
          headers: { "If-Match": `"${expectedVersion}"` },
        },
      );
      return { ...data, warnings: data.warnings ?? [] };
}

export async function deleteMap(id: string): Promise<void> {
  await call<unknown>("DELETE", `/v1/artifacts/${encodeURIComponent(id)}`);
}

/** Human-readable warnings line for the model / user, or "" when clean. */
export function describeWarnings(warnings: MapWarning[]): string {
  if (warnings.length === 0) return "";
  const labels: Record<string, string> = {
    geocode_failed: "couldn't be located — listed without a pin",
    geocode_low_confidence: "pin might be slightly off",
    reach_failed: "reach area couldn't be computed",
  };
  return warnings
    .map((w) => `${w.place ? `"${w.place}"` : "a place"}: ${labels[w.issue] ?? w.issue}`)
    .join("; ");
}
