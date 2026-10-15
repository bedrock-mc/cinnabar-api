import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hub, installFakeIssuer, login, postRelease, type Client } from "./helpers";

const open: Client[] = [];
beforeAll(installFakeIssuer);
beforeEach(async () => {
  await runInDurableObject(hub(), (_, state) => state.storage.deleteAll());
  await evictDurableObject(hub());
});
afterEach(() => Promise.all(open.splice(0).map((c) => (c.close(), c.closed))));

/** Logs in and retains the client for cleanup. */
async function player(options: Parameters<typeof login>[0] = {}) {
  const session = await login(options);
  open.push(session.client);
  return session;
}

describe("release identities", () => {
  it("persists and broadcasts the build from the release hook", async () => {
    const { client } = await player({ channel: "nightly" });
    expect((await postRelease({ channel: "nightly", version: "0.2.0", build: 42 })).status).toBe(204);
    expect(await client.next()).toMatchObject({ type: "release", version: "0.2.0", build: 42 });
    expect(await hub().latestRelease("nightly")).toMatchObject({ version: "0.2.0", build: 42 });
  });

  it("makes duplicate and older hooks no-ops and broadcasts only newer version/build pairs", async () => {
    const { client } = await player();
    const release = { channel: "beta", version: "0.2.0", build: 42 };
    await postRelease(release);
    await client.next();
    const first = await hub().latestRelease("beta");
    for (const body of [release, { ...release, build: 41 }, { ...release, version: "0.1.99", build: 999 }]) {
      expect((await postRelease(body)).status).toBe(204);
      expect((await client.lookup([])).type).toBe("lookup_result");
      expect(await hub().latestRelease("beta")).toEqual(first);
    }
    for (const body of [{ ...release, build: 43 }, { ...release, version: "0.2.1", build: 1 }]) {
      await postRelease(body);
      expect(await client.next()).toMatchObject({ type: "release", ...body });
    }
  });

  it("keeps the newest release under concurrent hooks", async () => {
    await Promise.all([43, 41, 42, 43].map((build) => postRelease({ channel: "nightly", version: "0.2.0", build })));
    expect(await hub().latestRelease("nightly")).toMatchObject({ version: "0.2.0", build: 43 });
  });

  it("catches up a nightly with the same version and an older build", async () => {
    await postRelease({ channel: "nightly", version: "0.2.0", build: 42 });
    const { client: old } = await player({ channel: "nightly", clientVersion: "0.2.0", clientBuild: 41 });
    expect(await old.next()).toMatchObject({ type: "release", build: 42 });
    for (const clientBuild of [42, 43]) {
      const { client } = await player({ channel: "nightly", clientVersion: "0.2.0", clientBuild });
      expect((await client.lookup([])).type).toBe("lookup_result");
    }
  });

  it("treats omitted builds as zero for older v1 senders", async () => {
    await postRelease({ channel: "nightly", version: "0.2.0", build: 42 });
    const { client } = await player({ channel: "nightly", clientVersion: "0.2.0" });
    expect(await client.next()).toMatchObject({ type: "release", build: 42 });
  });
});
