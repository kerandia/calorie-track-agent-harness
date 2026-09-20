import assert from "node:assert/strict";
import test from "node:test";
import {
  deleteArtifactRecord,
  getArtifact,
  listArtifacts,
  recordArtifact,
  touchArtifact,
} from "../.flue/lib/redis.js";

function artifactStore() {
  const hashes = new Map<string, Record<string, string>>();
  const sortedSets = new Map<string, string[]>();

  const hset = async (
    key: string,
    fields: Record<string, string | number>,
  ) => {
    const current = hashes.get(key) ?? {};
    hashes.set(
      key,
      Object.fromEntries(
        Object.entries({ ...current, ...fields }).map(([name, value]) => [
          name,
          String(value),
        ]),
      ),
    );
    return Object.keys(fields).length;
  };

  const hgetall = async <T>(key: string): Promise<T | null> =>
    (hashes.get(key) as T | undefined) ?? null;

  const zadd = async (
    key: string,
    entry: { member: string },
  ) => {
    const members = sortedSets.get(key) ?? [];
    sortedSets.set(key, [...members.filter((item) => item !== entry.member), entry.member]);
    return 1;
  };

  const del = async (key: string) => {
    hashes.delete(key);
    return 1;
  };

  const zrem = async (key: string, member: string) => {
    sortedSets.set(
      key,
      (sortedSets.get(key) ?? []).filter((item) => item !== member),
    );
    return 1;
  };

  return {
    hset,
    hgetall,
    async zrange(
      key: string,
      start: number,
      end: number,
      options?: { rev?: boolean },
    ) {
      const members = [...(sortedSets.get(key) ?? [])];
      if (options?.rev) members.reverse();
      return members.slice(start, end + 1);
    },
    pipeline() {
      const operations: Array<() => Promise<unknown>> = [];
      const pipe = {
        hset(key: string, fields: Record<string, string | number>) {
          operations.push(() => hset(key, fields));
          return pipe;
        },
        hgetall(key: string) {
          operations.push(() => hgetall(key));
          return pipe;
        },
        zadd(key: string, entry: { member: string }) {
          operations.push(() => zadd(key, entry));
          return pipe;
        },
        del(key: string) {
          operations.push(() => del(key));
          return pipe;
        },
        zrem(key: string, member: string) {
          operations.push(() => zrem(key, member));
          return pipe;
        },
        async exec<T>() {
          return (await Promise.all(operations.map((operation) => operation()))) as T;
        },
      };
      return pipe;
    },
  };
}

test("artifact history is paginated and isolated by tenant", async () => {
  const db = artifactStore();
  const records = [];
  for (let i = 0; i < 25; i += 1) {
    records.push(
      await recordArtifact(
        "tenant-a",
        {
          kind: "page",
          title: `Page ${i}`,
          url: `https://example.test/${i}`,
          external_id: `p/tenant-a/${i}.html`,
        },
        db as never,
      ),
    );
  }

  const firstPage = await listArtifacts("tenant-a", 20, 0, db as never);
  const secondPage = await listArtifacts("tenant-a", 20, 20, db as never);

  assert.equal(firstPage.length, 20);
  assert.equal(secondPage.length, 5);
  assert.equal(new Set([...firstPage, ...secondPage].map((item) => item.id)).size, 25);
  assert.equal(await getArtifact("tenant-b", records[0]!.id, db as never), null);
});

test("artifact updates and deletion remain inside the owning tenant", async () => {
  const db = artifactStore();
  const record = await recordArtifact(
    "tenant-a",
    {
      kind: "map",
      title: "Original",
      url: "https://example.test/map",
      external_id: "map-1",
      version: 1,
    },
    db as never,
  );

  await touchArtifact(
    "tenant-a",
    record.id,
    { title: "Updated", version: 2 },
    db as never,
  );
  assert.deepEqual(
    {
      title: (await getArtifact("tenant-a", record.id, db as never))?.title,
      version: (await getArtifact("tenant-a", record.id, db as never))?.version,
    },
    { title: "Updated", version: 2 },
  );

  await deleteArtifactRecord("tenant-a", record.id, db as never);
  assert.equal(await getArtifact("tenant-a", record.id, db as never), null);
});
