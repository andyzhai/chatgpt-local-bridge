import { exerciseAllTools, exerciseBoundaryTools, prepareBoundaryFixture } from "./http-acceptance.js";
import fs from "node:fs/promises";
import path from "node:path";
import { request as httpRequest, type ClientRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { CLIENT_INFO_META_KEY, CLIENT_CAPABILITIES_META_KEY, PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/server";
import { parseConfig, UNAUTHENTICATED_ACCESS_ACK, type BridgeConfig } from "../src/config.js";
import { createBridgeHttpServer, HTTP_LIMITS } from "../src/http.js";
import { startBridge } from "../src/main.js";
import { budget, waitForFilesystemIdle } from "../src/filesystem/budget.js";
import { call, makeTempDir, textOf } from "./upstream/helpers.js";

// These factories throw if the no-auth implementation ever loads auth runtime.
vi.mock("better-auth", () => { throw new Error("No-auth loaded Better Auth"); });
vi.mock("better-sqlite3", () => { throw new Error("No-auth loaded SQLite"); });

let dir: string;
const cleanups: (() => Promise<unknown>)[] = [];
beforeEach(async () => { dir = await makeTempDir("localbridge-http-"); });
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});
function config(local: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  return parseConfig({ allowedDirectories: [dir], ...local }, {
    PUBLIC_ORIGIN: "https://mcp.example.com",
    AUTH_MODE: "none", ACK_UNAUTHENTICATED_FILESYSTEM_ACCESS: UNAUTHENTICATED_ACCESS_ACK, ...env,
  });
}
async function harness(settings: BridgeConfig = config()) {
  const bridge = await createBridgeHttpServer(settings);
  cleanups.push(bridge.close);
  await new Promise<void>(resolve => bridge.server.listen(0, "127.0.0.1", resolve));
  const port = (bridge.server.address() as AddressInfo).port;
  return { ...bridge, port, url: `http://127.0.0.1:${port}/mcp` };
}
async function clientFor(url: string, legacy = false) {
  const client = new Client({ name: "phase-3-test", version: "1" }, {
    versionNegotiation: { mode: legacy ? "legacy" : { pin: "2026-07-28" } },
    ...(legacy ? { supportedProtocolVersions: ["2025-11-25"] } : {}),
  });
  cleanups.push(() => client.close());
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);
  return { client, transport };
}
function modern(method = "tools/list", params: Record<string, unknown> = {}) {
  return { jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: {
    [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
    [CLIENT_INFO_META_KEY]: { name: "raw-test", version: "1" }, [CLIENT_CAPABILITIES_META_KEY]: {},
  } } };
}
function headers(method = "tools/list") {
  return { "Content-Type": "application/json", Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method };
}
async function post(url: string, body: unknown = modern(), extra: Record<string, string> = {}) {
  return fetch(url, { method: "POST", headers: { ...headers(), ...extra }, body: JSON.stringify(body) });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
function raw(port: number, options: { headers?: Record<string, string>; body?: string; chunked?: boolean; target?: string } = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const body = options.body ?? JSON.stringify(modern());
    const req = httpRequest({ host: "127.0.0.1", port, path: options.target ?? "/mcp", method: "POST", setHost: options.headers?.Host !== "",
      headers: { ...headers(), ...(options.chunked ? { "Transfer-Encoding": "chunked" } : { "Content-Length": Buffer.byteLength(body).toString() }), ...options.headers },
    }, res => {
      let text = "";
      res.setEncoding("utf8"); res.on("data", chunk => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, body: text }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("guarded startup", () => {
  it("runs the normal config-file startup with acknowledgment on an isolated OS-selected port", async () => {
    const reservation = await harness(), port = reservation.port;
    await reservation.close();
    const root = path.join(dir, "files"), file = path.join(dir, "owner-config.json");
    await fs.mkdir(root); await fs.writeFile(file, JSON.stringify({ allowedDirectories: [root] }));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bridge = await startBridge(file, { PUBLIC_ORIGIN: "https://mcp.example.com", AUTH_MODE: "none", PORT: String(port),
      ACK_UNAUTHENTICATED_FILESYSTEM_ACCESS: UNAUTHENTICATED_ACCESS_ACK,
    });
    cleanups.push(bridge.close);
    expect((bridge.server.address() as AddressInfo).address).toBe("127.0.0.1");
    const { client } = await clientFor(`http://127.0.0.1:${port}/mcp`);
    expect((await client.listTools()).tools).toHaveLength(14);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("Anyone who can reach this endpoint"));
    expect(await fs.readdir(dir)).toEqual(expect.arrayContaining(["files", "owner-config.json"]));
    expect((await fs.readdir(dir)).some(name => /sqlite|\.db/.test(name))).toBe(false);
  });
  it("fails closed for absent acknowledgment, default OAuth and invalid modes", async () => {
    const file = path.join(dir, "config.json");
    await fs.writeFile(file, JSON.stringify({ allowedDirectories: [path.join(dir, "files")] }));
    for (const environment of [{ AUTH_MODE: "none" }, {}, { AUTH_MODE: "typo" }]) {
      await expect(startBridge(file, { PUBLIC_ORIGIN: "https://mcp.example.com", ...environment })).rejects.toThrow(/acknowledgment|not implemented|AUTH_MODE/);
    }
    await expect(createBridgeHttpServer(config({}, { AUTH_MODE: "oauth" }))).rejects.toThrow("BETTER_AUTH_SECRET");
  });
  it("rejects invalid roots and external configuration overlap before listening", async () => {
    await expect(createBridgeHttpServer(config({ allowedDirectories: [path.join(dir, "missing")] }))).rejects.toThrow("Invalid allowed directory");
    await expect(createBridgeHttpServer(config(), [path.join(dir, "config.json")])).rejects.toThrow("control state");
    await expect(createBridgeHttpServer(config({}, { DATABASE_PATH: path.join(dir, "state", "auth.sqlite") }))).rejects.toThrow("control state");
  });
  it("uses the acknowledgment on an ephemeral listener with explicit HTTP budgets", async () => {
    const h = await harness();
    expect((h.server.address() as AddressInfo).address).toBe("127.0.0.1");
    expect(h.port).not.toBe(3000);
    expect(h.server.headersTimeout).toBe(HTTP_LIMITS.headersTimeoutMs);
    expect(h.server.requestTimeout).toBe(HTTP_LIMITS.requestTimeoutMs);
    expect(h.server.timeout).toBe(HTTP_LIMITS.idleTimeoutMs);
    await h.close(); await h.close();
    expect(h.server.listening).toBe(false);
  });
});

describe("complete filesystem over SDK HTTP", () => {
  it.each([
    { legacyMode: "stateless", legacyClient: false },
    { legacyMode: "reject", legacyClient: false },
    { legacyMode: "stateless", legacyClient: true },
  ] as const)("all 14 tools: $legacyMode, legacy client=$legacyClient", async ({ legacyMode, legacyClient }) => {
    const h = await harness(config({}, { MCP_LEGACY_MODE: legacyMode }));
    const { client, transport } = await clientFor(h.url, legacyClient);
    expect(transport.protocolVersion).toBe(legacyClient ? "2025-11-25" : "2026-07-28");
    expect(transport.sessionId).toBeUndefined();
    const tools = (await client.listTools()).tools;
    expect(tools).toHaveLength(14);
    expect(tools.every(t => !JSON.stringify(t).includes("oauth2"))).toBe(true);
    await exerciseAllTools(client, dir);
  });
  it("serves a 2025 stateless client with SSE and rejects it in strict mode", async () => {
    const h = await harness();
    const { client, transport } = await clientFor(h.url, true);
    expect(transport.protocolVersion).toBe("2025-11-25");
    expect(transport.sessionId).toBeUndefined();
    expect((await client.listTools()).tools).toHaveLength(14);
    await call(client, "write_file", { path: path.join(dir, "legacy"), content: "legacy" });
    expect(textOf(await call(client, "read_text_file", { path: path.join(dir, "legacy") }))).toBe("legacy");
    const response = await fetch(h.url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" }, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }) });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toContain("read_text_file");
    const strict = await harness(config({}, { MCP_LEGACY_MODE: "reject" }));
    await expect(clientFor(strict.url, true)).rejects.toThrow();
  });
  it("keeps startup root identity across per-request server instances", async () => {
    const a = path.join(dir, "a"), b = path.join(dir, "b"), alias = path.join(dir, "alias");
    await fs.mkdir(a); await fs.mkdir(b);
    await fs.writeFile(path.join(a, "file"), "a"); await fs.writeFile(path.join(b, "file"), "b");
    await fs.symlink(a, alias, process.platform === "win32" ? "junction" : "dir");
    const h = await harness(config({ allowedDirectories: [alias] }));
    const { client } = await clientFor(h.url);
    expect(textOf(await call(client, "read_text_file", { path: path.join(alias, "file") }))).toBe("a");
    await fs.unlink(alias); await fs.symlink(b, alias, process.platform === "win32" ? "junction" : "dir");
    expect(textOf(await call(client, "read_text_file", { path: path.join(alias, "file") }))).toContain("root alias changed");
  });
});

describe("HTTP boundary and protocol validation", () => {
  it.each(["Mcp-Method", "Mcp-Name", "MCP-Protocol-Version"])("rejects a missing modern %s header before mutation", async missing => {
    const h = await harness(), file = path.join(dir, "not-written");
    const requestHeaders = new Headers({ ...headers("tools/call"), "Mcp-Name": "write_file" });
    requestHeaders.delete(missing);
    const reply = await fetch(h.url, { method: "POST", headers: requestHeaders,
      body: JSON.stringify(modern("tools/call", { name: "write_file", arguments: { path: file, content: "bad" } })),
    });
    expect(reply.status).toBe(400); await reply.text();
    await expect(fs.stat(file)).rejects.toThrow();
  });
  it("records SDK Accept behavior and rejects incomplete modern metadata", async () => {
    const h = await harness();
    // SDK 2.3.1 does not negotiate Accept on the modern leg; it always permits
    // JSON/auto SSE. The legacy leg explicitly rejects unsupported Accept.
    const modernReply = await post(h.url, modern(), { Accept: "application/xml" });
    expect(modernReply.status).toBe(200); expect(modernReply.headers.get("content-type")).toContain("application/json");
    await modernReply.text();
    const legacyReply = await fetch(h.url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/xml", "MCP-Protocol-Version": "2025-11-25" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(legacyReply.status).toBe(406); await legacyReply.text();
    const body = modern(); delete (body.params._meta as Record<string, unknown>)[PROTOCOL_VERSION_META_KEY];
    expect((await post(h.url, body)).status).toBe(400);
  });
  it.each([false, true])("preserves path and resource boundaries across repeated requests (legacy=%s)", async legacy => {
    const root = path.join(dir, "root"), outside = path.join(dir, "root-sibling");
    await prepareBoundaryFixture(root, outside);
    const h = await harness(config({ allowedDirectories: [root], filesystemLimits: { maxFileBytes: 128, maxReadBytesPerCall: 256 } }));
    const { client } = await clientFor(h.url, legacy);
    await exerciseBoundaryTools(client, root, outside, async () => {
    const notification = await fetch(h.url, { method: "POST", headers: headers("notifications/roots/list_changed"),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/roots/list_changed", params: { roots: [{ uri: new URL(`file:///${outside.replaceAll("\\", "/")}`).href }] } }),
    });
    expect(notification.status).toBe(202); await notification.text();
    });
  });
  it("accepts local/public hosts and origins, ignores forwarded authority and never enables CORS", async () => {
    const h = await harness();
    const response = await raw(h.port, { headers: { Host: "mcp.example.com", Origin: "https://mcp.example.com", Forwarded: "host=evil.test;proto=http", "X-Forwarded-Host": "evil.test" } });
    expect(response.status).toBe(200);
    for (const origin of [undefined, `http://127.0.0.1:${h.port}`, `http://localhost:${h.port}`]) {
      const reply = await post(h.url, modern(), origin ? { Origin: origin } : {});
      expect(reply.status).toBe(200);
      expect(reply.headers.has("access-control-allow-origin")).toBe(false);
      expect(reply.headers.has("www-authenticate")).toBe(false);
      expect(reply.headers.get("content-type")).toContain("application/json");
      await reply.text();
    }
  });
  it.each(["evil.test", "user@127.0.0.1", "127.0.0.1/path", "127.0.0.1:99999", ""])("rejects invalid Host %s", async host => {
    const h = await harness(); expect((await raw(h.port, { headers: { Host: host } })).status).toBe(403);
  });
  it.each(["https://evil.test", "null", "", "http://mcp.example.com", "https://mcp.example.com:444", "https://mcp.example.com/path", "http://localhost:1"])("rejects invalid Origin %s", async origin => {
    const h = await harness(); expect((await post(h.url, modern(), { Origin: origin })).status).toBe(403);
  });
  it("has no auth/discovery routes or GET/DELETE sessions", async () => {
    const h = await harness();
    for (const route of ["/", "/api/auth/sign-in", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource", "/sign-in", "/mcp/"]) {
      expect((await fetch(new URL(route, h.url))).status).toBe(404);
    }
    for (const method of ["GET", "DELETE"]) {
      const reply = await fetch(h.url, { method, headers: { "Last-Event-ID": "ignored" } });
      expect(reply.status).toBe(405); await reply.text();
    }
  });
  it("lets the SDK reject malformed JSON, batches, media types and mismatched modern headers", async () => {
    const h = await harness();
    expect((await raw(h.port, { body: "{" })).status).toBe(400);
    expect((await post(h.url, [modern()])).status).toBe(400);
    expect((await post(h.url, modern(), { "Content-Type": "text/plain" })).status).toBe(415);
    const mismatches: Record<string, string>[] = [{ "Mcp-Method": "tools/call" }, { "MCP-Protocol-Version": "2025-11-25" }, { "MCP-Protocol-Version": "9999-01-01" }];
    for (const extra of mismatches) {
      expect((await post(h.url, modern(), extra)).status).toBe(400);
    }
    expect((await post(h.url, modern("tools/call", { name: "write_file", arguments: { path: path.join(dir, "must-not-exist"), content: "bad" } }), { "Mcp-Method": "tools/call", "Mcp-Name": "read_text_file" })).status).toBe(400);
    await expect(fs.stat(path.join(dir, "must-not-exist"))).rejects.toThrow();
  });
  it("acknowledges notifications with 202", async () => {
    const h = await harness();
    const response = await fetch(h.url, { method: "POST", headers: headers("notifications/initialized"), body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    expect(response.status).toBe(202); expect(await response.text()).toBe("");
  });
  it.each([false, true])("returns 413 for oversized uploads (chunked=%s) before mutation", async chunked => {
    const h = await harness(config({ maxRequestBodyBytes: 1024 }));
    const file = path.join(dir, "oversized");
    const response = await raw(h.port, { chunked, headers: { "Mcp-Method": "tools/call", "Mcp-Name": "write_file" }, body: JSON.stringify(modern("tools/call", { name: "write_file", arguments: { path: file, content: "世".repeat(1024) } })) });
    expect(response.status).toBe(413); await expect(fs.stat(file)).rejects.toThrow();
    expect((await post(h.url)).status).toBe(200);
  });
});

describe("cancellation, shared budgets and shutdown", () => {
  it("shares filesystem I/O admission across HTTP requests", async () => {
    const h = await harness(config({ filesystemLimits: { maxConcurrentFsOps: 1 } }));
    const { client } = await clientFor(h.url);
    const file = path.join(dir, "file"); await fs.writeFile(file, "ok");
    const gate = deferred(), entered = deferred(), open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      entered.resolve(); await gate.promise; return open(...args);
    });
    const first = call(client, "read_text_file", { path: file });
    await entered.promise;
    try { expect(textOf(await call(client, "read_text_file", { path: file }))).toContain("maxConcurrentFsOps"); }
    finally { gate.resolve(); }
    expect(textOf(await first)).toBe("ok");
  });
  it("cancellation before commit leaves the file unchanged", async () => {
    const h = await harness();
    const file = path.join(dir, "unchanged"); await fs.writeFile(file, "original");
    const gate = deferred(), entered = deferred(), aborted = deferred(), realpath = fs.realpath.bind(fs);
    // Root revalidation is the first filesystem step of the tool, before any
    // mutation. Hold the real OS operation to exercise cancellation ordering.
    vi.spyOn(fs, "realpath").mockImplementationOnce(async (...args) => {
      budget()!.signal!.addEventListener("abort", aborted.resolve, { once: true });
      entered.resolve(); await gate.promise; return realpath(...args);
    });
    const controller = new AbortController();
    const pending = fetch(h.url, { method: "POST", signal: controller.signal,
      headers: { ...headers("tools/call"), "Mcp-Name": "write_file" },
      body: JSON.stringify(modern("tools/call", { name: "write_file", arguments: { path: file, content: "changed" } })),
    }).catch(() => undefined);
    try { await entered.promise; controller.abort(); await aborted.promise; }
    finally { gate.resolve(); }
    await pending; await waitForFilesystemIdle();
    expect(await fs.readFile(file, "utf8")).toBe("original");
  });
  it.each([false, true])("disconnect cancels work but holds admission until I/O settles (legacy=%s)", async legacy => {
    const h = await harness(config({ filesystemLimits: { maxConcurrentTools: 1 } }));
    const { client } = await clientFor(h.url, legacy);
    const file = path.join(dir, "file"); await fs.writeFile(file, "ok");
    const gate = deferred(), entered = deferred(), aborted = deferred(), open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      budget()!.signal!.addEventListener("abort", aborted.resolve, { once: true });
      entered.resolve(); await gate.promise; return open(...args);
    });
    const controller = new AbortController();
    const pending = fetch(h.url, { method: "POST", signal: controller.signal,
      headers: legacy ? { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" } : { ...headers("tools/call"), "Mcp-Name": "read_text_file" },
      body: JSON.stringify(legacy ? { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_text_file", arguments: { path: file } } } : modern("tools/call", { name: "read_text_file", arguments: { path: file } })),
    }).then(response => response.text()).catch(() => "aborted");
    try {
      await entered.promise; controller.abort(); await aborted.promise;
      expect(textOf(await call(client, "read_text_file", { path: file }))).toContain("maxConcurrentTools");
    } finally { gate.resolve(); }
    await pending; await waitForFilesystemIdle();
    expect(textOf(await call(client, "read_text_file", { path: file }))).toBe("ok");
  });
  it.each([false, true])("shutdown waits for a started write to settle (legacy=%s)", async legacy => {
    const h = await harness();
    const { client } = await clientFor(h.url, legacy);
    const file = path.join(dir, "mutation");
    const gate = deferred(), entered = deferred(), write = fs.writeFile.bind(fs);
    vi.spyOn(fs, "writeFile").mockImplementationOnce(async (...args) => {
      expect(budget()!.committed).toBe(true);
      entered.resolve(); await gate.promise; return write(...args);
    });
    const pending = call(client, "write_file", { path: file, content: "committed" }).catch(() => undefined);
    await entered.promise;
    let closed = false;
    const closing = h.close().then(() => { closed = true; });
    try { await new Promise(resolve => setImmediate(resolve)); expect(closed).toBe(false); }
    finally { gate.resolve(); }
    await closing; await pending;
    expect(await fs.readFile(file, "utf8")).toBe("committed");
    expect(h.server.listening).toBe(false);
  });
  it("rejects excess incomplete uploads without buffering a waiting queue", async () => {
    const h = await harness();
    const uploads: ClientRequest[] = [];
    try {
      for (let i = 0; i < HTTP_LIMITS.maxConcurrentRequests; i++) {
        await new Promise<void>((resolve, reject) => {
          const req = httpRequest({ host: "127.0.0.1", port: h.port, path: "/mcp", method: "POST", headers: { ...headers(), Expect: "100-continue", "Content-Length": "1000" } });
          req.on("error", reject); req.once("continue", resolve); req.flushHeaders(); uploads.push(req);
        });
      }
      const reply = await post(h.url);
      expect(reply.status).toBe(503); expect(reply.headers.get("retry-after")).toBe("1");
    } finally { for (const req of uploads) req.destroy(); }
  });
});
