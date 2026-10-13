import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { IssuerKeys, IssuerUnavailable, canonicalIssuer, decodeBase64, encodeBase64Url } from "../src/identity";
import { AUDIENCE, ISSUER, clientKey } from "./helpers";

const HOUR = 60 * 60 * 1000;

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
  const state = { keys: initial, jwksFetches: 0, down: false, issuer: ISSUER, stall: "none" as Stall };
  const deadlines: AbortController[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    if (state.down) throw new TypeError("network down");
    // Both stalls ignore the abort signal, like a peer that never answers.
    if (state.stall === "headers") return new Promise<Response>(() => {});
    if (state.stall === "body") return new Response(new ReadableStream({ start() {} }));
    const url = String(input);
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

  it("refetches when an unknown kid appears, at most once per cooldown", async () => {
    const a = await signer("a");
    const b = await signer("b");
    const { state, keys } = fakeIssuer([a.jwk]);
    const t0 = 1_800_000_000_000;
    await keys.verify(await a.token(t0), t0);
    state.keys = [a.jwk, b.jwk];
    expect(await keys.verify(await b.token(t0), t0 + 1_000)).toBeNull();
    expect(state.jwksFetches).toBe(1);
    expect(await keys.verify(await b.token(t0), t0 + 30_000)).not.toBeNull();
    expect(state.jwksFetches).toBe(2);
  });

  it("keeps the last good keys while the issuer is unreachable, and reports an issuer outage otherwise", async () => {
    const a = await signer("a");
    const { state, keys } = fakeIssuer([a.jwk]);
    const t0 = 1_800_000_000_000;
    state.down = true;
    await expect(keys.verify(await a.token(t0), t0)).rejects.toBeInstanceOf(IssuerUnavailable);
    state.down = false;
    await keys.verify(await a.token(t0), t0);
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
