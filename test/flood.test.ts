import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Hub } from "../src/hub";
import { connect, hub, installFakeIssuer, login, type Client } from "./helpers";

const open: Client[] = [];
beforeAll(installFakeIssuer);
afterEach(() => Promise.all(open.splice(0).map((c) => (c.close(), c.closed))));

/** Retains an authenticated client for cleanup. */
async function player() {
  const { client } = await login();
  open.push(client);
  return client;
}

describe("socket flood control", () => {
  it("closes unknown messages during hello", async () => {
    const client = await connect();
    open.push(client);
    client.send({ type: "future_message" });
    expect((await client.closed).code).toBe(4401);
  });

  it("limits every non-ping frame, including ignored types, across hibernation", async () => {
    const client = await player();
    for (let i = 0; i < 27; i++) client.send({ type: "future_message" });
    expect((await client.lookup(["9"])).type).toBe("lookup_result");
    await evictDurableObject(hub());
    client.send({ type: "future_message" });
    expect((await client.closed).code).toBe(1008);
  }, 10_000);

  it("enforces a byte budget before the frame-count budget", async () => {
    const client = await player();
    for (let i = 0; i < 5; i++) client.send({ type: "padding", pad: "é".repeat(7000) });
    expect((await client.closed).code).toBe(1008);
  });

  it("refills the frame budget after ten seconds and exempts pings", async () => {
    const client = await player();
    await runInDurableObject(hub(), async (instance: Hub, state) => {
      const ws = state.getWebSockets().find((ws) => ws.deserializeAttachment()?.stage === "ready")!;
      for (let i = 0; i < 28; i++) await instance.webSocketMessage(ws, '{"type":"future"}');
      for (let i = 0; i < 50; i++) await instance.webSocketMessage(ws, "ping");
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10_001);
      try {
        await instance.webSocketMessage(ws, '{"type":"visibility","visible":true}');
        expect(ws.readyState).toBe(WebSocket.OPEN);
      } finally {
        clock.mockRestore();
      }
    });
    for (let i = 0; i < 50; i++) expect(await client.next()).toEqual({ type: "pong" });
  });
});
