import { describe, expect, it } from "vitest";
import { CHANNELS, compareVersions, decodeClientMessage } from "../src/protocol";

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
