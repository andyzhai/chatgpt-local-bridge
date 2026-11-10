import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { hostHeaderValidation, originValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { assertExposureAcknowledged, requireOAuthConfig, type BridgeConfig } from "./config.js";
import { createFilesystemServerFactory } from "./filesystem/server.js";
import { waitForFilesystemIdle } from "./filesystem/budget.js";

export const HTTP_LIMITS = Object.freeze({
  maxConcurrentRequests: 16,
  maxConnections: 64,
  headersTimeoutMs: 10_000,
  requestTimeoutMs: 30_000,
  idleTimeoutMs: 60_000,
  keepAliveTimeoutMs: 5_000,
});

function reject(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8", Connection: "close",
    ...(status === 503 ? { "Retry-After": "1" } : {}),
  });
  res.end(message);
}

/** Owner-only construction; always guarded, including when tests listen on
 * port zero. No-auth mode never imports auth runtime. */
export async function createBridgeHttpServer(config: BridgeConfig, controlPaths: readonly string[] = []) {
  assertExposureAcknowledged(config);
  const oauthConfig = config.authMode === "oauth" ? requireOAuthConfig(config) : undefined;
  const factory = await createFilesystemServerFactory(config.allowedDirectories, {
    filesystemLimits: config.filesystemLimits,
    controlPaths: [...controlPaths, path.dirname(config.authDatabasePath)],
    toolMetadata: { securitySchemes: oauthConfig ? [{ type: "oauth2", scopes: ["files"] }] : [{ type: "noauth" }] },
  });
  const mcp = createMcpHandler(factory, {
    legacy: config.legacyMode, responseMode: "auto", maxRequestBodySize: config.maxRequestBodyBytes,
  });
  const oauth = oauthConfig ? await (async () => {
    try { return await (await import("./auth/runtime.js")).createOAuthRuntime(config, request => mcp.fetch(request)); }
    catch (error) { await mcp.close(); throw error; }
  })() : undefined;
  const publicHostname = new URL(config.publicOrigin).hostname;
  const hosts = [publicHostname, "127.0.0.1", "localhost"];
  const validateHost = hostHeaderValidation(hosts);
  const validateOrigin = originValidation(hosts);
  let stopping = false;
  const requests = new Set<Promise<void>>();
  const adapter = toNodeHandler({
    async fetch(request) {
      if (stopping) return new Response("Server shutting down", { status: 503 });
      const incoming = new URL(request.url);
      // Host was validated before body buffering. Proxy headers never determine
      // the externally visible URL, including its scheme, authority or port.
      const external = new URL(config.publicOrigin);
      external.pathname = incoming.pathname;
      external.search = incoming.search;
      // Never trust forwarded authority or IP headers at the auth boundary.
      const canonical = new Request(external, request);
      for (const header of [...canonical.headers.keys()]) {
        if (header === "forwarded" || header.startsWith("x-forwarded-") ||
            ["x-real-ip", "cf-connecting-ip"].includes(header)) canonical.headers.delete(header);
      }
      return oauth ? oauth.fetch(canonical) : mcp.fetch(canonical);
    },
  }, { maxRequestBodySize: config.maxRequestBodyBytes });

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const authorityHeaders = req.rawHeaders.filter((_, index) => index % 2 === 0)
      .map(name => name.toLowerCase());
    if (!req.headers.host || !/^[a-z0-9.-]+(?::[0-9]+)?$/i.test(req.headers.host) ||
      authorityHeaders.filter(name => name === "host").length !== 1 ||
      authorityHeaders.filter(name => name === "origin").length > 1) {
      return reject(res, 403, "Invalid Host or Origin headers");
    }
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    // SDK guards are hostname-only. Browser origins must also have the exact
    // allowed scheme and port, without credentials, paths or opaque origins.
    const origin = req.headers.origin;
    const localPort = req.socket.localPort;
    if (origin !== undefined && ![
      config.publicOrigin, `http://127.0.0.1:${localPort}`, `http://localhost:${localPort}`,
    ].includes(origin)) return reject(res, 403, "Forbidden Origin");
    const target = oauth ? /^\/(?:mcp|sign-in|consent|auth-ui\.js|api\/auth\/[a-z0-9/-]+|\.well-known\/[a-z0-9/-]+)(?:\?[^#\\]*)?$/ : /^\/mcp(?:\?[^#\\]*)?$/;
    if (!req.url || !target.test(req.url)) return reject(res, 404, "Not found");
    if (stopping) return reject(res, 503, "Server shutting down");
    if (requests.size >= HTTP_LIMITS.maxConcurrentRequests) return reject(res, 503, "HTTP request limit; retry later");
    if (req.headers.expect?.toLowerCase() === "100-continue") {
      if (Number(req.headers["content-length"]) > config.maxRequestBodyBytes) return reject(res, 413, "Payload Too Large");
      res.writeContinue();
    }
    const pending = adapter(req, res).catch(() => {
      if (!res.headersSent && !res.destroyed) reject(res, 500, "Internal server error");
      else res.destroy();
    }).finally(() => requests.delete(pending));
    requests.add(pending);
  }

  const server = createServer({
    headersTimeout: HTTP_LIMITS.headersTimeoutMs,
    requestTimeout: HTTP_LIMITS.requestTimeoutMs,
    keepAliveTimeout: HTTP_LIMITS.keepAliveTimeoutMs,
    maxHeaderSize: 16 * 1024,
  }, handle);
  server.maxConnections = HTTP_LIMITS.maxConnections;
  // Idle timeout, not an overall SSE deadline; SDK keepalives refresh activity.
  server.setTimeout(HTTP_LIMITS.idleTimeoutMs, socket => socket.destroy());
  server.on("checkContinue", handle);
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    return closing ??= (async () => {
      stopping = true;
      const listenerClosed = new Promise<void>((resolve, rejectClose) => {
        server.close(error => {
          if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") rejectClose(error);
          else resolve();
        });
      });
      await mcp.close();
      // Also cancel legacy exchanges and incomplete uploads. Neither cancellation
      // nor socket closure is evidence that an already-started mutation stopped.
      server.closeAllConnections();
      await Promise.allSettled([...requests]);
      await waitForFilesystemIdle();
      await listenerClosed;
      await oauth?.close();
    })();
  }
  return { server, close };
}
