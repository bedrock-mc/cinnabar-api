// Uploads catalog assets that are missing from the cosmetics bucket; existing keys are immutable digests.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { experimental_readRawConfig } from "wrangler";

const directory = "assets/cosmetics";
const { rawConfig } = experimental_readRawConfig({ config: "wrangler.jsonc" });
const bucket = rawConfig.r2_buckets.find(({ binding }) => binding === "COSMETIC_ASSETS").bucket_name;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) throw new Error("CLOUDFLARE_API_TOKEN is not set");

const existing = new Set();
let cursor;
do {
  const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${rawConfig.account_id}/r2/buckets/${bucket}/objects`);
  url.searchParams.set("per_page", "1000");
  if (cursor) url.searchParams.set("cursor", cursor);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`listing ${bucket} failed: HTTP ${response.status}`);
  const body = await response.json();
  for (const { key } of body.result) existing.add(key);
  cursor = body.result_info?.is_truncated ? body.result_info.cursor : undefined;
} while (cursor);

const missing = readdirSync(directory).filter((name) => !existing.has(name));
for (const name of missing) {
  const file = join(directory, name);
  const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (digest !== name) throw new Error(`${file} hashes to ${digest}`);
  execFileSync("npx", ["wrangler", "r2", "object", "put", `${bucket}/${name}`, "--file", file, "--remote"], { stdio: "inherit" });
}
console.log(`uploaded ${missing.length} of ${readdirSync(directory).length} cosmetic assets`);
