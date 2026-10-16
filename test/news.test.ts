import { Validator, type Schema } from "@cfworker/json-schema";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import schemaJson from "../schema/v1.json";
import { NEWS_ITEMS, type NewsItem } from "../src/news";

const schema = schemaJson as unknown as Schema & { $id: string };
const newsResponse = new Validator({ $ref: `${schema.$id}#/$defs/NewsResponse` }, "2020-12");
newsResponse.addSchema(schema);
const ITEM_FIELDS = new Set(Object.keys(schemaJson.$defs.NewsItem.properties));

/** Lists every way `items` breaks the news contract beyond what the schema can express. */
function newsProblems(items: readonly NewsItem[]): string[] {
  const problems = newsResponse.validate({ items }).errors.map((e) => `${e.instanceLocation}: ${e.error}`);
  const ids = new Set<string>();
  items.forEach((item, i) => {
    for (const key of Object.keys(item)) if (!ITEM_FIELDS.has(key)) problems.push(`${i}: unknown field ${key}`);
    if (ids.has(item.id)) problems.push(`${i}: duplicate id ${item.id}`);
    ids.add(item.id);
    for (const url of [item.url, item.imageUrl]) {
      if (url !== undefined && !URL.canParse(url)) problems.push(`${i}: unparsable URL ${url}`);
    }
    const time = Date.parse(item.publishedAt);
    if (Number.isNaN(time) || new Date(time).toISOString().replace(".000Z", "Z") !== item.publishedAt) {
      problems.push(`${i}: invalid publishedAt ${item.publishedAt}`);
    }
    const previous = items[i - 1];
    if (previous && Date.parse(previous.publishedAt) < time) problems.push(`${i}: newer than the item before it`);
  });
  return problems;
}

describe("news source", () => {
  it("satisfies the contract", () => {
    expect(NEWS_ITEMS.length).toBeGreaterThan(0);
    expect(newsProblems(NEWS_ITEMS)).toEqual([]);
  });

  const good: NewsItem = {
    id: "a",
    title: "t",
    summary: "s",
    url: "https://example.com/a",
    publishedAt: "2026-10-16T00:00:00Z",
  };

  it("accepts an https hero image", () => {
    expect(newsProblems([{ ...good, imageUrl: "https://example.com/hero.png" }])).toEqual([]);
  });

  it.each<[string, NewsItem[], RegExp]>([
    ["http URL", [{ ...good, url: "http://example.com/a" }], /items\/0\/url:/],
    ["http image", [{ ...good, imageUrl: "http://example.com/a.png" }], /items\/0\/imageUrl:/],
    ["millisecond date", [{ ...good, publishedAt: "2026-10-16T00:00:00.000Z" }], /items\/0\/publishedAt:/],
    ["offset date", [{ ...good, publishedAt: "2026-10-16T00:00:00+01:00" }], /items\/0\/publishedAt:/],
    ["impossible date", [{ ...good, publishedAt: "2026-02-30T00:00:00Z" }], /0: invalid publishedAt/],
    ["snake_case field", [{ ...good, image_url: "https://example.com/a.png" } as NewsItem], /0: unknown field/],
    ["duplicate id", [good, { ...good }], /1: duplicate id/],
    ["oldest first", [good, { ...good, id: "b", publishedAt: "2026-10-17T00:00:00Z" }], /1: newer than/],
    ["more than 20 items", Array.from({ length: 21 }, (_, i) => ({ ...good, id: `n${i}` })), /#\/items:/],
  ])("rejects a %s", (_, items, problem) => {
    expect(newsProblems(items).join("\n")).toMatch(problem);
  });
});

describe("GET /v1/news", () => {
  it("serves the static items as cacheable JSON without waking the Hub", async () => {
    const idFromName = vi.spyOn(env.HUB, "idFromName");
    try {
      const res = await exports.default.fetch("https://api.test/v1/news");
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toMatch(/^application\/json\b/);
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
      const body = await res.json();
      expect(body).toEqual({ items: NEWS_ITEMS });
      expect(newsResponse.validate(body).valid).toBe(true);
      expect(idFromName).not.toHaveBeenCalled();
    } finally {
      idFromName.mockRestore();
    }
  });

  it("answers 404 to other methods", async () => {
    expect((await exports.default.fetch("https://api.test/v1/news", { method: "POST" })).status).toBe(404);
  });
});
