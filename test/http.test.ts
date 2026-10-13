import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { postRelease } from "./helpers";

const get = (path: string, init?: RequestInit) => exports.default.fetch(`https://api.test${path}`, init);

describe("HTTP routes", () => {
  it("reports health", async () => {
    const res = await get("/v1/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, api: "v1" });
  });

  it("returns 404 for a channel with no recorded release", async () => {
    expect((await get("/v1/releases/latest?channel=stable")).status).toBe(404);
  });

  it("rejects a missing or unknown channel", async () => {
    expect((await get("/v1/releases/latest")).status).toBe(400);
    expect((await get("/v1/releases/latest?channel=alpha")).status).toBe(400);
  });

  it("records a release and serves it as the channel's latest", async () => {
    expect((await postRelease({ channel: "nightly", version: "0.1.19-nightly.20261013" })).status).toBe(204);
    const res = await get("/v1/releases/latest?channel=nightly");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string>;
    expect(body).toMatchObject({ channel: "nightly", version: "0.1.19-nightly.20261013" });
    expect(Date.parse(body.published_at!)).not.toBeNaN();
    expect((await get("/v1/releases/latest?channel=beta")).status).toBe(404);
  });

  it("answers 426 to a non-upgrade connect", async () => {
    const res = await get("/v1/connect");
    expect(res.status).toBe(426);
    expect(res.headers.get("Upgrade")).toBe("websocket");
  });
});

describe("release hook auth", () => {
  const valid = { channel: "beta", version: "0.2.0" };

  it("rejects a missing, malformed or wrong secret with 401", async () => {
    expect((await postRelease(valid, null)).status).toBe(401);
    expect((await postRelease(valid, "wrong")).status).toBe(401);
    expect((await postRelease(valid, "test-hook-secret-but-longer")).status).toBe(401);
    const basic = await exports.default.fetch("https://api.test/v1/releases", {
      method: "POST",
      headers: { Authorization: "Basic test-hook-secret" },
      body: JSON.stringify(valid),
    });
    expect(basic.status).toBe(401);
  });

  it("checks the secret before the body", async () => {
    expect((await postRelease("not json", "wrong")).status).toBe(401);
  });

  it.each([
    ["non-JSON", "{"],
    ["unknown channel", { channel: "alpha", version: "0.2.0" }],
    ["missing version", { channel: "beta" }],
    ["bad version", { channel: "beta", version: "v0.2.0" }],
    ["build metadata", { channel: "beta", version: "0.2.0+abc" }],
    ["version over 64 chars", { channel: "beta", version: `1.0.0-${"a".repeat(59)}` }],
    ["array body", [valid]],
  ])("rejects %s with 400", async (_, body) => {
    expect((await postRelease(body)).status).toBe(400);
  });

  it("accepts a 64-char prerelease version", async () => {
    expect((await postRelease({ channel: "beta", version: `1.0.0-${"a".repeat(58)}` })).status).toBe(204);
  });

  it("rejects an oversized declared Content-Length with 400", async () => {
    const res = await postRelease(JSON.stringify({ channel: "beta", version: "0.2.0", pad: "x".repeat(2048) }));
    expect(res.status).toBe(400);
  });

  it("stops reading a streamed oversized body soon after 1 KiB and answers 400", async () => {
    const total = 8 * 1024 * 1024;
    const chunk = new Uint8Array(1024).fill(0x20);
    let produced = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (produced >= total) return controller.close();
          produced += chunk.length;
          controller.enqueue(chunk);
        },
      },
      { highWaterMark: 0 },
    );
    const res = await exports.default.fetch("https://api.test/v1/releases", {
      method: "POST",
      headers: { Authorization: "Bearer test-hook-secret" },
      body,
    });
    expect(res.status).toBe(400);
    expect(produced).toBeLessThan(64 * 1024);
  });
});
