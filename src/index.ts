import { catalogResponse, assetResponse } from "./cosmetics";
import { Hono } from "hono";
import { isReleaseHookRequest } from "./protocol";
import { hubFor } from "./routing";

export { Hub } from "./hub";

const MAX_HOOK_BODY_BYTES = 1024;

const app = new Hono<{ Bindings: Env }>();

app.get("/v1/health", (c) => c.json({ ok: true, api: "v1" }));

app.get("/v1/cosmetics/catalog", (c) => catalogResponse(c.req.raw));
app.get("/v1/cosmetics/assets/:hash", (c) => assetResponse(c.req.param("hash"), c.env.COSMETIC_ASSETS));

app.post("/v1/releases", async (c) => {
  if (!(await bearerMatches(c.req.header("Authorization"), c.env.RELEASE_HOOK_SECRET))) return c.body(null, 401);
  const declared = Number(c.req.header("Content-Length") ?? 0);
  if (!(declared <= MAX_HOOK_BODY_BYTES)) return c.body(null, 400);
  const text = await readBounded(c.req.raw.body, MAX_HOOK_BODY_BYTES);
  if (text === null) return c.body(null, 400);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return c.body(null, 400);
  }
  if (!isReleaseHookRequest(body)) return c.body(null, 400);
  await hubFor(c.env).recordRelease(body.channel, body.version, body.build);
  return c.body(null, 204);
});

app.get("/v1/connect", (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") return c.body(null, 426, { Upgrade: "websocket" });
  return hubFor(c.env).fetch(c.req.raw);
});

/** Reads the body as UTF-8, or returns null (cancelling the stream) once it passes `max` bytes. */
async function readBounded(stream: ReadableStream<Uint8Array> | null, max: number): Promise<string | null> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Compares the bearer token with the secret in constant time via fixed-length digests; false when the secret is unset. */
async function bearerMatches(header: string | undefined, secret: string | undefined): Promise<boolean> {
  if (!secret) return false;
  const presented = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(secret)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

export default app;
