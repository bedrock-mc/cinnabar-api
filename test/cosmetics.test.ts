import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Hub } from "../src/hub";
import { afterEach, beforeAll, expect, it } from "vitest";
import { hub, installFakeIssuer, login, type Client } from "./helpers";
import { identityUuid } from "../src/identity";

const open: Client[] = [];
const A = "2535400000000411", B = "2535400000000412";
beforeAll(installFakeIssuer);
afterEach(() => Promise.all(open.splice(0).map((client) => (client.close(), client.closed))));

/** Authenticates a fixture account and owns its cleanup. */
async function player(xuid: string) {
  const { client } = await login({ xuid });
  open.push(client);
  return client;
}
/** Orders previous frames and checks that no unrelated cosmetic frame was queued. */
async function flush(client: Client) {
  expect(await client.lookup([], 777)).toMatchObject({ type: "lookup_result", id: 777 });
}
/** Shares a hat on the existing nearby-player exchange without starting an emote. */
function equip(client: Client, hat: string | null, watching?: string[]) {
  client.send({ type: "emote_state", emote_id: null, elapsed_ms: 0, hat_id: hat,
    ...(watching === undefined ? {} : { xuids: watching }) });
}

it("shares authenticated hats independently of emotes, then replaces and removes them", async () => {
  const a = await player(A), b = await player(B), other = await player("2535400000000413");
  equip(a, "crown", [B]);
  await flush(a);
  await flush(b);
  b.send({ type: "emote_state", emote_id: null, elapsed_ms: 0, uuids: [await identityUuid(A)] });
  expect(await b.next()).toMatchObject({ type: "cosmetic", xuid: A, uuid: await identityUuid(A), hat_id: "crown" });
  equip(a, "bunny_ears");
  expect(await b.next()).toMatchObject({ type: "cosmetic", hat_id: "bunny_ears" });
  a.send({ type: "emote_state", emote_id: null, elapsed_ms: 0 });
  expect(await b.next()).toMatchObject({ hat_id: "bunny_ears" });
  equip(a, null);
  expect(await b.next()).toMatchObject({ hat_id: null, valid_for_ms: 0 });
  await flush(other);
});

it.each(["visibility", "close", "departure"] as const)("clears hats on %s", async (reason) => {
  const a = await player(A), b = await player(B);
  b.send({ type: "emote_state", emote_id: null, elapsed_ms: 0, xuids: [A] });
  await flush(b);
  equip(a, "crown", [B]);
  await b.next();
  if (reason === "close") { a.close(); await a.closed; }
  else if (reason === "visibility") a.send({ type: "visibility", visible: false });
  else equip(a, "crown", []);
  expect(await b.next()).toMatchObject({ type: "cosmetic", hat_id: null, valid_for_ms: 0 });
  await flush(b);
});

it.each([false, true])("restores bounded hibernation leases; expired=%s", async (expired) => {
  const a = await player(A), b = await player(B);
  equip(a, "crown", [B]);
  await flush(a);
  await runInDurableObject(hub(), async (_, state) => {
    const source = state.getWebSockets().find((ws) => ws.deserializeAttachment()?.xuid === A)!;
    const attachment = source.deserializeAttachment();
    source.serializeAttachment({ ...attachment, hat: { ...attachment.hat, updated: Date.now() - (expired ? 15001 : 5000) } });
    const rebuilt = new Hub(state, env);
    const receiver = state.getWebSockets().find((ws) => ws.deserializeAttachment()?.xuid === B)!;
    await rebuilt.webSocketMessage(receiver, JSON.stringify({ type: "emote_state", emote_id: null, elapsed_ms: 0, xuids: [A] }));
  });
  if (!expired) {
    const hat = await b.next();
    expect(hat).toMatchObject({ type: "cosmetic", hat_id: "crown" });
    expect(hat.valid_for_ms).toBeGreaterThan(0);
    expect(hat.valid_for_ms).toBeLessThanOrEqual(10000);
  }
  await flush(b);
});

it("retains another live socket's hat when an older source withdraws", async () => {
  const older = await player(A), newer = await player(A), b = await player(B);
  b.send({ type: "emote_state", emote_id: null, elapsed_ms: 0, xuids: [A] });
  await flush(b);
  equip(older, "bunny_ears", [B]); await b.next();
  equip(newer, "crown", [B]); await b.next();
  older.close(); await older.closed;
  expect(await b.next()).toMatchObject({ hat_id: "crown" });
  equip(newer, null);
  expect(await b.next()).toMatchObject({ hat_id: null, valid_for_ms: 0 });
});
