import { describe, expect, it } from "vitest";
import { CHANNELS, Close, compareVersions, decodeClientMessage, isReleaseHookRequest } from "../src/protocol";

describe("versions", () => {
  it.each([
    ["0.1.18", "0.1.19"],
    ["0.1.19", "0.2.0"],
    ["0.9.0", "0.10.0"],
    ["1.0.0-beta", "1.0.0"],
    ["1.0.0-alpha", "1.0.0-alpha.1"],
    ["1.0.0-alpha.1", "1.0.0-alpha.beta"],
    ["1.0.0-beta.2", "1.0.0-beta.11"],
    ["1.0.0-rc.1", "1.0.0"],
    ["18446744073709551615.0.0", "18446744073709551616.0.0"],
  ])("orders %s before %s", (older, newer) => {
    expect(compareVersions(older, newer)).toBeLessThan(0);
    expect(compareVersions(newer, older)).toBeGreaterThan(0);
  });

  it("treats equal versions as equal", () => {
    expect(compareVersions("0.1.18-nightly.3", "0.1.18-nightly.3")).toBe(0);
  });
});

describe("decoding", () => {
  const uuid = "058728db-7a88-3a63-af82-7174a02a2e35";

  it.each([
    {}, { xuids: [] }, { uuids: [] }, { xuids: [], uuids: [] },
    { xuids: ["1"] }, { uuids: [uuid] }, { xuids: [], uuids: [uuid] },
    { xuids: ["1"], uuids: [] }, { xuids: ["1"], uuids: [uuid] },
    { xuids: Array(64).fill("1"), uuids: Array(64).fill(uuid) },
    { uuids: Array(128).fill(uuid) },
  ])("accepts lookup identifiers %#", (identifiers) => {
    expect(decodeClientMessage(JSON.stringify({ type: "lookup", id: 1, ...identifiers })).kind).toBe("message");
  });

  it.each([
    { uuids: [uuid.toUpperCase()] }, { uuids: [uuid.replaceAll("-", "")] },
    { uuids: [uuid.replace("0", "g")] }, { uuids: [""] }, { uuids: [1] },
    { xuids: ["1"], uuids: null }, { xuids: null, uuids: [uuid] },
    { xuids: Array(64).fill("1"), uuids: Array(65).fill(uuid) },
    { uuids: Array(129).fill(uuid) },
  ])("rejects invalid lookup identifiers %#", (identifiers) => {
    expect(decodeClientMessage(JSON.stringify({ type: "lookup", id: 1, ...identifiers })).kind).toBe("invalid");
  });

  it("reads the channel enum from the schema", () => {
    expect(CHANNELS).toEqual(["stable", "beta", "nightly"]);
  });

  it("classifies frames", () => {
    expect(decodeClientMessage("[]").kind).toBe("malformed");
    expect(decodeClientMessage('{"type":7}').kind).toBe("malformed");
    expect(decodeClientMessage('{"type":"toString"}').kind).toBe("unknown");
    expect(decodeClientMessage('{"type":"visibility"}').kind).toBe("invalid");
    expect(decodeClientMessage('{"type":"visibility","visible":false,"x":1}')).toEqual({
      kind: "message",
      message: { type: "visibility", visible: false, x: 1 },
    });
  });

  it("requires protocol 1 in hello", () => {
    const hello = { type: "hello", client_version: "0.1.18", channel: "beta", visible: true, token: "a.b.c" };
    expect(decodeClientMessage(JSON.stringify({ ...hello, protocol: 1 })).kind).toBe("message");
    expect(decodeClientMessage(JSON.stringify({ ...hello, protocol: 2 })).kind).toBe("invalid");
  });
});


describe("v1 additions", () => {
  it("accepts optional nonnegative integer client builds and rejects invalid builds", () => {
    const hello = { type: "hello", protocol: 1, client_version: "0.1.18", channel: "beta", visible: true, token: "a.b.c" };
    for (const client_build of [undefined, 0, 123]) {
      expect(decodeClientMessage(JSON.stringify({ ...hello, client_build })).kind).toBe("message");
    }
    for (const client_build of [-1, 1.5, "123", null]) {
      expect(decodeClientMessage(JSON.stringify({ ...hello, client_build })).kind).toBe("invalid");
    }
  });

  it("accepts optional release builds and rejects invalid builds", () => {
    const record = { channel: "nightly", version: "0.2.0" };
    expect(isReleaseHookRequest(record)).toBe(true);
    expect(isReleaseHookRequest({ ...record, build: 123 })).toBe(true);
    for (const build of [-1, 1.5, "123", null]) expect(isReleaseHookRequest({ ...record, build })).toBe(false);
  });

  it("defines the stay-away close code", () => {
    expect(Close.stayAway).toBe(4429);
  });
});
