import type { Hub } from "./hub";

/** Returns the Hub that owns presence and releases; sharding the Hub only changes this function. */
export function hubFor(env: Env): DurableObjectStub<Hub> {
  return env.HUB.get(env.HUB.idFromName("global"));
}
