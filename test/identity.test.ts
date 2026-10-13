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

/** A fake issuer whose published keys the test can rotate, counting JWKS fetches. */
function fakeIssuer(initial: object[]) {
  const state = { keys: initial, jwksFetches: 0, down: false, issuer: ISSUER };
  const fetcher = (async (input: RequestInfo | URL) => {
    if (state.down) throw new TypeError("network down");
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
  return { state, keys: new IssuerKeys("https://issuer.test", fetcher) };
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
