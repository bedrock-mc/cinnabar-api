import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { hubFor } from "../src/routing";

it("hints the global hub into Western Europe", () => {
  const get = vi.spyOn(env.HUB, "get");
  try {
    hubFor(env);
    expect(get).toHaveBeenCalledWith(env.HUB.idFromName("global"), { locationHint: "weur" });
  } finally {
    get.mockRestore();
  }
});
