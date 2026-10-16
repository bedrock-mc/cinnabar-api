/** One launcher home-screen entry; schema/v1.json `NewsItem` is the contract. */
export interface NewsItem {
  id: string;
  title: string;
  summary: string;
  url: string;
  imageUrl?: string;
  publishedAt: string;
  tag?: string;
}

/** Editorial source for GET /v1/news, newest first; test/news.test.ts checks it against the schema. */
export const NEWS_ITEMS: readonly NewsItem[] = [
  {
    id: "launcher-in-development",
    title: "The Cinnabar launcher is in development",
    summary: "A desktop launcher for Cinnabar is in development. Cinnabar builds are published on GitHub Releases.",
    url: "https://github.com/bedrock-mc/cinnabar/releases",
    publishedAt: "2026-10-16T00:00:00Z",
    tag: "announcement",
  },
];
