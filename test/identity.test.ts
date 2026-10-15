import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { IssuerKeys, IssuerUnavailable, canonicalIssuer, decodeBase64, encodeBase64Url } from "../src/identity";
import { JWKS_REFETCH_INTERVAL_MS } from "../src/protocol";
import { AUDIENCE, ISSUER, clientKey } from "./helpers";

const HOUR = 60 * 60 * 1000;

/** Creates an issuer key and tokens signed with it. */
async function signer(kid: string) {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256" };
  const token = async (now: number) =>
    new SignJWT({ xid: "1", xname: "Alex", cpk: (await clientKey()).cpk })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime(Math.floor(now / 1000) + 3600)
      .sign(privateKey);
  return { jwk, token };
}

type Stall = "none" | "headers" | "body";

/** A fake issuer whose published keys the test can rotate or stall, counting JWKS fetches. */
function fakeIssuer(initial: object[]) {
  const state = { keys: initial, jwksFetches: 0, refreshes: 0, down: false, issuer: ISSUER, stall: "none" as Stall };
  const deadlines: AbortController[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `${ISSUER}.well-known/openid-configuration`) state.refreshes++;
    if (state.down) throw new TypeError("network down");
    // Both stalls ignore the abort signal, like a peer that never answers.
    if (state.stall === "headers") return new Promise<Response>(() => {});
    if (state.stall === "body") return new Response(new ReadableStream({ start() {} }));
    if (url === `${ISSUER}.well-known/openid-configuration`) {
      return Response.json({
        issuer: state.issuer,
        jwks_uri: `${ISSUER}keys`,
        id_token_signing_alg_values_supported: ["RS256"],
      });
    }
    if (url === `${ISSUER}keys`) {
      state.jwksFetches++;
      return Response.json({ keys: state.keys });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const refreshDeadline = () => {
    const controller = new AbortController();
    deadlines.push(controller);
    return controller.signal;
  };
  return { state, deadlines, keys: new IssuerKeys("https://issuer.test", fetcher, refreshDeadline) };
}

/** Makes an invalid token with a random kid, sufficient to exercise key selection. */
function unknownToken(): string {
  const header = JSON.stringify({ alg: "RS256", kid: crypto.randomUUID() });
  return `${encodeBase64Url(new TextEncoder().encode(header))}.e30.AAAA`;
}

describe("issuer keys", () => {
  it("caches the JWKS for an hour", async () => {
    const a = await signer("a");
    const { state, keys } = fakeIssuer([a.jwk]);
    const t0 = 1_800_000_000_000;
    expect(await keys.verify(await a.token(t0), t0)).toMatchObject({ xuid: "1", displayName: "Alex" });
    expect(await keys.verify(await a.token(t0), t0 + HOUR - 1)).not.toBeNull();
    expect(state.jwksFetches).toBe(1);
    await keys.verify(await a.token(t0 + HOUR), t0 + HOUR);
    expect(state.jwksFetches).toBe(2);
  });

  it("refetches when an unknown kid appears, at most once per minute", async () => {
    const a = await signer("a");
    const b = await signer("b");
    const { state, keys } = fakeIssuer([a.jwk]);
    const t0 = 1_800_000_000_000;
    await keys.verify(await a.token(t0), t0);
    state.keys = [a.jwk, b.jwk];
    expect(await keys.verify(await b.token(t0), t0 + 1_000)).toBeNull();
    expect(state.jwksFetches).toBe(1);
    expect(await keys.verify(await b.token(t0), t0 + 30_000)).toBeNull();
    expect(state.jwksFetches).toBe(1);
    expect(await keys.verify(await b.token(t0), t0 + JWKS_REFETCH_INTERVAL_MS)).not.toBeNull();
    expect(state.jwksFetches).toBe(2);
  });

  it("bounds a random-kid flood, sharing concurrent refreshes at each interval", async () => {
    const a = await signer("a");
    const { state, keys } = fakeIssuer([a.jwk]);
    const t0 = 1_800_000_000_000;
    await keys.verify(await a.token(t0), t0);
    for (const delta of [1, 30_000, JWKS_REFETCH_INTERVAL_MS - 1]) {
      expect(await keys.verify(unknownToken(), t0 + delta)).toBeNull();
    }
    expect(state.jwksFetches).toBe(1);
    for (const interval of [1, 2]) {
      const now = t0 + interval * JWKS_REFETCH_INTERVAL_MS;
      expect(await Promise.all(Array.from({ length: 20 }, () => keys.verify(unknownToken(), now)))).toEqual(
        Array(20).fill(null),
      );
      expect(await keys.verify(unknownToken(), now + JWKS_REFETCH_INTERVAL_MS - 1)).toBeNull();
      expect(state.jwksFetches).toBe(interval + 1);
    }
  });

  it("throttles failed refresh attempts without losing cached keys", async () => {
    const a = await signer("a");
    const { state, keys } = fakeIssuer([a.jwk]);
    const t0 = 1_800_000_000_000;
    await keys.verify(await a.token(t0), t0);
    state.down = true;
    for (const delta of [60_000, 60_001, 90_000, 119_999]) {
      expect(await keys.verify(unknownToken(), t0 + delta)).toBeNull();
    }
    expect(state.refreshes).toBe(2);
    expect(await keys.verify(await a.token(t0), t0 + 90_000)).not.toBeNull();
    state.down = false;
    expect(await keys.verify(unknownToken(), t0 + 120_000)).toBeNull();
    expect(state.jwksFetches).toBe(2);
  });

  it("keeps the last good keys while the issuer is unreachable, and reports an issuer outage otherwise", async () => {
    const a = await signer("a");
    const { state, keys } = fakeIssuer([a.jwk]);
    const t0 = 1_800_000_000_000;
    state.down = true;
    await expect(keys.verify(await a.token(t0), t0)).rejects.toBeInstanceOf(IssuerUnavailable);
    await expect(keys.verify(await a.token(t0), t0 + 1)).rejects.toBeInstanceOf(IssuerUnavailable);
    expect(state.refreshes).toBe(1);
    state.down = false;
    await keys.verify(await a.token(t0), t0 + JWKS_REFETCH_INTERVAL_MS);
    state.down = true;
    expect(await keys.verify(await a.token(t0 + 2 * HOUR), t0 + 2 * HOUR)).not.toBeNull();
  });

  it.each(["headers", "body"] as const)(
    "bounds a refresh whose %s stall, falls back to cached keys, and retries afterwards",
    async (stall) => {
      const a = await signer("a");
      const { state, deadlines, keys } = fakeIssuer([a.jwk]);
      const t0 = 1_800_000_000_000;
      await keys.verify(await a.token(t0), t0);
      state.stall = stall;
      const later = t0 + HOUR;
      const stalled = keys.verify(await a.token(later), later);
      deadlines.at(-1)!.abort();
      expect(await stalled).toMatchObject({ xuid: "1" });
      state.stall = "none";
      expect(await keys.verify(await a.token(later), later + 1)).not.toBeNull();
      expect(state.refreshes).toBe(2);
      expect(await keys.verify(await a.token(later), later + JWKS_REFETCH_INTERVAL_MS)).not.toBeNull();
      expect(state.jwksFetches).toBe(2);
    },
  );

  it("reports an outage when the first refresh stalls past its deadline", async () => {
    const a = await signer("a");
    const { state, deadlines, keys } = fakeIssuer([a.jwk]);
    state.stall = "headers";
    const t0 = 1_800_000_000_000;
    const stalled = keys.verify(await a.token(t0), t0);
    deadlines.at(-1)!.abort();
    await expect(stalled).rejects.toBeInstanceOf(IssuerUnavailable);
  });

  it("refuses a discovery document for another issuer", async () => {
    const a = await signer("a");
    const { state, keys } = fakeIssuer([a.jwk]);
    state.issuer = "https://evil.test/";
    const t0 = 1_800_000_000_000;
    await expect(keys.verify(await a.token(t0), t0)).rejects.toBeInstanceOf(IssuerUnavailable);
  });
});

describe("encoding", () => {
  it("normalises the issuer to its trailing-slash form", () => {
    expect(canonicalIssuer("https://a.test")).toBe("https://a.test/");
    expect(canonicalIssuer("https://a.test/")).toBe("https://a.test/");
  });

  it("round-trips base64url and rejects foreign alphabets", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(33));
    expect(decodeBase64(encodeBase64Url(bytes), true)).toEqual(bytes);
    expect(decodeBase64("ab+/", true)).toBeNull();
    expect(decodeBase64("ab-_", false)).toBeNull();
    expect(decodeBase64("YWJj", false)).toEqual(new TextEncoder().encode("abc"));
    expect(decodeBase64("YWI=", false)).toEqual(new TextEncoder().encode("ab"));
  });
});
