import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { mcp } from "@better-auth/mcp";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import type Database from "better-sqlite3";
import { requireOAuthConfig, type BridgeConfig } from "../config.js";

/** Shared by migration, offline bootstrap, and serving. Importing opens nothing. */
export function authOptions(config: BridgeConfig, database: Database.Database, bootstrap = false) {
  return {
    baseURL: config.publicOrigin, basePath: "/api/auth",
    secret: requireOAuthConfig(config).secret, database: database as Parameters<typeof betterAuth>[0]["database"],
    trustedOrigins: [config.publicOrigin],
    emailAndPassword: { enabled: true, disableSignUp: !bootstrap, autoSignIn: false, minPasswordLength: 12 },
    // Session JWTs must not be available as an alternative route to MCP access.
    disabledPaths: ["/token"],
    advanced: { useSecureCookies: true, ipAddress: { ipAddressHeaders: [] } },
    rateLimit: {
      enabled: true, storage: "database" as const, window: 60, max: 120,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/oauth2/authorize": { window: 60, max: 30 },
        "/oauth2/token": { window: 60, max: 30 },
        "/oauth2/consent": { window: 60, max: 20 },
        "/oauth2/public-client-prelogin": { window: 60, max: 30 },
      },
    },
    // Never send provider diagnostics (which may contain OAuth input) to logs.
    logger: { disabled: true },
    plugins: [
      jwt({ jwt: { issuer: config.publicOrigin } }),
      mcp({
        loginPage: "/sign-in", consentPage: "/consent", resource: config.mcpResource,
        scopes: ["files", "offline_access"], grantTypes: ["authorization_code", "refresh_token"],
        allowDynamicClientRegistration: false, allowUnauthenticatedClientRegistration: false,
        allowPublicClientPrelogin: true,
        accessTokenExpiresIn: 900, codeExpiresIn: 60, refreshTokenReuseInterval: 30,
      }),
      cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
    ],
  } satisfies Parameters<typeof betterAuth>[0];
}

export function createAuth(config: BridgeConfig, database: Database.Database, bootstrap = false) {
  return betterAuth(authOptions(config, database, bootstrap));
}
export type BridgeAuth = ReturnType<typeof createAuth>;
