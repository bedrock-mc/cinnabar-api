# cinnabar-api

The Cinnabar client's API: release notifications and player presence, as a Cloudflare Worker
(Hono) with one Durable Object. [`schema/v1.json`](schema/v1.json) is the machine-readable
contract (JSON Schema for every HTTP body and WebSocket message); the server validates inbound
messages against it.

## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /v1/health` | `{"ok":true,"api":"v1"}` |
| `GET /v1/releases/latest?channel=stable\|beta\|nightly` | Latest recorded release, `404` if none. Informational; clients verify the signed GitHub manifest. |
| `POST /v1/releases` | Release hook. `Authorization: Bearer <RELEASE_HOOK_SECRET>`, body `{"channel","version"}`; records the release and pushes it to clients on that channel. |
| `GET /v1/connect` | WebSocket. The client authenticates with a Minecraft multiplayer token plus an ES384 proof of its key, then can toggle visibility, look up which XUIDs are visible Cinnabar players, and receives release pushes. |

Close codes: `4401` failed or timed-out authentication, `1009` frame over 16 KiB, `1007` frame
that isn't a JSON object with a `type`, `1008` known message failing the schema or a binary frame, `1011` issuer
unreachable. Unknown message types and fields are ignored. The text frame `ping` gets `pong`.

- Connections: at most 20,000 per Hub and 8 per IP since the last wake, including sockets still closing; excess upgrades receive HTTP 429 with `Retry-After: 10`.
- Issuer keys: cached for an hour, with at most one refresh attempt per 60 s, including unknown `kid`s and failures.

## Privacy

- Per live connection, in memory only: XUID, visibility, channel, and lookup timestamps for rate
  limiting. Gone when the connection closes. During the handshake (at most 10 s) the connection
  also holds the nonce, the token's display name and public key, and the client version.
- Durable storage holds release records only: channel, version, published_at.
- IP limits hold a salted SHA-256 IP hash per counted socket, only in Hub memory until its close
  or error callback, or until the Hub hibernates, whichever comes first. Closing sockets continue
  to count against the caps while the platform reports them as attached.
  A fresh random salt is created on each wake; IP counts reset and existing sockets are not counted
  toward the per-IP cap after hibernation. Raw IPs are used only to compute the hash during admission;
  neither IPs nor hashes are written to storage, socket attachments, or tags.
- Tokens, raw IPs, server addresses and lookup contents are never stored, and nothing about players
  is logged. Workers observability is off so invocation logs don't record request metadata.

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
