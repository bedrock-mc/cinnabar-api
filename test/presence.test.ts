import { evictDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { admitLookup } from "../src/hub";
import { hub, installFakeIssuer, login, postRelease, type Client } from "./helpers";

const open: Client[] = [];
async function player(o: Parameters<typeof login>[0] = {}) {
  const session = await login(o);
  open.push(session.client);
  return session;
}

beforeAll(installFakeIssuer);
afterEach(() => Promise.all(open.splice(0).map((c) => (c.close(), c.closed))));

const ALEX = "2535400000000101";
const STEVE = "2535400000000102";
const NOBODY = "2535400000000199";

describe("visibility and lookup", () => {
  it("returns the connected, visible subset in request order without duplicates", async () => {
    const { client: me } = await player({ xuid: "2535400000000100" });
    await player({ xuid: ALEX });
    await player({ xuid: STEVE, visible: false });
    const result = await me.lookup([NOBODY, ALEX, STEVE, ALEX], 7);
    expect(result).toEqual({ type: "lookup_result", id: 7, cinnabar: [ALEX] });
  });

  it("follows visibility changes", async () => {
    const { client: me } = await player();
    const { client: alex } = await player({ xuid: ALEX });
    alex.send({ type: "visibility", visible: false });
    expect((await me.lookup([ALEX])).cinnabar).toEqual([]);
    alex.send({ type: "visibility", visible: true });
    expect((await me.lookup([ALEX])).cinnabar).toEqual([ALEX]);
  });

  it("shows a player with several connections while any of them is visible", async () => {
    const { client: me } = await player();
    const { client: hidden } = await player({ xuid: ALEX, visible: false });
    const { client: shown } = await player({ xuid: ALEX, visible: true });
    expect((await me.lookup([ALEX])).cinnabar).toEqual([ALEX]);
    shown.close();
    await shown.closed;
    expect((await me.lookup([ALEX])).cinnabar).toEqual([]);
    hidden.send({ type: "visibility", visible: true });
    expect((await me.lookup([ALEX])).cinnabar).toEqual([ALEX]);
  });

  it("drops a player once their last connection closes", async () => {
    const { client: me } = await player();
    const { client: alex } = await player({ xuid: ALEX });
    expect((await me.lookup([ALEX])).cinnabar).toEqual([ALEX]);
    alex.close();
    await alex.closed;
    expect((await me.lookup([ALEX])).cinnabar).toEqual([]);
  });

  it("keeps presence across hibernation", async () => {
    const { client: me } = await player();
    await player({ xuid: ALEX });
    await player({ xuid: STEVE, visible: false });
    await evictDurableObject(hub());
    expect((await me.lookup([ALEX, STEVE])).cinnabar).toEqual([ALEX]);
  });
});

describe("lookup limits", () => {
  it("accepts 128 XUIDs and closes with 1008 on 129", async () => {
    const { client } = await player();
    const xuids = Array.from({ length: 128 }, (_, i) => String(1000 + i));
    expect((await client.lookup(xuids)).cinnabar).toEqual([]);
    client.send({ type: "lookup", id: 2, xuids: [...xuids, "9"] });
    expect((await client.closed).code).toBe(1008);
  });

  it.each([
    ["an empty XUID", { id: 1, xuids: [""] }],
    ["a 21-digit XUID", { id: 1, xuids: ["1".repeat(21)] }],
    ["a non-digit XUID", { id: 1, xuids: ["12a"] }],
    ["a negative id", { id: -1, xuids: [] }],
    ["an id over u32", { id: 2 ** 32, xuids: [] }],
    ["a fractional id", { id: 1.5, xuids: [] }],
  ])("closes with 1008 on %s", async (_, body) => {
    const { client } = await player();
    client.send({ type: "lookup", ...body });
    expect((await client.closed).code).toBe(1008);
  });

  it("allows 20 lookups per connection, then answers rate_limited with the lookup id", async () => {
    const { client } = await player();
    for (let id = 0; id < 20; id++) expect((await client.lookup([], id)).type).toBe("lookup_result");
    expect(await client.lookup([], 4294967295)).toEqual({ type: "error", code: "rate_limited", id: 4294967295 });
    const { client: other } = await player();
    expect((await other.lookup([])).type).toBe("lookup_result");
  });

  it("rolls the window: a lookup is admitted again a minute after the oldest", () => {
    let lookups: number[] = [];
    for (let i = 0; i < 20; i++) lookups = admitLookup(lookups, 1_000 + i * 100).lookups;
    expect(admitLookup(lookups, 60_999).admitted).toBe(false);
    const next = admitLookup(lookups, 61_000);
    expect(next.admitted).toBe(true);
    expect(next.lookups).toHaveLength(20);
    expect(admitLookup(next.lookups, 61_050).admitted).toBe(false);
  });
});

describe("release push", () => {
  it("broadcasts a release only to its channel", async () => {
    const { client: beta } = await player({ channel: "beta" });
    const { client: stable } = await player({ channel: "stable" });
    expect((await postRelease({ channel: "beta", version: "0.1.19" })).status).toBe(204);
    expect(await beta.next()).toMatchObject({ type: "release", channel: "beta", version: "0.1.19" });
    expect((await stable.lookup([])).type).toBe("lookup_result");
  });

  it("sends a catch-up release after welcome only when the recorded one is newer", async () => {
    await postRelease({ channel: "nightly", version: "0.2.0-nightly.2" });
    const { client: old } = await player({ channel: "nightly", clientVersion: "0.2.0-nightly.1" });
    expect(await old.next()).toMatchObject({ type: "release", channel: "nightly", version: "0.2.0-nightly.2" });
    const { client: current } = await player({ channel: "nightly", clientVersion: "0.2.0-nightly.2" });
    expect((await current.lookup([])).type).toBe("lookup_result");
    const { client: ahead } = await player({ channel: "nightly", clientVersion: "0.2.0" });
    expect((await ahead.lookup([])).type).toBe("lookup_result");
  });
});
