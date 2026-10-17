import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Hub } from "../src/hub";
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
    expect((await me.lookup([ALEX])).cinnabar).toEqual([ALEX]);
    hidden.send({ type: "visibility", visible: true });
    expect((await me.lookup([ALEX])).cinnabar).toEqual([ALEX]);
  });

  it("lingers for thirty minutes after the last connection closes", async () => {
    const { client: me } = await player();
    const { client: alex } = await player({ xuid: ALEX });
    expect((await me.lookup([ALEX])).cinnabar).toEqual([ALEX]);
    alex.close();
    await alex.closed;
    expect((await me.lookup([ALEX])).cinnabar).toEqual([ALEX]);
    await runInDurableObject(hub(), async (instance: Hub, state) => {
      const ws = state.getWebSockets().find((ws) => ws.deserializeAttachment()?.stage === "ready")!;
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 30 * 60_000 + 1);
      try {
        await instance.webSocketMessage(ws, JSON.stringify({ type: "lookup", id: 8, xuids: [ALEX] }));
      } finally {
        clock.mockRestore();
      }
    });
    expect(await me.next()).toEqual({ type: "lookup_result", id: 8, cinnabar: [] });
  });

  it("clears retained presence when an account reconnects with visibility off", async () => {
    const { client: me } = await player();
    const { client: alex } = await player({ xuid: "2535400000000999" });
    alex.close();
    await alex.closed;
    expect((await me.lookup(["2535400000000999"])).cinnabar).toEqual(["2535400000000999"]);
    await player({ xuid: "2535400000000999", visible: false });
    expect((await me.lookup(["2535400000000999"])).cinnabar).toEqual([]);
  });

  it("removes linger immediately on visibility off, even when already hidden", async () => {
    const { client: me } = await player();
    const { client: alex } = await player({ xuid: ALEX });
    const { client: hidden } = await player({ xuid: ALEX, visible: false });
    alex.close();
    await alex.closed;
    expect((await me.lookup([ALEX])).cinnabar).toEqual([ALEX]);
    hidden.send({ type: "visibility", visible: false });
    expect((await me.lookup([ALEX])).cinnabar).toEqual([]);
    hidden.close();
    await hidden.closed;
    expect((await me.lookup([ALEX])).cinnabar).toEqual([]);
  });

  it("doesn't restore a player the server disconnected if the Hub wakes before the close completes", async () => {
    const ME = "2535400000000100";
    const { client: me } = await player({ xuid: ME });
    await player({ xuid: ALEX });
    await runInDurableObject(hub(), async (instance: Hub, state) => {
      const socketOf = (xuid: string) => state.getWebSockets().find((ws) => ws.deserializeAttachment()?.xuid === xuid)!;
      const meWs = socketOf(ME);
      await instance.webSocketMessage(socketOf(ALEX), JSON.stringify({ type: "lookup", id: 1, xuids: ["bad"] }));
      // Waking from hibernation constructs a fresh Hub from the sockets' attachments.
      await new Hub(state, env).webSocketMessage(meWs, JSON.stringify({ type: "lookup", id: 9, xuids: [ALEX] }));
    });
    expect(await me.next()).toEqual({ type: "lookup_result", id: 9, cinnabar: [] });
  });

  it("keeps presence across hibernation", async () => {
    const { client: me } = await player();
    await player({ xuid: ALEX });
    await player({ xuid: STEVE, visible: false });
    await evictDurableObject(hub());
    expect((await me.lookup([ALEX, STEVE])).cinnabar).toEqual([ALEX]);
  }, 10_000);
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
