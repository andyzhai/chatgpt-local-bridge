import { describe, expect, it } from "vitest";
import { McpServer, createMcpHandler, CLIENT_INFO_META_KEY,
  CLIENT_CAPABILITIES_META_KEY, PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/server";
import { toNodeHandler, toWebRequest, hostHeaderValidation, originValidation } from "@modelcontextprotocol/node";
import { Client } from "@modelcontextprotocol/client";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { getMigrations } from "better-auth/db/migration";
import { mcp, requireMcpAuth, createMcpProtectedRequestHandler } from "@better-auth/mcp";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { oauthProvider } from "@better-auth/oauth-provider";
import Database from "better-sqlite3";
import { createTwoFilesPatch } from "diff";
import { minimatch } from "minimatch";
import { z } from "zod";

describe("pinned dependency compatibility", () => {
  it("resolves the planned SDK, HTTP and Better Auth exports", () => {
    for (const api of [McpServer, createMcpHandler, toNodeHandler, toWebRequest, hostHeaderValidation,
      originValidation, Client, betterAuth, jwt, getMigrations, mcp, requireMcpAuth,
      cimd, createMcpProtectedRequestHandler, fetchClientMetadataResource, oauthProvider, createTwoFilesPatch, minimatch]) {
      expect(typeof api).toBe("function");
    }
  });

  it("runs native SQLite statements and rollback on the active runtime", () => {
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
      db.prepare("INSERT INTO probe(value) VALUES (?)").run("native driver loaded");
      expect(db.prepare("SELECT value FROM probe").get()).toEqual({ value: "native driver loaded" });
      expect(() => db.transaction(() => {
        db.prepare("INSERT INTO probe(value) VALUES (?)").run("rollback");
        throw new Error("rollback probe");
      })()).toThrow("rollback probe");
      expect(db.prepare("SELECT COUNT(*) AS count FROM probe").get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it("registers a Zod v4 tool with the v2 per-request factory and Node adapter", async () => {
    // Test-only constant tool; no listener, filesystem tool or OAuth flow.
    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: "phase-1-probe", version: "0.0.0" });
      server.registerTool("compatibility_probe", {
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        _meta: { securitySchemes: [{ type: "oauth2", scopes: ["files"] }] },
      }, () => ({ content: [{ type: "text", text: "ok" }] }));
      return server;
    }, { legacy: "reject", responseMode: "auto" });
    try {
      expect(typeof toNodeHandler(handler, { maxRequestBodySize: 4096 })).toBe("function");
      const response = await handler.fetch(new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {
          _meta: { [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
            [CLIENT_INFO_META_KEY]: { name: "phase-1-test", version: "0.0.0" },
            [CLIENT_CAPABILITIES_META_KEY]: {} },
        } }),
      }));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.error).toBeUndefined();
      expect(body.result.tools).toHaveLength(1);
      expect(body.result.tools[0]).toMatchObject({ name: "compatibility_probe",
        inputSchema: { type: "object" },
        _meta: { securitySchemes: [{ type: "oauth2", scopes: ["files"] }] } });
      // Observed wire shape only. This does NOT establish ChatGPT linking.
      expect(body.result.tools[0]).not.toHaveProperty("securitySchemes");
    } finally {
      await handler.close();
    }
  });
});
