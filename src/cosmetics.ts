import catalogJson from "./catalog.json";
import schema from "../schema/v1.json";

export const catalog = catalogJson;
export type Item = typeof catalog.items[number];
const slots = new Set<string>(schema.$defs.CosmeticSlot["x-known-slots"]);

/** Ignores unsupported content and rejects a whole loadout for wrong-slot or unowned known items. */
export function admitLoadout(
  requested: Record<string, string | null>, owns: (id: string) => boolean, items: readonly Item[] = catalog.items,
): Record<string, string | null> | null {
  const result: Record<string, string | null> = {};
  for (const [slot, id] of Object.entries(requested)) {
    if (!slots.has(slot)) continue;
    if (id === null) { result[slot] = null; continue; }
    const item = items.find((item) => item.id === id);
    if (!item) continue;
    if (item.slot !== slot || (!item.free && !owns(id))) return null;
    result[slot] = id;
  }
  return result;
}

/** Serves a versioned catalog whose ETag binds every item and asset digest. */
export async function catalogResponse(request: Request): Promise<Response> {
  const body = JSON.stringify(catalog);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
  const etag = `"${Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("")}"`;
  const headers = { ETag: etag, "Cache-Control": "public, max-age=300", "Content-Type": "application/json" };
  const matches = request.headers.get("If-None-Match")?.split(",").some((value) => value.trim().replace(/^W\//, "") === etag || value.trim() === "*");
  return new Response(matches ? null : body, { status: matches ? 304 : 200, headers });
}

/** Streams only reviewed, catalog-addressed R2 objects; clients verify the declared digest and size. */
export async function assetResponse(hash: string, bucket: R2Bucket): Promise<Response> {
  const assets = catalog.items.flatMap((item) => Object.entries(item.assets).map(([kind, asset]) => ({ kind, asset, license: item.license })));
  const entry = assets.find(({ asset }) => asset.sha256 === hash);
  if (!entry) return new Response(null, { status: 404 });
  const object = await bucket.get(hash);
  if (!object || object.size !== entry.asset.bytes) return new Response(null, { status: 404 });
  return new Response(object.body, { headers: {
    "Content-Type": entry.kind === "texture" ? "image/png" : "application/json",
    "Cache-Control": "public, max-age=31536000, immutable", ETag: `"${hash}"`,
    "X-Content-Type-Options": "nosniff", Link: `<${entry.license}>; rel="license"`,
  } });
}
