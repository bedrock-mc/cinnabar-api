import { Validator, type Schema } from "@cfworker/json-schema";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import schemaJson from "../schema/v1.json";
import { FEATURED_SERVERS, type FeaturedServer } from "../src/featured";

const schema = schemaJson as unknown as Schema & { $id: string };
const featuredResponse = new Validator({ $ref: `${schema.$id}#/$defs/FeaturedResponse` }, "2020-12");
featuredResponse.addSchema(schema);
const SERVER_FIELDS = new Set(Object.keys(schemaJson.$defs.FeaturedServer.properties));

/** Lists every way `servers` breaks the featured contract, including what the schema cannot express. */
function featuredProblems(servers: readonly FeaturedServer[]): string[] {
  const problems = featuredResponse.validate({ servers }).errors.map((e) => `${e.instanceLocation}: ${e.error}`);
  const ids = new Set<string>();
  servers.forEach((server, i) => {
    for (const key of Object.keys(server)) if (!SERVER_FIELDS.has(key)) problems.push(`${i}: unknown field ${key}`);
    if (ids.has(server.id)) problems.push(`${i}: duplicate id ${server.id}`);
    ids.add(server.id);
    if (server.imageUrl !== undefined && !URL.canParse(server.imageUrl)) problems.push(`${i}: unparsable imageUrl`);
  });
  return problems;
}

describe("featured source", () => {
  it("satisfies the contract", () => {
    expect(featuredProblems(FEATURED_SERVERS)).toEqual([]);
  });

  const host: FeaturedServer = { id: "a", name: "A", address: "play.example.com", port: 19132 };

  it("accepts every optional field, IPv4 hosts and experience ids", () => {
    const full: FeaturedServer = {
      ...host,
      description: "d",
      imageUrl: "https://example.com/a.png",
      motd: "m",
      tags: ["pvp", "survival"],
    };
    const ipv4: FeaturedServer = { ...host, id: "b", address: "203.0.113.7" };
    const experience: FeaturedServer = { ...host, id: "c", address: "0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d", port: 0 };
    expect(featuredProblems([full, ipv4, experience])).toEqual([]);
  });

  it.each<[string, FeaturedServer[], RegExp]>([
    ["host with a port suffix", [{ ...host, address: "play.example.com:19132" }], /servers\/0\/address:/],
    ["host with a scheme", [{ ...host, address: "https://play.example.com" }], /servers\/0\/address:/],
    ["dotted experience id", [{ ...host, port: 0 }], /servers\/0\/address:/],
    ["port above 65535", [{ ...host, port: 65536 }], /servers\/0\/port:/],
    ["fractional port", [{ ...host, port: 1.5 }], /servers\/0\/port:/],
    ["http image", [{ ...host, imageUrl: "http://example.com/a.png" }], /servers\/0\/imageUrl:/],
    ["duplicate tag", [{ ...host, tags: ["pvp", "pvp"] }], /servers\/0\/tags:/],
    ["snake_case field", [{ ...host, image_url: "https://example.com/a.png" } as FeaturedServer], /0: unknown field/],
    ["duplicate id", [host, { ...host }], /1: duplicate id/],
    ["more than 24 servers", Array.from({ length: 25 }, (_, i) => ({ ...host, id: `s${i}` })), /#\/servers:/],
  ])("rejects a %s", (_, servers, problem) => {
    expect(featuredProblems(servers).join("\n")).toMatch(problem);
  });
});

describe("GET /v1/featured", () => {
  it("serves the static servers as cacheable JSON without waking the Hub", async () => {
    const idFromName = vi.spyOn(env.HUB, "idFromName");
    try {
      const res = await exports.default.fetch("https://api.test/v1/featured");
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toMatch(/^application\/json\b/);
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
      const body = await res.json();
      expect(body).toEqual({ servers: FEATURED_SERVERS });
      expect(featuredResponse.validate(body).valid).toBe(true);
      expect(idFromName).not.toHaveBeenCalled();
    } finally {
      idFromName.mockRestore();
    }
  });

  it("answers 404 to other methods", async () => {
    expect((await exports.default.fetch("https://api.test/v1/featured", { method: "POST" })).status).toBe(404);
  });
});
