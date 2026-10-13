import { Validator, type Schema } from "@cfworker/json-schema";
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey as JoseKey } from "jose";
import { env, exports } from "cloudflare:workers";
import { expect, vi } from "vitest";
import schemaJson from "../schema/v1.json";
import { encodeBase64Url } from "../src/identity";
import { hubFor } from "../src/routing";

export const ISSUER = "https://issuer.test/";
export const AUDIENCE = "api://auth-minecraft-services/multiplayer";
export const HOOK_SECRET = "test-hook-secret";
const KID = "test-kid";

const schema = schemaJson as unknown as Schema & { $id: string };
const serverMessage = new Validator({ $ref: `${schema.$id}#/$defs/ServerMessage` }, "2020-12");
serverMessage.addSchema(schema);

/** The fake authorization service: a signing key and the discovery documents that publish it. */
export interface FakeIssuer {
  signingKey: JoseKey;
  fetches: string[];
}

const issuerKeyPair = await generateKeyPair("RS256", { extractable: true });
const issuerJwk = { ...(await exportJWK(issuerKeyPair.publicKey)), kid: KID, alg: "RS256", use: "sig" };
export const issuer: FakeIssuer = { signingKey: issuerKeyPair.privateKey, fetches: [] };

/** Serves the fake issuer's discovery documents to the Worker's outbound fetch. */
export function installFakeIssuer(): void {
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `${ISSUER}.well-known/openid-configuration`) {
      issuer.fetches.push(url);
      return Response.json({
        issuer: ISSUER,
        jwks_uri: `${ISSUER}keys`,
        id_token_signing_alg_values_supported: ["RS256"],
      });
    }
    if (url === `${ISSUER}keys`) {
      issuer.fetches.push(url);
      return Response.json({ keys: [issuerJwk] });
    }
    return realFetch(input, init);
  });
}

export interface ClientKey {
  privateKey: CryptoKey;
  cpk: string;
}

export async function clientKey(): Promise<ClientKey> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-384" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const spki = new Uint8Array((await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer);
  return { privateKey: pair.privateKey, cpk: btoa(String.fromCharCode(...spki)) };
}

export interface TokenOptions {
  xid?: string;
  xname?: string;
  cpk: string;
  iss?: string;
  aud?: string | string[];
  exp?: number; // seconds since epoch
  nbf?: number;
  key?: JoseKey;
  kid?: string;
}

export async function mintToken(o: TokenOptions): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ xid: o.xid ?? "2535400000000001", xname: o.xname ?? "Steve", cpk: o.cpk })
    .setProtectedHeader({ alg: "RS256", kid: o.kid ?? KID })
    .setIssuer(o.iss ?? ISSUER)
    .setAudience(o.aud ?? AUDIENCE)
    .setIssuedAt(now)
    .setNotBefore(o.nbf ?? now)
    .setExpirationTime(o.exp ?? now + 3600)
    .sign(o.key ?? issuer.signingKey);
}

export async function sign(key: ClientKey, nonce: string): Promise<string> {
  const data = new TextEncoder().encode(`cinnabar-api/v1/auth:${nonce}`);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-384" }, key.privateKey, data);
  return encodeBase64Url(new Uint8Array(sig as ArrayBuffer));
}

type Message = Record<string, unknown> & { type: string };

/** A test WebSocket client; every server message it receives is checked against schema/v1.json. */
export class Client {
  private readonly queue: Message[] = [];
  private readonly waiters: ((m: Message) => void)[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;

  constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const data = event.data as string;
      const message = data === "pong" ? { type: "pong" } : (JSON.parse(data) as Message);
      if (data !== "pong") expect(serverMessage.validate(message).valid, data).toBe(true);
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.queue.push(message);
    });
    this.closed = new Promise((resolve) => {
      ws.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }));
    });
    ws.accept();
  }

  next(): Promise<Message> {
    const queued = this.queue.shift();
    return queued ? Promise.resolve(queued) : new Promise((resolve) => this.waiters.push(resolve));
  }

  send(value: unknown): void {
    this.ws.send(typeof value === "string" ? value : JSON.stringify(value));
  }

  close(): void {
    try {
      this.ws.close(1000);
    } catch {
      // already closed
    }
  }

  /** Sends a lookup and returns its result message. */
  async lookup(xuids: string[], id = 1): Promise<Message> {
    this.send({ type: "lookup", id, xuids });
    return this.next();
  }
}

export async function connect(): Promise<Client> {
  const res = await exports.default.fetch("https://api.test/v1/connect", { headers: { Upgrade: "websocket" } });
  expect(res.status).toBe(101);
  return new Client(res.webSocket!);
}

export interface Login {
  xuid?: string;
  xname?: string;
  channel?: string;
  visible?: boolean;
  clientVersion?: string;
}

export function hello(token: string, o: Login = {}) {
  return {
    type: "hello",
    protocol: 1,
    client_version: o.clientVersion ?? "0.1.18",
    channel: o.channel ?? "beta",
    visible: o.visible ?? true,
    token,
  };
}

/** Connects and completes the handshake, returning the client and its welcome message. */
export async function login(o: Login = {}): Promise<{ client: Client; welcome: Message }> {
  const key = await clientKey();
  const client = await connect();
  client.send(hello(await mintToken({ cpk: key.cpk, xid: o.xuid, xname: o.xname }), o));
  const challenge = await client.next();
  expect(challenge.type).toBe("challenge");
  client.send({ type: "proof", signature: await sign(key, challenge.nonce as string) });
  const welcome = await client.next();
  expect(welcome.type).toBe("welcome");
  return { client, welcome };
}

export function postRelease(body: unknown, secret: string | null = HOOK_SECRET): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers.Authorization = `Bearer ${secret}`;
  return exports.default.fetch("https://api.test/v1/releases", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export const hub = () => hubFor(env);
