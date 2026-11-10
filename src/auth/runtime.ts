import { requireMcpAuth } from "@better-auth/mcp";
import { ConfigurationError, type BridgeConfig } from "../config.js";
import { createAuth } from "./options.js";
import { assertSchema, assertSigningState, openAuthStorage, ownerCount } from "./storage.js";
import { authPage } from "./ui.js";

const routes = new Set([
  "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server", "/api/auth/jwks",
  "/api/auth/oauth2/authorize", "/api/auth/oauth2/token", "/api/auth/oauth2/consent",
  "/api/auth/oauth2/continue", "/api/auth/oauth2/public-client-prelogin", "/api/auth/oauth2/public-client",
  "/api/auth/oauth2/revoke", "/api/auth/sign-in/email", "/api/auth/get-session", "/api/auth/sign-out",
]);

export async function createOAuthRuntime(config: BridgeConfig, mcpFetch: (request: Request) => Promise<Response>) {
  const storage = await openAuthStorage(config);
  try {
    await assertSchema(config, storage.database);
    if (ownerCount(storage.database) !== 1) throw new ConfigurationError("OAuth requires exactly one owner; run owner:create before serving.");
    const auth = createAuth(config, storage.database);
    await assertSigningState(auth, storage.database);
    const owner = storage.database.prepare('SELECT id FROM "user"').get() as { id: string };
    const protectedFetch = requireMcpAuth(auth, (request, claims) => {
      if (claims.sub !== owner.id) return new Response("Invalid access token subject", {
        status: 401, headers: { "WWW-Authenticate": 'Bearer error="invalid_token"' },
      });
      return mcpFetch(request);
    }, {
      resource: config.mcpResource, issuer: config.publicOrigin,
      jwksUrl: `${config.publicOrigin}/api/auth/jwks`, requiredScopes: ["files"],
    });
    return {
      close: storage.close,
      async fetch(request: Request): Promise<Response> {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/mcp") return protectedFetch(request);
        const page = authPage(request);
        if (page) return page;
        if (!routes.has(pathname)) return new Response("Not found", { status: 404 });
        return auth.handler(request);
      },
    };
  } catch (error) { await storage.close(); throw error; }
}
