/** One launcher featured server; schema/v1.json `FeaturedServer` is the contract. */
export interface FeaturedServer {
  id: string;
  name: string;
  address: string; // host name, or an experience id when port is 0
  port: number;
  description?: string;
  imageUrl?: string;
  motd?: string;
  tags?: string[];
}

/** Editorial source for GET /v1/featured; test/featured.test.ts checks it against the schema. */
export const FEATURED_SERVERS: readonly FeaturedServer[] = [];
