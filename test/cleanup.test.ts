import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hub } from "../src/hub";
import { connect, type Client, hub } from "./helpers";

const open: Client[] = [];
afterEach(() => Promise.all(open.splice(0).map((client) => (client.close(), client.closed))));

describe("alarm cleanup", () => {
  it.each(["quota", "unavailable"])("expires over 250 handshakes with %s metrics and continues maintenance", async (failure) => {
    open.push(await connect());
    await runInDurableObject(hub(), async (_, state) => {
      const initial = state.getWebSockets()[0]!;
      const ipHash = initial.deserializeAttachment().ipHash;
      const expired = 256;
      const now = Date.now();
      const sockets: WebSocket[] = [initial];
      initial.serializeAttachment({ ...initial.deserializeAttachment(), deadline: now - 1 });
      for (let i = 1; i <= expired; i++) {
        const { 0: client, 1: server } = new WebSocketPair();
        state.acceptWebSocket(server);
        client.accept();
        server.serializeAttachment({
          stage: "hello", deadline: i === expired ? now + 60_000 : now - 1, ipHash,
          traffic: { startedAt: now, frames: 0, bytes: 0, rateLimited: 0 },
        });
        sockets.push(server);
      }
      let writes = 0;
      const writeDataPoint = vi.fn(() => {
        if (++writes > 250 || failure === "unavailable") throw new Error("metrics unavailable");
      });
      const instance = new Hub(state, Object.assign({}, env, { METRICS: { writeDataPoint } }));
      const request = new Request("https://api.test/v1/connect", {
        headers: { Upgrade: "websocket", "CF-Connecting-IP": "" },
      });
      expect((await instance.fetch(request)).status).toBe(429);
      writeDataPoint.mockClear();
      writes = 0;
      state.storage.sql.exec("INSERT OR REPLACE INTO lookup_budgets VALUES ('expired', 0, ?)", now - 300_001);
      await state.storage.deleteAlarm();
      try {
        await instance.alarm();
        expect(sockets.slice(0, expired).every((ws) => ws.readyState !== WebSocket.OPEN)).toBe(true);
        expect(sockets.at(-1)!.readyState).toBe(WebSocket.OPEN);
        expect(state.storage.sql.exec("SELECT * FROM lookup_budgets").toArray()).toEqual([]);
        expect(await state.storage.getAlarm()).toBe(now + 60_000);
        expect(writeDataPoint.mock.calls).toEqual([[{ blobs: ["authentication_failed"], doubles: [expired] }]]);
        const response = await instance.fetch(request);
        expect(response.status).toBe(101);
        response.webSocket!.accept();
        response.webSocket!.close(1000);
      } finally {
        for (const ws of sockets) {
          try {
            ws.close(1000);
          } catch {
            // Already closed.
          }
        }
      }
    });
  });
});
