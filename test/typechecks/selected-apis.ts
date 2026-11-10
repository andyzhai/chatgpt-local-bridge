// Compile-only contract: never execute auth initialization in typechecks.
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { getMigrations } from "better-auth/db/migration";
import { mcp, requireMcpAuth } from "@better-auth/mcp";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import type Database from "better-sqlite3";

type ToolOptions = Parameters<McpServer["registerTool"]>[1];
const unsupportedTopLevelMetadata: ToolOptions = {
  // @ts-expect-error SDK 2.3.1 does not expose top-level securitySchemes.
  securitySchemes: [{ type: "oauth2", scopes: ["files"] }],
};
void unsupportedTopLevelMetadata;

export function checkSelectedAuthApis(database: Database.Database) {
  const publicOrigin = "https://example.com";
  const resource = `${publicOrigin}/mcp`;
  const options = {
    baseURL: publicOrigin,
    basePath: "/api/auth",
    database,
    plugins: [
      jwt({ jwt: { issuer: publicOrigin } }),
      mcp({
        loginPage: "/sign-in", consentPage: "/consent", resource,
        scopes: ["files", "offline_access"],
        grantTypes: ["authorization_code", "refresh_token"],
        allowDynamicClientRegistration: false,
        allowUnauthenticatedClientRegistration: false,
        accessTokenExpiresIn: 900, codeExpiresIn: 60, refreshTokenReuseInterval: 30,
      }),
      cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
    ],
  } satisfies Parameters<typeof betterAuth>[0];
  const auth = betterAuth(options);
  const handler = createMcpHandler(() => new McpServer({ name: "type-probe", version: "0" }), {
    legacy: "stateless", responseMode: "auto", maxRequestBodySize: 4 * 1024 * 1024,
  });
  const authenticatedFetch = requireMcpAuth(auth, (request) => handler.fetch(request), {
    resource, issuer: publicOrigin, jwksUrl: `${publicOrigin}/api/auth/jwks`,
    requiredScopes: ["files"],
  });
  return { nodeHandler: toNodeHandler({ fetch: authenticatedFetch }),
    migrations: () => getMigrations(options) };
}
