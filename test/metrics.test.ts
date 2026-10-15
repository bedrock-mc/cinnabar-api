import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Hub } from "../src/hub";
import { connect, hub, installFakeIssuer, login, type Client } from "./helpers";

vi.mock("../src/protocol", async (original) => ({
  ...(await original<typeof import("../src/protocol")>()),
  MAX_CONNECTIONS: 2,
}));

const open: Client[] = [];
beforeAll(installFakeIssuer);
afterEach(() => Promise.all(open.splice(0).map((c) => (c.close(), c.closed))));

/** Rebuilds the hub with a recording metrics binding and runs real server behavior. */
async function record(action: (instance: Hub, state: DurableObjectState) => Promise<unknown>, writeDataPoint = vi.fn()) {
  await runInDurableObject(hub(), async (_, state) => {
    const bindings = Object.assign({}, env, { METRICS: { writeDataPoint } });
    await action(new Hub(state, bindings), state);
  });
  return writeDataPoint.mock.calls;
}

describe("identifier-free metrics", () => {
  it("counts admission refusals without addresses", async () => {
    open.push(await connect(), await connect());
    expect(await record(async (instance) => {
      expect((await instance.fetch(new Request("https://api.test/v1/connect", {
        headers: { Upgrade: "websocket", "CF-Connecting-IP": "192.0.2.123" },
      }))).status).toBe(429);
    })).toEqual([[{ blobs: ["admission_refused"], doubles: [1] }]]);
  });

  it("counts authentication failures without tokens or identities", async () => {
    open.push(await connect());
    expect(await record(async (instance, state) => {
      await instance.webSocketMessage(state.getWebSockets()[0]!, '{"type":"lookup","id":1,"xuids":["9"]}');
    })).toEqual([[{ blobs: ["authentication_failed"], doubles: [1] }]]);
  });

  it("counts overload closes without socket identifiers", async () => {
    const { client } = await login();
    open.push(client);
    expect(await record(async (instance, state) => {
      const ws = state.getWebSockets()[0]!;
      for (let i = 0; i < 29; i++) await instance.webSocketMessage(ws, '{"type":"future"}');
    })).toEqual([[{ blobs: ["overload_closed"], doubles: [1] }]]);
  });

  it("counts lookups without XUIDs, lookup IDs or results", async () => {
    const { client } = await login({ xuid: "2535412345678901" });
    open.push(client);
    expect(await record(async (instance, state) => {
      await instance.webSocketMessage(state.getWebSockets()[0]!, '{"type":"lookup","id":999,"xuids":["2535412345678901"]}');
    })).toEqual([[{ blobs: ["lookup"], doubles: [1] }]]);
    expect((await client.next()).type).toBe("lookup_result");
  });
});


/** Simulates a binding failure without exposing any request data to the error. */
function failingMetrics() {
  return vi.fn(() => { throw new Error("analytics unavailable"); });
}

describe("metrics failures", () => {
  it("still refuses admission when metrics throw", async () => {
    open.push(await connect(), await connect());
    await record(async (instance) => {
      expect((await instance.fetch(new Request("https://api.test/v1/connect", {
        headers: { Upgrade: "websocket" },
      }))).status).toBe(429);
    }, failingMetrics());
  });

  it("still forgets and closes an unauthorized socket when metrics throw", async () => {
    const client = await connect();
    open.push(client);
    await record(async (instance, state) => {
      const ws = state.getWebSockets()[0]!;
      await instance.webSocketMessage(ws, '{"type":"lookup","id":1,"xuids":["9"]}');
      expect(ws.deserializeAttachment()).toEqual({ stage: "closed" });
    }, failingMetrics());
    expect((await client.closed).code).toBe(4401);
  });

  it("still closes a flooding socket when metrics throw", async () => {
    const { client } = await login();
    open.push(client);
    await record(async (instance, state) => {
      const ws = state.getWebSockets()[0]!;
      for (let i = 0; i < 29; i++) await instance.webSocketMessage(ws, '{"type":"future"}');
      expect(ws.deserializeAttachment()).toEqual({ stage: "closed" });
    }, failingMetrics());
    expect((await client.closed).code).toBe(1008);
  });

  it("still charges lookup tokens and closes repeated denials when metrics throw", async () => {
    const { client } = await login();
    open.push(client);
    const roster = Array.from({ length: 128 }, (_, i) => String(i + 1000));
    await record(async (instance, state) => {
      const ws = state.getWebSockets()[0]!;
      for (let id = 0; id < 11; id++) {
        await instance.webSocketMessage(ws, JSON.stringify({ type: "lookup", id, xuids: id < 8 ? roster : ["9"] }));
      }
      expect(ws.deserializeAttachment()).toEqual({ stage: "closed" });
    }, failingMetrics());
    for (let id = 0; id < 8; id++) expect(await client.next()).toMatchObject({ type: "lookup_result", id });
    for (let id = 8; id < 11; id++) expect(await client.next()).toEqual({ type: "error", code: "rate_limited", id });
    expect((await client.closed).code).toBe(1008);
  });
});
