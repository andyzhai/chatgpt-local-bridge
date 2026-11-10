import path from "node:path";
import { z } from "zod";

export const UNAUTHENTICATED_ACCESS_ACK =
  "I_UNDERSTAND_PUBLIC_READ_WRITE_ACCESS";

const MiB = 1024 * 1024;
export const DEFAULT_FILESYSTEM_LIMITS = Object.freeze({
  maxFileBytes: 8 * MiB,
  maxReadBytesPerCall: 16 * MiB,
  maxToolResponseBytes: 8 * MiB,
  maxFilesPerCall: 100,
  maxEntriesVisited: 10_000,
  maxTraversalDepth: 32,
  maxOperationMs: 30_000,
  maxConcurrentTools: 4,
  maxConcurrentFsOps: 8,
});

const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const filesystemLimitsSchema = z.strictObject({
  maxFileBytes: positiveInteger.default(DEFAULT_FILESYSTEM_LIMITS.maxFileBytes),
  maxReadBytesPerCall: positiveInteger.default(DEFAULT_FILESYSTEM_LIMITS.maxReadBytesPerCall),
  maxToolResponseBytes: positiveInteger.default(DEFAULT_FILESYSTEM_LIMITS.maxToolResponseBytes),
  maxFilesPerCall: positiveInteger.default(DEFAULT_FILESYSTEM_LIMITS.maxFilesPerCall),
  maxEntriesVisited: positiveInteger.default(DEFAULT_FILESYSTEM_LIMITS.maxEntriesVisited),
  maxTraversalDepth: positiveInteger.default(DEFAULT_FILESYSTEM_LIMITS.maxTraversalDepth),
  // Node timers overflow above a signed 32-bit millisecond delay.
  maxOperationMs: positiveInteger.max(2_147_483_647).default(DEFAULT_FILESYSTEM_LIMITS.maxOperationMs),
  maxConcurrentTools: positiveInteger.default(DEFAULT_FILESYSTEM_LIMITS.maxConcurrentTools),
  maxConcurrentFsOps: positiveInteger.default(DEFAULT_FILESYSTEM_LIMITS.maxConcurrentFsOps),
}).refine((limits) => limits.maxReadBytesPerCall >= limits.maxFileBytes, {
  message: "must be at least maxFileBytes",
  path: ["maxReadBytesPerCall"],
});

function isFullyQualifiedLocalPath(value: string): boolean {
  if (value.includes("\0")) return false;
  if (process.platform !== "win32") return path.isAbsolute(value);
  // Reject drive-relative/root-relative and device namespace paths. UNC roots
  // remain possible; the filesystem factory validates existence and confinement.
  const windowsPath = value.replaceAll("/", "\\");
  if (/^\\\\[?.]\\/.test(windowsPath)) return false;
  return /^[a-z]:\\/i.test(windowsPath) ||
    /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(windowsPath);
}

const localConfigSchema = z.strictObject({
  allowedDirectories: z.array(z.string().min(1).refine(isFullyQualifiedLocalPath, {
    message: "must be a fully qualified absolute path without null bytes or device prefixes",
  })).min(1),
  filesystemLimits: filesystemLimitsSchema.prefault({}),
  maxRequestBodyBytes: positiveInteger.default(4 * MiB),
});

function isHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      (value === url.origin || value === `${url.origin}/`);
  } catch {
    return false;
  }
}

const environmentSchema = z.object({
  AUTH_MODE: z.enum(["none", "oauth"]).default("oauth"),
  PUBLIC_ORIGIN: z.string().refine(isHttpsOrigin, {
    message: "must be an HTTPS origin with no credentials, path, query or fragment",
  }),
  PORT: z.string().regex(/^[0-9]+$/).transform(Number)
    .pipe(z.number().int().min(1).max(65_535)).default(3000),
  MCP_LEGACY_MODE: z.enum(["stateless", "reject"]).default("stateless"),
});

export type FilesystemLimits = Readonly<z.infer<typeof filesystemLimitsSchema>>;
export interface BridgeConfig {
  readonly authMode: "none" | "oauth";
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly publicOrigin: string;
  readonly mcpResource: string;
  readonly legacyMode: "stateless" | "reject";
  readonly allowedDirectories: readonly string[];
  readonly filesystemLimits: FilesystemLimits;
  readonly maxRequestBodyBytes: number;
  readonly unauthenticatedAccessAcknowledged: boolean;
  readonly authDatabasePath: string;
  readonly oauth?: Readonly<{ databasePath: string; secret: string }>;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function parse<T>(schema: z.ZodType<T>, input: unknown, source: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues.map((issue) =>
      `${issue.path.join(".") || source}: ${issue.message}`).join("; ");
    throw new ConfigurationError(`Invalid ${source}: ${details}`);
  }
  return result.data;
}

/** Parse owner-controlled roots and limits without HTTP environment requirements.
 * The filesystem factory separately validates real roots and control-state overlap. */
export function parseLocalConfig(localConfig: unknown) {
  return parse(localConfigSchema, localConfig, "local config");
}

/** Parse owner-controlled local and HTTP configuration without I/O or auth side effects. */
export function parseConfig(
  localConfig: unknown,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): BridgeConfig {
  const local = parseLocalConfig(localConfig);
  const env = parse(environmentSchema, {
    AUTH_MODE: environment.AUTH_MODE,
    PUBLIC_ORIGIN: environment.PUBLIC_ORIGIN,
    PORT: environment.PORT,
    MCP_LEGACY_MODE: environment.MCP_LEGACY_MODE,
  }, "environment");
  const publicOrigin = new URL(env.PUBLIC_ORIGIN).origin;
  return Object.freeze({
    authMode: env.AUTH_MODE,
    host: "127.0.0.1",
    port: env.PORT,
    publicOrigin,
    mcpResource: `${publicOrigin}/mcp`,
    legacyMode: env.MCP_LEGACY_MODE,
    allowedDirectories: Object.freeze([...local.allowedDirectories]),
    filesystemLimits: Object.freeze(local.filesystemLimits),
    maxRequestBodyBytes: local.maxRequestBodyBytes,
    authDatabasePath: path.resolve(environment.DATABASE_PATH || "data/auth.sqlite"),
    unauthenticatedAccessAcknowledged:
      environment.ACK_UNAUTHENTICATED_FILESYSTEM_ACCESS === UNAUTHENTICATED_ACCESS_ACK,
    ...(env.AUTH_MODE === "oauth" && environment.BETTER_AUTH_SECRET ? { oauth: Object.freeze({
      databasePath: path.resolve(environment.DATABASE_PATH || "data/auth.sqlite"),
      secret: environment.BETTER_AUTH_SECRET,
    }) } : {}),
  });
}

/** Required before any normal no-auth HTTP server is constructed, even on loopback.
 * This acknowledgment is not an OAuth readiness check or permission to expose
 * a listener. OAuth readiness is checked separately before listening.
 */
export function assertExposureAcknowledged(config: BridgeConfig): void {
  if (config.authMode === "none" && !config.unauthenticatedAccessAcknowledged) {
    throw new ConfigurationError(
      "AUTH_MODE=none requires the local ACK_UNAUTHENTICATED_FILESYSTEM_ACCESS " +
      "acknowledgment: public access permits filesystem reads and writes within allowed directories.",
    );
  }
}

export function requireOAuthConfig(config: BridgeConfig) {
  if (!config.oauth || config.oauth.secret.length < 32 || !config.oauth.secret.trim()) {
    throw new ConfigurationError("AUTH_MODE=oauth requires a persistent BETTER_AUTH_SECRET of at least 32 characters.");
  }
  return config.oauth;
}
