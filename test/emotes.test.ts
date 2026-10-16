import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Hub } from "../src/hub";
import { afterEach, beforeAll, expect, it } from "vitest";
import { hub, installFakeIssuer, login, type Client } from "./helpers";
import { identityUuid } from "../src/identity";

const open: Client[] = [];
const A = "2535400000000311";
const B = "2535400000000312";
const CLIP = "cinnabar:twerk";
beforeAll(installFakeIssuer);
afterEach(() => Promise.all(open.splice(0).map((c) => (c.close(), c.closed))));

/** Authenticates an account and keeps its socket under fixture cleanup. */
async function player(xuid: string, visible = true) {
  const { client } = await login({ xuid, visible });
  open.push(client);
  return client;
}

/** Orders a socket's prior updates through an application-level round trip. */
async function flush(client: Client) {
  expect(await client.lookup([], 777)).toMatchObject({ type: "lookup_result", id: 777 });
}

it("shares authenticated start, phase and stop only with subscribed nearby accounts", async () => {
  const a = await player(A);
  const b = await player(B);
  const other = await player("2535400000000313");
  b.send({ type: "emote_state", xuids: [A], emote_id: null, elapsed_ms: 0 });
  await flush(b);
  a.send({ type: "emote_state", xuids: [B], emote_id: CLIP, elapsed_ms: 123, xuid: B });
  const start = await b.next();
  expect(start).toMatchObject({ type: "emote", xuid: A, uuid: await identityUuid(A), emote_id: CLIP });
  expect(start.elapsed_ms).toBeGreaterThanOrEqual(123);
  expect(start.valid_for_ms).toBeLessThanOrEqual(15000);
  await flush(other);
  a.send({ type: "emote_state", emote_id: null, elapsed_ms: 0 });
  expect(await b.next()).toMatchObject({ xuid: A, emote_id: null, valid_for_ms: 0 });
});

it.each(["close", "visibility", "stop", "departure"] as const)(
  "keeps the newer socket's emote when an older account socket withdraws by %s",
  async (withdrawal) => {
    const older = await player(A);
    const newer = await player(A);
    const watcher = await player(B);
    watcher.send({ type: "emote_state", xuids: [A], emote_id: null, elapsed_ms: 0 });
    await flush(watcher);
    older.send({ type: "emote_state", xuids: [B], emote_id: CLIP, elapsed_ms: 100 });
    expect(await watcher.next()).toMatchObject({ xuid: A, emote_id: CLIP });
    newer.send({ type: "emote_state", xuids: [B], emote_id: "cinnabar:wave", elapsed_ms: 900 });
    expect(await watcher.next()).toMatchObject({ xuid: A, emote_id: "cinnabar:wave" });

    if (withdrawal === "close") {
      older.close();
      await older.closed;
    } else {
      older.send(withdrawal === "visibility"
        ? { type: "visibility", visible: false }
        : withdrawal === "departure"
          ? { type: "emote_state", xuids: [], emote_id: CLIP, elapsed_ms: 0 }
          : { type: "emote_state", emote_id: null, elapsed_ms: 0 });
      await flush(older);
    }
    const remaining = await watcher.next();
    expect(remaining).toMatchObject({ xuid: A, emote_id: "cinnabar:wave" });
    expect(remaining.elapsed_ms).toBeGreaterThanOrEqual(900);
    expect(remaining.valid_for_ms).toBeGreaterThan(0);
    await flush(watcher);

    newer.send({ type: "emote_state", emote_id: null, elapsed_ms: 0 });
    expect(await watcher.next()).toMatchObject({ xuid: A, emote_id: null, valid_for_ms: 0 });
    await flush(watcher);
  },
);

it("falls back to an older active socket when the newer socket stops", async () => {
  const older = await player(A);
  const newer = await player(A);
  const watcher = await player(B);
  watcher.send({ type: "emote_state", uuids: [await identityUuid(A)], emote_id: null, elapsed_ms: 0 });
  await flush(watcher);
  older.send({ type: "emote_state", xuids: [B], emote_id: CLIP, elapsed_ms: 100 });
  expect(await watcher.next()).toMatchObject({ emote_id: CLIP });
  newer.send({ type: "emote_state", xuids: [B], emote_id: "cinnabar:wave", elapsed_ms: 900 });
  expect(await watcher.next()).toMatchObject({ emote_id: "cinnabar:wave" });
  newer.send({ type: "emote_state", emote_id: null, elapsed_ms: 0 });
  expect(await watcher.next()).toMatchObject({ xuid: A, emote_id: CLIP });
  await flush(watcher);
  older.send({ type: "emote_state", emote_id: null, elapsed_ms: 0 });
  expect(await watcher.next()).toMatchObject({ xuid: A, emote_id: null, valid_for_ms: 0 });
});

it.each(["active", "expired", "hidden", "elsewhere"] as const)(
  "arbitrates %s remaining sources after rebuilding socket attachments",
  async (condition) => {
    const older = await player(A);
    const newer = await player(A);
    const watcher = await player(B);
    watcher.send({ type: "emote_state", xuids: [A], emote_id: null, elapsed_ms: 0 });
    await flush(watcher);
    older.send({ type: "emote_state", xuids: [B], emote_id: CLIP, elapsed_ms: 100 });
    await watcher.next();
    newer.send({ type: "emote_state", xuids: [B], emote_id: "cinnabar:wave", elapsed_ms: 900 });
    await watcher.next();

    await runInDurableObject(hub(), async (_, state) => {
      const sources = state.getWebSockets().filter((ws) => ws.deserializeAttachment()?.xuid === A);
      const withdrawing = sources.find((ws) => ws.deserializeAttachment().emote.id === CLIP)!;
      const remaining = sources.find((ws) => ws !== withdrawing)!;
      const attachment = remaining.deserializeAttachment();
      remaining.serializeAttachment({
        ...attachment,
        visible: condition !== "hidden",
        watching: condition === "elsewhere" ? [] : attachment.watching,
        emote: { ...attachment.emote, updated: Date.now() - (condition === "expired" ? 15001 : 5000) },
      });
      const rebuilt = new Hub(state, env);
      await rebuilt.webSocketMessage(withdrawing, JSON.stringify({ type: "emote_state", emote_id: null, elapsed_ms: 0 }));
    });
    const result = await watcher.next();
    expect(result).toMatchObject({ xuid: A, emote_id: condition === "active" ? "cinnabar:wave" : null });
    if (condition === "active") {
      expect(result.elapsed_ms).toBeGreaterThanOrEqual(5900);
      expect(result.valid_for_ms).toBeGreaterThan(0);
      expect(result.valid_for_ms).toBeLessThanOrEqual(10000);
    } else {
      expect(result.valid_for_ms).toBe(0);
    }
    await flush(watcher);
  },
);

it("rebuilds watches and replay leases from socket attachments", async () => {
  const a = await player(A);
  const b = await player(B);
  b.send({ type: "emote_state", uuids: [await identityUuid(A)], emote_id: null, elapsed_ms: 0 });
  await flush(b);
  a.send({ type: "emote_state", xuids: [B], emote_id: CLIP, elapsed_ms: 300 });
  expect(await b.next()).toMatchObject({ xuid: A, emote_id: CLIP });
  await runInDurableObject(hub(), async (_, state) => {
    const rebuilt = new Hub(state, env);
    const source = state.getWebSockets().find((ws) => ws.deserializeAttachment()?.xuid === A)!;
    await rebuilt.webSocketMessage(source, JSON.stringify({ type: "emote_state", xuids: [B], emote_id: CLIP, elapsed_ms: 900 }));
  });
  const renewed = await b.next();
  expect(renewed).toMatchObject({ xuid: A, emote_id: CLIP });
  expect(renewed.elapsed_ms).toBeGreaterThanOrEqual(900);
  a.close();
  await a.closed;
  expect(await b.next()).toMatchObject({ xuid: A, emote_id: null });
});

it("honors visibility opt-out and removes departed subscriptions", async () => {
  const a = await player(A);
  const b = await player(B);
  b.send({ type: "emote_state", xuids: [A], emote_id: null, elapsed_ms: 0 });
  await flush(b);
  a.send({ type: "emote_state", xuids: [B], emote_id: CLIP, elapsed_ms: 0 });
  await b.next();
  a.send({ type: "visibility", visible: false });
  expect(await b.next()).toMatchObject({ emote_id: null });
  a.send({ type: "emote_state", xuids: [B], emote_id: CLIP, elapsed_ms: 0 });
  await flush(a);
  await flush(b);
  b.send({ type: "emote_state", xuids: [], uuids: [], emote_id: null, elapsed_ms: 0 });
  await flush(b);
  a.send({ type: "visibility", visible: true });
  a.send({ type: "emote_state", xuids: [B], emote_id: CLIP, elapsed_ms: 0 });
  await flush(a);
  await flush(b);
});

it("replays a live dance to new watchers and refuses expired leases", async () => {
  const a = await player(A);
  const b = await player(B);
  a.send({ type: "emote_state", xuids: [B], emote_id: CLIP, elapsed_ms: 400 });
  await flush(a);
  b.send({ type: "emote_state", xuids: [A], emote_id: null, elapsed_ms: 0 });
  expect(await b.next()).toMatchObject({ xuid: A, emote_id: CLIP });
  b.send({ type: "emote_state", xuids: [], uuids: [], emote_id: null, elapsed_ms: 0 });
  await flush(b);
  await runInDurableObject(hub(), async (_, state) => {
    const source = state.getWebSockets().find((ws) => ws.deserializeAttachment()?.xuid === A)!;
    const attachment = source.deserializeAttachment();
    source.serializeAttachment({ ...attachment, emote: { ...attachment.emote, updated: Date.now() - 15001 } });
    const rebuilt = new Hub(state, env);
    const receiver = state.getWebSockets().find((ws) => ws.deserializeAttachment()?.xuid === B)!;
    await rebuilt.webSocketMessage(receiver, JSON.stringify({ type: "emote_state", xuids: [A], emote_id: null, elapsed_ms: 0 }));
  });
  await flush(b);
});
