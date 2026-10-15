/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import configText from "../wrangler.jsonc?raw";

describe("deployment config", () => {
  it("pins the Cloudflare account", () => {
    const config = JSON.parse(configText.replace(/^\s*\/\/.*$/gm, ""));
    expect(config.account_id).toBe("a16be1f911ae0c715166f97c4af654eb");
  });
});
