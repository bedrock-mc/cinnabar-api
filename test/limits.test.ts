import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Hub } from "../src/hub";
import { HANDSHAKE_TIMEOUT_MS, MAX_CONNECTIONS, MAX_CONNECTIONS_PER_IP } from "../src/protocol";
import { Client, hub } from "./helpers";

// Exercise the real admission path without opening 20,000 sockets in each test.
vi.mock("../src/protocol", async (original) => ({
  ...(await original<typeof import("../src/protocol")>()),
  MAX_CONNECTIONS: 12,
  MAX_CONNECTIONS_PER_IP: 8,
}));

const open: Client[] = [];
afterEach(() => Promise.all(open.splice(0).map((c) => (c.close(), c.closed))));

/** Requests an upgrade through the Worker, retaining accepted sockets for cleanup. */
async function upgrade(ip = "192.0.2.1"): Promise<Response> {
  const response = await exports.default.fetch("https://api.test/v1/connect", {
    headers: { Upgrade: "websocket", "CF-Connecting-IP": ip },
  });
  if (response.webSocket) open.push(new Client(response.webSocket));
  return response;
}

/** Checks that an admission refusal includes a positive retry delay and no socket. */
function expectLimited(response: Response): void {
  expect(response.status).toBe(429);
  expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
  expect(response.webSocket).toBeNull();
}

describe("connection caps", () => {
  it("refuses upgrades at the global cap and admits after a close, even after waking", async () => {
    for (let i = 0; i < MAX_CONNECTIONS; i++) expect((await upgrade(`192.0.2.${i + 1}`)).status).toBe(101);
    expectLimited(await upgrade("198.51.100.1"));
    await evictDurableObject(hub());
    expectLimited(await upgrade("198.51.100.1"));
    open[0]!.close();
    await open[0]!.closed;
    expect((await upgrade("198.51.100.1")).status).toBe(101);
    expectLimited(await upgrade("198.51.100.2"));
  });

  it("limits each IP independently and releases its slot after close", async () => {
    for (let i = 0; i < MAX_CONNECTIONS_PER_IP; i++) expect((await upgrade()).status).toBe(101);
    expectLimited(await upgrade());
    expect((await upgrade("198.51.100.1")).status).toBe(101);
    open[0]!.close();
    await open[0]!.closed;
    expect((await upgrade()).status).toBe(101);
    expectLimited(await upgrade());
  });

  it.each(["global", "IP"])("releases the %s cap on handshake timeout", async (cap) => {
    const count = cap === "global" ? MAX_CONNECTIONS : MAX_CONNECTIONS_PER_IP;
    for (let i = 0; i < count; i++) await upgrade(cap === "global" ? `192.0.2.${i + 1}` : "192.0.2.1");
    expectLimited(await upgrade());
    await runInDurableObject(hub(), (instance: Hub) => {
      instance.expireHandshakes(Date.now() + HANDSHAKE_TIMEOUT_MS + 1);
    });
    expect((await open[0]!.closed).code).toBe(4401);
    expect((await upgrade()).status).toBe(101);
  });

  it("counts concurrent admissions once and releases errors and repeated cleanup once", async () => {
    const responses = await Promise.all(Array.from({ length: MAX_CONNECTIONS_PER_IP + 4 }, () => upgrade()));
    expect(responses.filter((r) => r.status === 101)).toHaveLength(MAX_CONNECTIONS_PER_IP);
    for (const response of responses.filter((r) => r.status !== 101)) expectLimited(response);
    await runInDurableObject(hub(), async (instance: Hub, state) => {
      const ws = state.getWebSockets()[0]!;
      await instance.webSocketError(ws);
      await instance.webSocketError(ws);
      await instance.webSocketClose(ws, 1000, "");
    });
    expect((await upgrade()).status).toBe(101);
    expectLimited(await upgrade());
  });

  it("resets only the IP counts on hibernation and keeps IP-derived data out of attachments and storage", async () => {
    for (let i = 0; i < MAX_CONNECTIONS_PER_IP; i++) await upgrade();
    expectLimited(await upgrade());
    await runInDurableObject(hub(), async (_: Hub, state) => {
      for (const ws of state.getWebSockets()) {
        expect(ws.deserializeAttachment()).toEqual({ stage: "hello", deadline: expect.any(Number) });
      }
      expect(await state.storage.list()).toEqual(new Map());
    });
    await evictDurableObject(hub());
    expect((await upgrade()).status).toBe(101);
    // Closing an uncounted, restored socket must not release the new socket's IP slot.
    open[0]!.close();
    await open[0]!.closed;
    for (let i = 0; i < MAX_CONNECTIONS_PER_IP - 1; i++) open[i + 1]!.close();
    await Promise.all(open.slice(1, MAX_CONNECTIONS_PER_IP).map((c) => c.closed));
    for (let i = 1; i < MAX_CONNECTIONS_PER_IP; i++) expect((await upgrade()).status).toBe(101);
    expectLimited(await upgrade());
  });
});
