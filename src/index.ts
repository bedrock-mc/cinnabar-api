import { Hono } from "hono";
import { isChannel, isReleaseHookRequest } from "./protocol";
import { hubFor } from "./routing";

export { Hub } from "./hub";

const MAX_HOOK_BODY_BYTES = 1024;

const app = new Hono<{ Bindings: Env }>();

app.get("/v1/health", (c) => c.json({ ok: true, api: "v1" }));

app.get("/v1/releases/latest", async (c) => {
  const channel = c.req.query("channel");
  if (!isChannel(channel)) return c.body(null, 400);
  const record = await hubFor(c.env).latestRelease(channel);
  return record ? c.json(record) : c.body(null, 404);
});

app.post("/v1/releases", async (c) => {
  if (!(await bearerMatches(c.req.header("Authorization"), c.env.RELEASE_HOOK_SECRET))) return c.body(null, 401);
  const text = await c.req.text();
  if (text.length > MAX_HOOK_BODY_BYTES) return c.body(null, 400);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return c.body(null, 400);
  }
  if (!isReleaseHookRequest(body)) return c.body(null, 400);
  await hubFor(c.env).recordRelease(body.channel, body.version);
  return c.body(null, 204);
});

app.get("/v1/connect", (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") return c.body(null, 426, { Upgrade: "websocket" });
  return hubFor(c.env).fetch(c.req.raw);
});

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
