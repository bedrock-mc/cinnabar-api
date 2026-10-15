import { DurableObject } from "cloudflare:workers";
import { IssuerUnavailable, encodeBase64Url, issuerKeys, verifyProof } from "./identity";
import {
  Close,
  CONNECTION_RETRY_AFTER_S,
  HANDSHAKE_TIMEOUT_MS,
  LOOKUP_RATE_LIMIT,
  LOOKUP_RATE_WINDOW_MS,
  MAX_CONNECTIONS,
  MAX_CONNECTIONS_PER_IP,
  MAX_FRAME_BYTES,
  compareVersions,
  decodeClientMessage,
  type Channel,
  type ClientMessage,
  type Hello,
  type Lookup,
  type ReleaseRecord,
  type ServerMessage,
} from "./protocol";

/** Per-socket state, persisted with serializeAttachment so it survives hibernation. */
type Attachment =
  | { stage: "hello"; deadline: number }
  | { stage: "verifying"; deadline: number }
  | {
      stage: "proof";
      deadline: number;
      nonce: string;
      xuid: string;
      displayName: string;
      cpk: string;
      clientVersion: string;
      channel: Channel;
      visible: boolean;
    }
  | { stage: "ready"; xuid: string; channel: Channel; visible: boolean; lookups: number[] };

type Ready = Extract<Attachment, { stage: "ready" }>;

/** Written over a forgotten socket's attachment so a wake before the close completes doesn't restore it. */
const CLOSED = { stage: "closed" } as const;

const releaseKey = (channel: Channel) => `release:${channel}`;

/**
 * Owns every WebSocket and the release records. Socket tags are fixed at accept time, before the client has
 * authenticated, so lookups and broadcasts go through in-memory indexes rebuilt from attachments on each wake.
 */
export class Hub extends DurableObject<Env> {
  private readonly sessions = new Map<WebSocket, Attachment>();
  private readonly byXuid = new Map<string, Set<WebSocket>>();
  private readonly byChannel = new Map<Channel, Set<WebSocket>>();
  // Never attach IP-derived data to sockets: these hashes and their salt reset on hibernation.
  private readonly ipSalt = crypto.randomUUID();
  private readonly ipBySocket = new WeakMap<WebSocket, string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    for (const ws of ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | typeof CLOSED | null;
      // Handshaking sockets are restored too, so the alarm still closes them at their deadline.
      if (attachment && attachment.stage !== "closed" && ws.readyState === WebSocket.OPEN) {
        this.save(ws, attachment, false);
      }
    }
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response(null, { status: 426, headers: { Upgrade: "websocket" } });
    }
    const ipHash = await this.hashIp(request.headers.get("CF-Connecting-IP") ?? "");
    // Include closing sockets until the platform drops them, independently of authentication and presence.
    const sockets = this.ctx.getWebSockets();
    // No await between checking the caps and recording the accepted socket.
    if (
      sockets.length >= MAX_CONNECTIONS ||
      sockets.filter((ws) => this.ipBySocket.get(ws) === ipHash).length >= MAX_CONNECTIONS_PER_IP
    ) {
      return new Response(null, { status: 429, headers: { "Retry-After": String(CONNECTION_RETRY_AFTER_S) } });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
    this.save(server, { stage: "hello", deadline });
    this.ipBySocket.set(server, ipHash);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(deadline);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Hashes an IP with this Hub lifetime's random salt; the raw IP is never retained. */
  private async hashIp(ip: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${this.ipSalt}:${ip}`));
    return encodeBase64Url(new Uint8Array(digest));
  }

  /** Records `version` as the channel's latest release and pushes it to that channel's authenticated sockets. */
  async recordRelease(channel: Channel, version: string): Promise<ReleaseRecord> {
    const record: ReleaseRecord = { channel, version, published_at: new Date(Date.now()).toISOString() };
    await this.ctx.storage.put(releaseKey(channel), record);
    for (const ws of this.byChannel.get(channel) ?? []) send(ws, { type: "release", ...record });
    return record;
  }

  async latestRelease(channel: Channel): Promise<ReleaseRecord | null> {
    return (await this.ctx.storage.get<ReleaseRecord>(releaseKey(channel))) ?? null;
  }

  override async alarm(): Promise<void> {
    const next = this.expireHandshakes(Date.now());
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }

  /** Closes sockets still handshaking at `now` past their deadline; returns the earliest remaining deadline. */
  expireHandshakes(now: number): number | null {
    let next: number | null = null;
    for (const [ws, attachment] of this.sessions) {
      if (attachment.stage === "ready") continue;
      if (attachment.deadline <= now) this.close(ws, Close.unauthorized, "handshake timeout");
      else next = next === null ? attachment.deadline : Math.min(next, attachment.deadline);
    }
    return next;
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = this.sessions.get(ws);
    if (!attachment) return;
    if (typeof message !== "string") {
      if (message.byteLength > MAX_FRAME_BYTES) this.close(ws, Close.tooBig, "frame too large");
      else this.close(ws, Close.policyViolation, "text frames only");
      return;
    }
    if (exceedsFrameLimit(message)) return this.close(ws, Close.tooBig, "frame too large");
    const decoded = decodeClientMessage(message);
    switch (decoded.kind) {
      case "unknown":
        return;
      case "malformed":
        return this.close(ws, Close.invalidPayload, "malformed message");
      case "invalid":
        return this.close(ws, Close.policyViolation, "invalid message");
    }
    const now = Date.now();
    const msg: ClientMessage = decoded.message;
    switch (attachment.stage) {
      case "hello":
        return msg.type === "hello" ? this.onHello(ws, msg, attachment.deadline, now) : this.reject(ws);
      case "verifying":
        return this.reject(ws);
      case "proof":
        return msg.type === "proof" ? this.onProof(ws, attachment, msg.signature) : this.reject(ws);
      case "ready":
        if (msg.type === "visibility") return this.onVisibility(ws, attachment, msg.visible);
        if (msg.type === "lookup") return this.onLookup(ws, attachment, msg, now);
        return this.close(ws, Close.policyViolation, "already authenticated");
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.ipBySocket.delete(ws);
    this.forget(ws);
    try {
      ws.close(code, reason);
    } catch {
      // Already closed, or a reserved code (1005/1006) that can't be echoed.
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.ipBySocket.delete(ws);
    this.forget(ws);
  }

  private async onHello(ws: WebSocket, hello: Hello, deadline: number, now: number): Promise<void> {
    this.save(ws, { stage: "verifying", deadline });
    let identity;
    try {
      identity = await issuerKeys(this.env.ISSUER).verify(hello.token, now);
    } catch (err) {
      if (!(err instanceof IssuerUnavailable)) throw err;
      return this.close(ws, 1011, "issuer unavailable");
    }
    if (!this.sessions.has(ws)) return;
    if (!identity) return this.reject(ws);
    if (deadline <= Date.now()) return this.close(ws, Close.unauthorized, "handshake timeout");
    const nonce = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    this.save(ws, {
      stage: "proof",
      deadline,
      nonce,
      xuid: identity.xuid,
      displayName: identity.displayName,
      cpk: identity.cpk,
      clientVersion: hello.client_version,
      channel: hello.channel,
      visible: hello.visible,
    });
    send(ws, { type: "challenge", nonce });
  }

  private async onProof(ws: WebSocket, pending: Extract<Attachment, { stage: "proof" }>, signature: string) {
    this.save(ws, { stage: "verifying", deadline: pending.deadline });
    const valid = await verifyProof(pending.cpk, pending.nonce, signature);
    if (!this.sessions.has(ws)) return;
    if (!valid) return this.reject(ws);
    const { xuid, channel, visible } = pending;
    // Read before indexing so a concurrent recordRelease reaches this socket exactly once, via one path or the other.
    const latest = await this.latestRelease(channel);
    if (!this.sessions.has(ws)) return;
    // The alarm skips sockets it can't see as handshaking, so a proof that outlived its deadline is refused here.
    if (pending.deadline <= Date.now()) return this.close(ws, Close.unauthorized, "handshake timeout");
    this.save(ws, { stage: "ready", xuid, channel, visible, lookups: [] });
    send(ws, { type: "welcome", xuid, display_name: pending.displayName });
    if (latest && compareVersions(latest.version, pending.clientVersion) > 0) send(ws, { type: "release", ...latest });
  }

  private onVisibility(ws: WebSocket, state: Ready, visible: boolean): void {
    if (state.visible !== visible) this.save(ws, { ...state, visible });
  }

  private onLookup(ws: WebSocket, state: Ready, lookup: Lookup, now: number): void {
    const { admitted, lookups } = admitLookup(state.lookups, now);
    this.save(ws, { ...state, lookups });
    if (!admitted) return send(ws, { type: "error", code: "rate_limited", id: lookup.id });
    const cinnabar = [...new Set(lookup.xuids)].filter((xuid) => this.isVisible(xuid));
    send(ws, { type: "lookup_result", id: lookup.id, cinnabar });
  }

  private isVisible(xuid: string): boolean {
    for (const ws of this.byXuid.get(xuid) ?? []) {
      const state = this.sessions.get(ws);
      if (state?.stage === "ready" && state.visible) return true;
    }
    return false;
  }

  private reject(ws: WebSocket): void {
    send(ws, { type: "error", code: "unauthorized" });
    this.close(ws, Close.unauthorized, "unauthorized");
  }

  private close(ws: WebSocket, code: number, reason: string): void {
    this.forget(ws);
    try {
      ws.close(code, reason);
    } catch {
      // Already closing.
    }
  }

  private save(ws: WebSocket, attachment: Attachment, persist = true): void {
    if (persist) ws.serializeAttachment(attachment);
    this.sessions.set(ws, attachment);
    if (attachment.stage === "ready") {
      index(this.byXuid, attachment.xuid, ws);
      index(this.byChannel, attachment.channel, ws);
    }
  }

  private forget(ws: WebSocket): void {
    const attachment = this.sessions.get(ws);
    this.sessions.delete(ws);
    try {
      ws.serializeAttachment(CLOSED);
    } catch {
      // The socket is already gone, and with it the attachment.
    }
    if (attachment?.stage === "ready") {
      unindex(this.byXuid, attachment.xuid, ws);
      unindex(this.byChannel, attachment.channel, ws);
    }
  }
}

/** Applies the rolling lookup limit at `now`: the admitted timestamps still in the window, plus `now` if admitted. */
export function admitLookup(timestamps: number[], now: number): { admitted: boolean; lookups: number[] } {
  const lookups = timestamps.filter((t) => now - t < LOOKUP_RATE_WINDOW_MS);
  if (lookups.length >= LOOKUP_RATE_LIMIT) return { admitted: false, lookups };
  lookups.push(now);
  return { admitted: true, lookups };
}

function index<K>(map: Map<K, Set<WebSocket>>, key: K, ws: WebSocket): void {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(ws);
}

function unindex<K>(map: Map<K, Set<WebSocket>>, key: K, ws: WebSocket): void {
  const set = map.get(key);
  if (set?.delete(ws) && set.size === 0) map.delete(key);
}

function send(ws: WebSocket, message: ServerMessage): void {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    // The peer went away; webSocketClose cleans up.
  }
}

/** Whether the frame's UTF-8 size exceeds the limit; UTF-8 takes 1-3 bytes per UTF-16 unit, so most frames skip encoding. */
function exceedsFrameLimit(text: string): boolean {
  if (text.length > MAX_FRAME_BYTES) return true;
  if (text.length * 3 <= MAX_FRAME_BYTES) return false;
  return new TextEncoder().encode(text).byteLength > MAX_FRAME_BYTES;
}
