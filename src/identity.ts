import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";
import { JWKS_REFETCH_INTERVAL_MS, PROOF_CONTEXT } from "./protocol";

export const MULTIPLAYER_AUDIENCE = "api://auth-minecraft-services/multiplayer";
const KEYS_MAX_AGE_MS = 60 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 5_000; // half the handshake budget, so the cached-key fallback still lands in time
const CLOCK_LEEWAY_S = 60;
const ASYMMETRIC_ALGS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512"];
const XUID = /^[0-9]{1,20}$/;
const MAX_DISPLAY_NAME = 64;

export interface Identity {
  xuid: string;
  displayName: string;
  cpk: string; // base64 SPKI DER of the token's P-384 key
}

/** Thrown when the issuer's discovery document or keys can't be fetched; not the client's fault. */
export class IssuerUnavailable extends Error {}

/** Returns the issuer in the trailing-slash form the authorization service writes into `iss`. */
export function canonicalIssuer(issuer: string): string {
  return issuer.endsWith("/") ? issuer : `${issuer}/`;
}

interface KeySet {
  verifier: ReturnType<typeof createLocalJWKSet>;
  kids: Set<string>;
  algorithms: string[];
  fetchedAt: number;
}

/** Verifies multiplayer tokens with hourly JWKS caching and at most one refresh attempt per minute. */
export class IssuerKeys {
  readonly issuer: string;
  private keys: KeySet | undefined;
  private refreshing: Promise<KeySet> | undefined;
  private lastRefreshAt = -Infinity;

  constructor(
    issuer: string,
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
    private readonly refreshDeadline: () => AbortSignal = () => AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  ) {
    this.issuer = canonicalIssuer(issuer);
  }

  /** Returns the token's identity, or null when the token or its claims are invalid at `now` (ms). */
  async verify(token: string, now: number): Promise<Identity | null> {
    let kid: string | undefined;
    try {
      kid = decodeProtectedHeader(token).kid;
    } catch {
      return null;
    }
    const keys = await this.keysFor(kid, now);
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, keys.verifier, {
        issuer: this.issuer,
        audience: MULTIPLAYER_AUDIENCE,
        algorithms: keys.algorithms,
        clockTolerance: CLOCK_LEEWAY_S,
        currentDate: new Date(now),
        requiredClaims: ["exp"],
      }));
    } catch {
      return null;
    }
    const { xid, xname, cpk } = payload;
    if (typeof xid !== "string" || !XUID.test(xid)) return null;
    if (typeof xname !== "string" || xname.length === 0 || xname.length > MAX_DISPLAY_NAME) return null;
    if (typeof cpk !== "string" || !(await importClientKey(cpk))) return null;
    return { xuid: xid, displayName: xname, cpk };
  }

  /** Reuses cached keys or one shared refresh, throttling failed attempts as well as successful ones. */
  private async keysFor(kid: string | undefined, now: number): Promise<KeySet> {
    const keys = this.keys;
    const stale = !keys || now - keys.fetchedAt >= KEYS_MAX_AGE_MS;
    const unknownKid = keys && kid !== undefined && !keys.kids.has(kid);
    if (!stale && !unknownKid) return keys!;
    if (!this.refreshing) {
      if (now - this.lastRefreshAt < JWKS_REFETCH_INTERVAL_MS) {
        if (keys) return keys;
        throw new IssuerUnavailable("refresh throttled");
      }
      this.lastRefreshAt = now;
      this.refreshing = this.boundedRefresh(now).finally(() => (this.refreshing = undefined));
    }
    try {
      return (this.keys = await this.refreshing);
    } catch (err) {
      if (keys) return keys; // keep verifying with the last good keys while the issuer is unreachable
      throw err;
    }
  }

  /** Fetches fresh keys, rejecting with IssuerUnavailable once the deadline passes even if the peer never answers. */
  private boundedRefresh(now: number): Promise<KeySet> {
    const signal = this.refreshDeadline();
    const expired = new Promise<never>((_, reject) => {
      const fail = () => reject(new IssuerUnavailable("refresh timed out"));
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    });
    return Promise.race([this.fetchKeys(now, signal), expired]);
  }

  private async fetchKeys(now: number, signal: AbortSignal): Promise<KeySet> {
    const config = await this.fetchJson(`${this.issuer}.well-known/openid-configuration`, signal);
    if (canonicalIssuer(String(config.issuer)) !== this.issuer) throw new IssuerUnavailable("issuer mismatch");
    const jwksUri = config.jwks_uri;
    if (typeof jwksUri !== "string" || !jwksUri.startsWith("https://")) throw new IssuerUnavailable("bad jwks_uri");
    const jwks = (await this.fetchJson(jwksUri, signal)) as unknown as JSONWebKeySet;
    if (!Array.isArray(jwks.keys)) throw new IssuerUnavailable("bad jwks");
    const advertised = config.id_token_signing_alg_values_supported;
    const algorithms = Array.isArray(advertised) ? ASYMMETRIC_ALGS.filter((a) => advertised.includes(a)) : ["RS256"];
    return {
      verifier: createLocalJWKSet(jwks),
      kids: new Set(jwks.keys.flatMap((k) => (typeof k.kid === "string" ? [k.kid] : []))),
      algorithms: algorithms.length > 0 ? algorithms : ["RS256"],
      fetchedAt: now,
    };
  }

  private async fetchJson(url: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.fetcher(url, { headers: { Accept: "application/json" }, signal });
    } catch {
      throw new IssuerUnavailable("fetch failed");
    }
    if (!res.ok) throw new IssuerUnavailable(`status ${res.status}`);
    const body: unknown = await res.json().catch(() => null);
    if (typeof body !== "object" || body === null) throw new IssuerUnavailable("bad json");
    return body as Record<string, unknown>;
  }
}

const issuers = new Map<string, IssuerKeys>();

/** Returns the isolate-wide key cache for `issuer`. */
export function issuerKeys(issuer: string): IssuerKeys {
  const key = canonicalIssuer(issuer);
  let keys = issuers.get(key);
  if (!keys) issuers.set(key, (keys = new IssuerKeys(key)));
  return keys;
}

/** Returns true when `signature` (base64url raw r||s) is the cpk key's ES384 signature over the proof context and nonce. */
export async function verifyProof(cpk: string, nonce: string, signature: string): Promise<boolean> {
  const key = await importClientKey(cpk);
  const sig = decodeBase64(signature, true);
  if (!key || !sig || sig.length !== 96) return false;
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-384" },
    key,
    sig,
    new TextEncoder().encode(PROOF_CONTEXT + nonce),
  );
}

async function importClientKey(cpk: string): Promise<CryptoKey | null> {
  const der = decodeBase64(cpk, false);
  if (!der) return null;
  try {
    return await crypto.subtle.importKey("spki", der, { name: "ECDSA", namedCurve: "P-384" }, false, ["verify"]);
  } catch {
    return null;
  }
}

/** Decodes standard or (when `url`) base64url text, padding optional; null when malformed. */
export function decodeBase64(text: string, url: boolean): Uint8Array<ArrayBuffer> | null {
  const alphabet = url ? /^[A-Za-z0-9_-]*$/ : /^[A-Za-z0-9+/]*={0,2}$/;
  if (!alphabet.test(text)) return null;
  let std = url ? text.replaceAll("-", "+").replaceAll("_", "/") : text.replace(/=+$/, "");
  if (std.length % 4 === 1) return null;
  std += "=".repeat((4 - (std.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(std), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
