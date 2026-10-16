# cinnabar-api

The Cinnabar client's API: release notifications, player presence, launcher news and featured servers, as a
Cloudflare Worker (Hono) with one Durable Object. [`schema/v1.json`](schema/v1.json) is the machine-readable
contract (JSON Schema for every HTTP body and WebSocket message); the server validates inbound
messages against it.

## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /v1/health` | `{"ok":true,"api":"v1"}` |
| `GET /v1/news` | Launcher home-screen news, `{"items":[{"id","title","summary","url","imageUrl"?,"publishedAt","tag"?}]}`, newest first, at most 20. URLs are `https`; `publishedAt` is RFC 3339 UTC to the second. `Cache-Control: public, max-age=300`. Items live in [`src/news.ts`](src/news.ts) and ship with each deploy. |
| `GET /v1/featured` | Launcher featured servers, `{"servers":[{"id","name","address","port","description"?,"imageUrl"?,"motd"?,"tags"?}]}`, at most 24. `address` is a host name, or an experience id when `port` is 0. Same caching and source rules as news, from [`src/featured.ts`](src/featured.ts). |
| `POST /v1/releases` | Release hook. `Authorization: Bearer <RELEASE_HOOK_SECRET>`, body `{"channel","version","build"}`; records and broadcasts only a newer (version, build) pair. Repeats and older records are no-ops. Omitted v1 builds mean zero. |
| `GET /v1/connect` | WebSocket. The client authenticates with a Minecraft multiplayer token plus an ES384 proof of its key, then can toggle visibility, look up which XUIDs or UUIDs recently used Cinnabar, and receives release pushes. |

Close codes: `4401` failed or timed-out authentication, `1009` frame over 16 KiB, `1007` frame
that isn't a JSON object with a `type`, `1008` invalid messages, binary frames, flood control or
repeated lookup rate limiting, and `1011` issuer unreachable. `4429` means stay away: its reason
is `retry_after=<seconds>`. Clients wait at least that long plus jitter before reconnecting,
and honour HTTP 429 `Retry-After` on dial. Unknown fields are ignored; unknown message types
are ignored after authentication. During the handshake only the expected message is accepted.
The text frame `ping` gets `pong` without waking the Hub.

- Connections: at most 20,000 per Hub, including closing sockets; at most 8 pending handshakes
  per IPv4 address or IPv6 /64, and at most 4 ready sockets per XUID. Ready sockets do not count
  toward the IP cap. Excess upgrades receive HTTP 429 with `Retry-After: 10`; excess account
  sockets close with `4429` and `retry_after=10`.
- Flood control: at most 30 non-ping frames and 64 KiB of text in each 10-second socket window,
  including hello and proof. After 3 refused lookups, the socket closes with `1008`.
- Lookups: optional `xuids` and `uuids` arrays hold at most 128 identifiers combined; an empty
  lookup gets an empty result. UUIDs use lowercase hyphenated form. Batches
  share an account bucket of 1,024 tokens, refilling 512 per minute. Each unique requested
  identifier in each array costs one token, including negative answers.
  Reconnecting or opening another socket does not reset the bucket.
  Results contain `cinnabar` XUID matches and, when UUIDs were requested, `cinnabar_uuids` UUID
  matches. Each result array contains only identifiers from its corresponding request array.
- Welcome advertises `lookup_batch_max`, `lookup_bucket_capacity`, `lookup_refill_per_min`,
  `cache_ttl_ms` (120,000), `ping_interval_ms` (30,000), and `reconnect_max_ms` (300,000).
  These fields and `hello.client_build` are optional in v1. Catch-up compares version, then build.
  Release messages are hints; clients still verify the signed update manifest.
- Issuer keys: cached for an hour, with at most one refresh attempt per 60 s, including unknown `kid`s
  and failures. Sessions remain authenticated after the original token expires.

## Privacy

- Lookups answer “uses Cinnabar,” rather than providing an exact online status. Visible accounts
  linger in Hub memory for `PRESENCE_LINGER_MS` (30 minutes) after their last socket closes.
  Visibility off clears retained presence immediately; another visible socket can still make
  the account visible. Linger is best effort and is lost when the Hub hibernates or restarts.
- Presence UUIDs are derived from the verified XUID, never supplied by the client at login.
- Connection attachments survive hibernation and hold the XUID, UUID, visibility, channel, and socket
  flood counters. Handshakes (at most 10 s) temporarily hold the nonce, public key, client version
  and build. Display names and tokens are not stored in attachments or sent in welcome.
- Account lookup budgets survive reconnects and hibernation in Durable Object storage. Each
  record holds only an XUID, remaining token count and refill timestamp; an alarm removes records
  unused for five minutes. Requested rosters and lookup results are not retained.
- Durable storage also holds release records (channel, version, build, published_at) and a random
  admission-hash salt. Pending handshake attachments contain a salted hash of their IPv4 address
  or IPv6 /64, removed on authentication or close. In-memory counters rebuild from these hashes
  on wake. Raw IP addresses are used only to compute the hash during admission.
- `GET /v1/news` and `GET /v1/featured` serve bundled lists without auth; they neither log nor
  store anything and do not wake the Hub.
- Server addresses are not sent, but submitted roster XUIDs can reveal who shares a server.
  Player data is not logged. Analytics Engine receives only fixed event labels and counts for
  admission refusals, authentication failures, overload closes and lookups, with no identifiers
  or payloads. Counts are aggregated per invocation; failed metric writes are dropped without
  affecting admission or cleanup. Workers observability remains off so invocation logs do not
  record request metadata.

## Shared emotes

Authenticated clients send `emote_state` with a clip identifier (or `null` to stop), elapsed
playback time, and up to 128 nearby XUIDs/UUIDs combined. Phase refreshes can omit both
identifier arrays to retain existing watches; an explicit empty array clears them. The hub forwards `emote` updates only
when both clients report each other nearby. It derives sender identities from authentication;
clients cannot supply another account's identity. Clients ignore unknown clip identifiers.

The existing visibility option controls publishing. Stops, visibility opt-out, disconnects and
removed peers withdraw playback. Active updates carry a remaining lease of at most 15 seconds;
clients renew at five-second intervals and expire silence locally. Newly subscribed clients
receive only a still-live dance. Socket attachments retain watches and phases across hibernation;
no emote history is written to durable storage or logs. No server addresses are sent.

## Development

```sh
npm ci
npm test           # vitest in the Workers runtime
npm run typecheck
cp .dev.vars.example .dev.vars && npm run dev
```

`ISSUER` (in `wrangler.jsonc`) is the multiplayer-token OIDC issuer; its JWKS is found through
`<issuer>/.well-known/openid-configuration`.

## Deploy

```sh
npx wrangler secret put RELEASE_HOOK_SECRET
npx wrangler deploy
```

The release hook rejects every request until `RELEASE_HOOK_SECRET` is set.

## License

MIT
