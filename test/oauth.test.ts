import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { get as httpGet } from "node:http";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { parseConfig, UNAUTHENTICATED_ACCESS_ACK, type BridgeConfig } from "../src/config.js";
import { createBridgeHttpServer } from "../src/http.js";
import { createOwner, migrateAuth, openAuthStorage } from "../src/auth/storage.js";
import { createAuth } from "../src/auth/options.js";
import { makeTempDir } from "./upstream/helpers.js";
import { exerciseAllTools, exerciseBoundaryTools, prepareBoundaryFixture } from "./http-acceptance.js";

// Only the test network boundary is replaced. Production always uses the pinned
// DNS-validating Node transport. The plugin still validates/caches this metadata.
const network = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@better-auth/cimd/node", () => ({ fetchClientMetadataResource: network.fetch }));
const clientId = "https://client.example/metadata.json";
const callback = "https://client.example/callback";
const metadata = { client_id: clientId, client_name: "Test <client>", redirect_uris: [callback],
  token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] };
const owner = { name: "Owner", email: "owner@example.com", password: "test-only password 9473!" };
let dir: string, root: string, config: BridgeConfig, origin: string, base: string;
let bridge: Awaited<ReturnType<typeof createBridgeHttpServer>> | undefined;
let child: ChildProcess | undefined;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  dir = await makeTempDir("localbridge-oauth-"); root = path.join(dir, "files"); await fs.mkdir(root);
  origin = `https://auth-${randomBytes(6).toString("hex")}.example`;
  config = parseConfig({ allowedDirectories: [root] }, { AUTH_MODE: "oauth", PUBLIC_ORIGIN: origin,
    BETTER_AUTH_SECRET: randomBytes(48).toString("base64url"), DATABASE_PATH: path.join(dir, "state", "auth.sqlite") });
  network.fetch.mockReset();
  network.fetch.mockImplementation(async () => Response.json(metadata, { headers: { "Cache-Control": "max-age=3600" } }));
});
afterEach(async () => {
  if (child?.connected) { const exited = once(child, "exit"); child.send({ command: "stop" }); await exited; }
  child = undefined;
  await bridge?.close(); bridge = undefined; vi.restoreAllMocks(); await fs.rm(dir, { recursive: true, force: true });
});
async function startChild(document: Record<string, unknown> = metadata) {
  child = fork(fileURLToPath(new URL("./fixtures/oauth-server.mjs", import.meta.url)), [], {
    execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const ready = once(child, "message");
  child.send({ command: "start", config, metadata: document });
  const [reply] = await ready;
  expect(reply.error).toBeUndefined(); expect(reply.pid).not.toBe(process.pid); base = reply.base;
}
async function start() {
  bridge = await createBridgeHttpServer(config);
  await new Promise<void>(resolve => bridge!.server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(bridge.server.address() as AddressInfo).port}`;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `${origin}/api/auth/jwks`) return realFetch(`${base}/api/auth/jwks`, init);
    if (url.startsWith("https:")) throw new Error("Unexpected external test networking");
    return realFetch(input, init);
  });
}
async function ready() { await migrateAuth(config); await createOwner(config, owner); await start(); }
async function request(route: string, body?: unknown, cookie?: string) {
  return realFetch(base + route, { redirect: "manual", method: body === undefined ? "GET" : "POST",
    headers: { Origin: origin, Accept: "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function token(body: Record<string, string>) {
  return realFetch(`${base}/api/auth/oauth2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
}
function authorization(overrides: Record<string, string> = {}) {
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({ client_id: clientId, redirect_uri: callback, response_type: "code", scope: "files offline_access",
    state: "test-state", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource: config.mcpResource, ...overrides });
  return { verifier, route: `/api/auth/oauth2/authorize?${query}` };
}
async function loginFlow(overrides: Record<string, string> = {}) {
  const flow = authorization(overrides);
  const response = await realFetch(base + flow.route, { redirect: "manual", headers: { Accept: "text/html", "Sec-Fetch-Mode": "navigate" } });
  expect(response.status, await response.clone().text()).toBe(200);
  const login = new URL((await response.json()).url, origin);
  expect(login.pathname).toBe("/sign-in");
  const signed = login.searchParams.toString();
  const signin = await request("/api/auth/sign-in/email", { ...owner, oauth_query: signed });
  expect(signin.status, await signin.clone().text()).toBe(200);
  const cookies = signin.headers.getSetCookie();
  expect(cookies.join(";")).toContain("Secure"); expect(cookies.join(";")).toContain("HttpOnly");
  const cookie = cookies.map(value => value.split(";")[0]).join("; ");
  const result = await signin.json();
  const consent = new URL(result.url ?? result.redirect_uri, origin);
  expect(consent.pathname, JSON.stringify(result)).toBe("/consent");
  return { ...flow, cookie, signed, consentQuery: consent.searchParams.toString() };
}
async function authorizedCode() {
  const flow = await loginFlow();
  const response = await request("/api/auth/oauth2/consent", { accept: true, oauth_query: flow.consentQuery }, flow.cookie);
  expect(response.status, await response.clone().text()).toBe(200);
  const redirect = new URL((await response.json()).url);
  expect(redirect.origin + redirect.pathname).toBe(callback);
  expect(redirect.searchParams.get("state")).toBe("test-state");
  const code = redirect.searchParams.get("code")!;
  const exchange = { grant_type: "authorization_code", code, client_id: clientId, redirect_uri: callback, code_verifier: flow.verifier, resource: config.mcpResource };
  return { ...flow, exchange };
}
async function grant() {
  const flow = await authorizedCode();
  const exchange = flow.exchange;
  const tokens = await token(exchange);
  expect(tokens.status, await tokens.clone().text()).toBe(200);
  return { ...flow, tokens: await tokens.json() };
}

describe("OAuth lifecycle and guarded startup", () => {
  it("migrates idempotently, creates only one owner, and keeps signing keys", async () => {
    await migrateAuth(config); const db = new Database(config.oauth!.databasePath);
    const keys = db.prepare("SELECT * FROM jwks").all(); db.close();
    await migrateAuth(config); await createOwner(config, owner);
    await expect(createOwner(config, owner)).rejects.toThrow("already exists");
    const check = new Database(config.oauth!.databasePath);
    expect(check.prepare("SELECT * FROM jwks").all()).toEqual(keys);
    expect((check.prepare('SELECT count(*) AS n FROM "user"').get() as { n: number }).n).toBe(1); check.close();
    await start();
  });
  it("fails closed without schema/owner, with multiple owners, or changed secret", async () => {
    await expect(createBridgeHttpServer(config)).rejects.toThrow();
    await migrateAuth(config); await expect(createBridgeHttpServer(config)).rejects.toThrow("exactly one owner");
    await createOwner(config, owner);
    const wrong = { ...config, oauth: { ...config.oauth!, secret: randomBytes(48).toString("hex") } };
    await expect(createBridgeHttpServer(wrong)).rejects.toThrow();
    const db = new Database(config.oauth!.databasePath);
    db.exec(`INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES ('extra','Extra','extra@example.com',0,0,0)`); db.close();
    await expect(createBridgeHttpServer(config)).rejects.toThrow("exactly one owner");
  });
  it("serializes admin/server state access and excludes the state directory", async () => {
    await migrateAuth(config); const storage = await openAuthStorage(config);
    try { await expect(createOwner(config, owner)).rejects.toThrow("locked"); } finally { await storage.close(); }
    const bad = { ...config, allowedDirectories: [path.dirname(config.oauth!.databasePath)] };
    await expect(createBridgeHttpServer(bad)).rejects.toThrow("control state");
  });
  it("requires schema repair with a backup and refuses to recreate missing signing keys at startup", async () => {
    await migrateAuth(config); await createOwner(config, owner);
    const db = new Database(config.oauth!.databasePath);
    const keys = db.prepare("SELECT * FROM jwks").all();
    db.exec('DROP TABLE "rateLimit"'); db.close();
    await expect(createBridgeHttpServer(config)).rejects.toThrow("schema");
    await migrateAuth(config);
    const backups = (await fs.readdir(path.dirname(config.oauth!.databasePath))).filter(name => name.endsWith(".bak"));
    expect(backups).toHaveLength(1);
    const backup = new Database(path.join(path.dirname(config.oauth!.databasePath), backups[0]!), { readonly: true });
    expect(backup.prepare("SELECT * FROM jwks").all()).toEqual(keys); backup.close();
    const changed = new Database(config.oauth!.databasePath); changed.exec("DELETE FROM jwks"); changed.close();
    await expect(createBridgeHttpServer(config)).rejects.toThrow("signing keys are missing");
    const checked = new Database(config.oauth!.databasePath); expect(checked.prepare("SELECT * FROM jwks").all()).toEqual([]); checked.close();
  });
  it("switches to none without altering the OAuth database", async () => {
    await migrateAuth(config); await createOwner(config, owner);
    const previous = await fs.readFile(config.oauth!.databasePath);
    const none = parseConfig({ allowedDirectories: [root] }, { PUBLIC_ORIGIN: origin, AUTH_MODE: "none", ACK_UNAUTHENTICATED_FILESYSTEM_ACCESS: UNAUTHENTICATED_ACCESS_ACK });
    const server = await createBridgeHttpServer(none); await server.close();
    expect(await fs.readFile(config.oauth!.databasePath)).toEqual(previous);
    await start();
  });
});

describe("OAuth routes and browser boundaries", () => {
  it("preserves browser redirects and canonical URLs behind spoofed forwarding headers", async () => {
    await ready();
    const response = await new Promise<{ status: number; location?: string }>((resolve, reject) => {
      httpGet(base + authorization().route, { headers: { Accept: "text/html", "Sec-Fetch-Mode": "navigate",
        Host: new URL(origin).host, "X-Forwarded-Host": "evil.example", "X-Forwarded-Proto": "http" } }, res => {
        res.resume(); res.on("end", () => resolve({ status: res.statusCode!, location: res.headers.location }));
      }).on("error", reject);
    });
    expect(response.status).toBe(302);
    const login = new URL(response.location!, origin);
    expect(login.origin).toBe(origin); expect(login.pathname).toBe("/sign-in");
    expect(login.searchParams.get("resource")).toBe(config.mcpResource);
  });
  it("serves canonical discovery, S256/CIMD/grants, and no DCR or alternate account routes", async () => {
    await ready();
    const resource = await (await request("/.well-known/oauth-protected-resource")).json();
    expect(resource).toMatchObject({ resource: config.mcpResource, authorization_servers: [origin], scopes_supported: ["files"] });
    expect(await (await request("/.well-known/oauth-protected-resource/mcp")).json()).toEqual(resource);
    const discovery = await (await request("/.well-known/oauth-authorization-server")).json();
    expect(discovery).toMatchObject({ issuer: origin, jwks_uri: origin + "/api/auth/jwks", code_challenge_methods_supported: ["S256"], client_id_metadata_document_supported: true });
    expect(discovery.grant_types_supported.sort()).toEqual(["authorization_code", "refresh_token"]);
    expect(discovery.registration_endpoint).toBeUndefined();
    for (const route of ["/api/auth/sign-up/email", "/api/auth/oauth2/register", "/api/auth/oauth2/create-client", "/api/auth/token", "/api/auth/sign-jwt", "/api/auth/admin/oauth2/create-client"]) {
      expect((await request(route, owner)).status).toBe(404);
    }
    const missing = await request("/mcp", {});
    expect(missing.status).toBe(401); expect(missing.headers.get("www-authenticate")).toContain(config.mcpResource.replace("/mcp", "/.well-known/oauth-protected-resource/mcp"));
  });
  it("uses CSP/text-only client display and rejects tampered continuation", async () => {
    await ready(); const flow = await loginFlow();
    const page = await request(`/consent?${flow.consentQuery}`);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await page.text()).not.toContain("Test <client>");
    const display = await request("/api/auth/oauth2/public-client-prelogin", { client_id: clientId, oauth_query: flow.consentQuery });
    expect((await display.json()).client_name).toBe(metadata.client_name);
    for (const oauth_query of [flow.consentQuery.replace("test-state", "evil-state"), "client_id=attacker", flow.consentQuery.replace(/exp=[^&]+/, "exp=1")]) {
      expect((await request("/api/auth/oauth2/consent", { accept: true, oauth_query }, flow.cookie)).status).toBeGreaterThanOrEqual(400);
    }
    expect((await request("/mcp", {}, flow.cookie)).status).toBe(401);
  });
  it("denies consent without issuing a code", async () => {
    await ready(); const flow = await loginFlow();
    const denied = await request("/api/auth/oauth2/consent", { accept: false, oauth_query: flow.consentQuery }, flow.cookie);
    const redirect = new URL((await denied.json()).url);
    expect(redirect.searchParams.get("error")).toBe("access_denied"); expect(redirect.searchParams.has("code")).toBe(false);
  });
  it("rate limits wrong passwords despite spoofed IPs and rejects foreign Origin", async () => {
    await ready();
    const cross = await realFetch(base + "/api/auth/sign-in/email", { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: JSON.stringify(owner) });
    expect(cross.status).toBe(403);
    for (let i = 0; i < 6; i++) {
      const reply = await realFetch(base + "/api/auth/sign-in/email", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-Forwarded-For": `8.8.8.${i}` }, body: JSON.stringify({ email: owner.email, password: "wrong-password" }) });
      expect(reply.status).toBe(i < 5 ? 401 : 429);
    }
  });
});

describe("code, token, refresh and filesystem integration", () => {
  it.each([false, true])("keeps shared path, root and size protections with OAuth (legacy=%s)", async legacy => {
    config = { ...config, filesystemLimits: { ...config.filesystemLimits, maxFileBytes: 128, maxReadBytesPerCall: 256 } };
    const outside = path.join(dir, "root-sibling"); await prepareBoundaryFixture(root, outside);
    await ready(); const flow = await grant();
    const authorizationHeader = { Authorization: `Bearer ${flow.tokens.access_token}` };
    const client = new Client({ name: "oauth-boundary", version: "1" }, { versionNegotiation: { mode: legacy ? "legacy" : { pin: "2026-07-28" } }, ...(legacy ? { supportedProtocolVersions: ["2025-11-25"] } : {}) });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: authorizationHeader } }));
      await exerciseBoundaryTools(client, root, outside, async () => {
        const response = await realFetch(base + "/mcp", { method: "POST", headers: { ...authorizationHeader, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Method": "notifications/roots/list_changed", "MCP-Protocol-Version": "2026-07-28" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/roots/list_changed", params: { roots: [{ uri: "file:///outside" }] } }) });
        expect(response.status).toBe(202); await response.text();
      });
    } finally { await client.close(); }
  });
  it.each([false, true])("executes all 14 tools through OAuth (legacy=%s)", async legacy => {
    await ready(); const flow = await grant();
    expect(flow.tokens).toMatchObject({ token_type: "Bearer", expires_in: 900 });
    expect(flow.tokens.refresh_token).toBeTypeOf("string");
    const claims = JSON.parse(Buffer.from(flow.tokens.access_token.split(".")[1], "base64url").toString());
    expect(claims).toMatchObject({ iss: origin, aud: config.mcpResource });
    expect(claims.scope.split(" ")).toContain("files");
    const client = new Client({ name: "oauth-test", version: "1" }, { versionNegotiation: { mode: legacy ? "legacy" : { pin: "2026-07-28" } }, ...(legacy ? { supportedProtocolVersions: ["2025-11-25"] } : {}) });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { Authorization: `Bearer ${flow.tokens.access_token}` } } }));
      expect((await client.listTools()).tools.every(t => JSON.stringify(t._meta).includes('"scopes":["files"]'))).toBe(true);
      await exerciseAllTools(client, root);
    } finally { await client.close(); }
    const refresh = { grant_type: "refresh_token", client_id: clientId, refresh_token: flow.tokens.refresh_token, resource: config.mcpResource };
    const renewed = await token(refresh); expect(renewed.status, await renewed.clone().text()).toBe(200);
    const next = await renewed.json(); expect(next.refresh_token).not.toBe(flow.tokens.refresh_token);
    expect(await (await token(refresh)).json()).toEqual(next);
    expect((await token(flow.exchange)).status).toBe(400);
  });
  it.each([
    { code_challenge_method: "plain" }, { code_challenge: "" }, { resource: "https://wrong.example/mcp" },
    { redirect_uri: callback + "/extra" }, { scope: "admin" },
  ] as Record<string, string>[])("rejects invalid authorization %j", async overrides => {
    await ready(); const response = await realFetch(base + authorization(overrides).route, { redirect: "manual", headers: { Accept: "text/html", "Sec-Fetch-Mode": "navigate" } });
    if (response.status === 200) expect((await response.json()).url).toContain("error=");
    else if (response.status === 302) expect(response.headers.get("location")).toContain("error=");
    else expect(response.status).toBeGreaterThanOrEqual(400);
  });
  it("rejects client credentials and wrong verifier", async () => {
    await ready();
    expect((await token({ grant_type: "client_credentials", client_id: clientId, scope: "files" })).status).toBe(400);
    const flow = await loginFlow();
    const consent = await request("/api/auth/oauth2/consent", { accept: true, oauth_query: flow.consentQuery }, flow.cookie);
    const code = new URL((await consent.json()).url).searchParams.get("code")!;
    const exchange = { grant_type: "authorization_code", code, client_id: clientId, redirect_uri: callback, code_verifier: "wrong".repeat(12), resource: config.mcpResource };
    expect((await token(exchange)).status).toBe(401);
  });
  it.each(["missing verifier", "wrong resource", "expired code"])("rejects %s at code exchange", async scenario => {
    await ready(); const flow = await authorizedCode();
    const exchange: Record<string, string> = { ...flow.exchange };
    if (scenario === "missing verifier") delete exchange.code_verifier;
    if (scenario === "wrong resource") exchange.resource = "https://other.example/mcp";
    if (scenario === "expired code") {
      const db = new Database(config.oauth!.databasePath);
      db.prepare('UPDATE verification SET expiresAt = ?').run(Date.now() - 1000); db.close();
    }
    expect((await token(exchange)).status).toBeGreaterThanOrEqual(400);
  });
  it("supports CIMD private_key_jwt plus PKCE and persists assertion replay protection", async () => {
    const pair = await generateKeyPair("ES256");
    const jwk = { ...await exportJWK(pair.publicKey), kid: "test-client-key", alg: "ES256", use: "sig" };
    const document = { ...metadata, token_endpoint_auth_method: "private_key_jwt", token_endpoint_auth_signing_alg: "ES256", jwks: { keys: [jwk] } };
    network.fetch.mockImplementation(async () => Response.json(document, { headers: { "Cache-Control": "max-age=3600" } }));
    await ready(); const flow = await authorizedCode();
    const assertion = await new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: jwk.kid, typ: "JWT" })
      .setIssuer(clientId).setSubject(clientId).setAudience(origin + "/api/auth/oauth2/token")
      .setIssuedAt().setExpirationTime("2m").setJti(randomBytes(16).toString("hex")).sign(pair.privateKey);
    const clientAssertion = { client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: assertion };
    const exchange = await token({ ...flow.exchange, ...clientAssertion });
    expect(exchange.status, await exchange.clone().text()).toBe(200);
    const tokens = await exchange.json();
    await bridge!.close(); bridge = undefined; await startChild(document);
    const replay = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token, resource: config.mcpResource, ...clientAssertion });
    expect(replay.status, await replay.clone().text()).toBe(400);
    const nextAssertion = await new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: jwk.kid, typ: "JWT" })
      .setIssuer(clientId).setSubject(clientId).setAudience(origin + "/api/auth/oauth2/token")
      .setIssuedAt().setExpirationTime("2m").setJti(randomBytes(16).toString("hex")).sign(pair.privateKey);
    const refresh = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token, resource: config.mcpResource,
      ...clientAssertion, client_assertion: nextAssertion });
    expect(refresh.status, await refresh.clone().text()).toBe(200);
  }, 15_000);
  it("rejects invalid signatures/issuer/audience/expiry/scope before any file write", async () => {
    await ready(); const flow = await grant();
    await bridge!.close(); bridge = undefined;
    const storage = await openAuthStorage(config); const auth = createAuth(config, storage.database);
    const claims = JSON.parse(Buffer.from(flow.tokens.access_token.split(".")[1], "base64url").toString());
    const tampered = flow.tokens.access_token.split(".").map((part: string, index: number) =>
      index === 2 ? (part[0] === "A" ? "B" : "A") + part.slice(1) : part).join(".");
    const invalid: [string, number][] = [["invalid", 401], [tampered, 401]];
    for (const payload of [{ ...claims, iss: "https://evil.example" }, { ...claims, aud: clientId }, { ...claims, exp: 1 }, { ...claims, sub: "not-the-owner" }, { ...claims, scope: "offline_access" }]) {
      invalid.push([(await auth.api.signJWT({ body: { payload } })).token, payload.scope === "offline_access" ? 403 : 401]);
    }
    await storage.close(); await start();
    for (const [accessToken, status] of invalid) {
      const reply = await realFetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "write_file", arguments: { path: path.join(root, "forbidden"), content: "bad" } } }) });
      expect(reply.status, await reply.clone().text()).toBe(status);
    }
    expect(await fs.readdir(root)).toEqual([]);
  });
  it("persists keys, access, refresh, consent, CIMD provenance and DPoP replay across process restart", async () => {
    await ready(); const flow = await grant();
    const jwks = await (await request("/api/auth/jwks")).json();
    await bridge!.close(); bridge = undefined;
    const storage = await openAuthStorage(config); const auth = createAuth(config, storage.database);
    const claims = JSON.parse(Buffer.from(flow.tokens.access_token.split(".")[1], "base64url").toString());
    const pair = await generateKeyPair("ES256"); const jwk = await exportJWK(pair.publicKey);
    const bound = (await auth.api.signJWT({ body: { payload: { ...claims, cnf: { jkt: await calculateJwkThumbprint(jwk) } } } })).token;
    const proof = await new SignJWT({ htm: "POST", htu: config.mcpResource, ath: createHash("sha256").update(bound).digest("base64url") })
      .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk }).setJti(randomBytes(12).toString("hex")).setIssuedAt().sign(pair.privateKey);
    await storage.close(); await start();
    const boundRequest = () => realFetch(base + "/mcp", { method: "POST", headers: { Authorization: `DPoP ${bound}`, DPoP: proof, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect((await boundRequest()).status).toBe(200);
    expect((await boundRequest()).status).toBe(401);
    await bridge!.close(); bridge = undefined;
    await startChild();
    expect(await (await request("/api/auth/jwks")).json()).toEqual(jwks);
    expect((await boundRequest()).status).toBe(401);
    const access = await realFetch(base + "/mcp", { method: "POST", headers: { Authorization: `Bearer ${flow.tokens.access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(access.status).toBe(200); expect(await access.text()).toContain("write_file");
    const renewed = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: flow.tokens.refresh_token, resource: config.mcpResource });
    expect(renewed.status, await renewed.clone().text()).toBe(200);
    const nextAuthorization = await request(authorization().route, undefined, flow.cookie);
    expect((await nextAuthorization.json()).url).toContain("code=");
    const db = new Database(config.oauth!.databasePath, { readonly: true });
    const client = db.prepare('SELECT * FROM "oauthClient"').get() as Record<string, unknown>;
    expect(JSON.stringify(client)).toContain("cimd"); db.close();
  }, 15_000);
  it("rejects refresh outside overlap and documents JWT revocation latency", async () => {
    await ready(); const flow = await grant();
    const refresh = { grant_type: "refresh_token", client_id: clientId, refresh_token: flow.tokens.refresh_token, resource: config.mcpResource };
    expect((await token({ ...refresh, resource: "https://wrong.example/mcp" })).status).toBe(400);
    const next = await (await token(refresh)).json();
    // Expire only the persisted overlap deadline, keeping real request timers.
    const db = new Database(config.oauth!.databasePath);
    db.prepare('UPDATE "oauthRefreshToken" SET rotationReplayExpiresAt = ? WHERE rotatedAt IS NOT NULL').run(Date.now() - 31_000);
    expect((await token(refresh)).status).toBe(400);
    expect((await token({ ...refresh, refresh_token: next.refresh_token })).status).toBe(400);
    const access = await realFetch(base + "/mcp", { method: "GET", headers: { Authorization: `Bearer ${flow.tokens.access_token}` } });
    expect(access.status).toBe(405); // Verified JWT reaches MCP until its 15-minute expiry.
    db.close();
  });
});

describe("CIMD plugin validation and caching", () => {
  it.each([
    ["mismatch", { ...metadata, client_id: "https://other.example/client.json" }],
    ["missing name", { ...metadata, client_name: undefined }],
    ["missing redirects", { ...metadata, redirect_uris: undefined }],
    ["malformed", "not an object"],
    ["oversized", { ...metadata, client_name: "x".repeat(6000) }],
  ])("rejects %s metadata", async (_name, document) => {
    network.fetch.mockImplementation(async () => Response.json(document)); await ready();
    const response = await request(authorization().route);
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
  it.each(["http://client.example/meta", "https://127.0.0.1/meta", "https://169.254.169.254/meta", "https://10.0.0.1/meta", "https://[::1]/meta"])("rejects nonpublic client URL %s before fetching", async client_id => {
    await ready(); const response = await request(authorization({ client_id }).route);
    if (response.status === 200) expect((await response.json()).url).toContain("error=");
    else expect(response.status).toBeGreaterThanOrEqual(400);
    expect(network.fetch).not.toHaveBeenCalled();
  });
  it("refuses redirect responses", async () => {
    network.fetch.mockImplementation(async () => new Response(null, { status: 302, headers: { Location: "https://127.0.0.1/secret" } }));
    await ready(); expect((await request(authorization().route)).status).toBeGreaterThanOrEqual(400);
    expect(network.fetch).toHaveBeenCalledTimes(1);
  });
  it("caches fresh documents, revalidates expired entries, and fails closed on fetch failure", async () => {
    network.fetch.mockImplementation(async () => Response.json(metadata, { headers: { "Cache-Control": "max-age=1", ETag: '"v1"' } }));
    await ready(); expect((await request(authorization().route)).status).toBe(200);
    expect((await request(authorization().route)).status).toBe(200); expect(network.fetch).toHaveBeenCalledTimes(1);
    const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 2000);
    network.fetch.mockRejectedValue(new Error("test transport failed"));
    expect((await request(authorization().route)).status).toBeGreaterThanOrEqual(400);
    expect(network.fetch).toHaveBeenCalledTimes(2);
  });
  it("cancels a metadata fetch after the library's five-second deadline", async () => {
    network.fetch.mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }));
    await ready(); expect((await request(authorization().route)).status).toBeGreaterThanOrEqual(400);
  }, 10_000);
});
