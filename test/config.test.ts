import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertExposureAcknowledged,
  ConfigurationError,
  DEFAULT_FILESYSTEM_LIMITS,
  parseConfig,
  UNAUTHENTICATED_ACCESS_ACK,
} from "../src/config.js";

const root = path.resolve("test-fixtures");
const local = { allowedDirectories: [root] };
const environment = { PUBLIC_ORIGIN: "https://mcp.example.com" };

describe("owner-controlled configuration", () => {
  it.each(["none", "oauth"])("requires PUBLIC_ORIGIN in %s mode", (mode) => {
    expect(() => parseConfig(local, { AUTH_MODE: mode })).toThrow(/PUBLIC_ORIGIN/);
  });

  it("defaults to OAuth, loopback and finite limits with an explicit public origin", () => {
    const config = parseConfig(local, environment);
    expect(config).toMatchObject({
      authMode: "oauth", host: "127.0.0.1", port: 3000,
      publicOrigin: "https://mcp.example.com",
      mcpResource: "https://mcp.example.com/mcp",
      legacyMode: "stateless", maxRequestBodyBytes: 4 * 1024 * 1024,
      filesystemLimits: DEFAULT_FILESYSTEM_LIMITS,
      unauthenticatedAccessAcknowledged: false,
    });
  });

  it.each(["", "off", "NONE", " oauth"])("rejects invalid AUTH_MODE %j", (mode) => {
    expect(() => parseConfig(local, { ...environment, AUTH_MODE: mode })).toThrow(ConfigurationError);
  });

  it("requires no OAuth database, secret or owner just to parse none", () => {
    expect(parseConfig(local, { ...environment, AUTH_MODE: "none" }).authMode).toBe("none");
  });

  it.each([undefined, "", "true", `${UNAUTHENTICATED_ACCESS_ACK} `])(
    "refuses unacknowledged no-auth exposure even on loopback (%j)", (ack) => {
      const config = parseConfig(local, { ...environment,
        AUTH_MODE: "none", ACK_UNAUTHENTICATED_FILESYSTEM_ACCESS: ack,
      });
      expect(() => assertExposureAcknowledged(config)).toThrow(/public access/);
    },
  );

  it("accepts only the exact local acknowledgment for none", () => {
    const config = parseConfig(local, { ...environment,
      AUTH_MODE: "none", ACK_UNAUTHENTICATED_FILESYSTEM_ACCESS: UNAUTHENTICATED_ACCESS_ACK,
    });
    expect(() => assertExposureAcknowledged(config)).not.toThrow();
    expect(config.allowedDirectories).toEqual([root]);
  });

  it("does not require the no-auth acknowledgment for OAuth", () => {
    expect(() => assertExposureAcknowledged(parseConfig(local, environment))).not.toThrow();
  });

  it("rejects attempts to configure the mode/acknowledgment through the roots file", () => {
    expect(() => parseConfig({ ...local, AUTH_MODE: "none" }, environment)).toThrow();
    expect(() => parseConfig({ ...local, ACK_UNAUTHENTICATED_FILESYSTEM_ACCESS:
      UNAUTHENTICATED_ACCESS_ACK }, { ...environment, AUTH_MODE: "none" })).toThrow();
  });

  it.each([{}, { allowedDirectories: [] }, { allowedDirectories: [""] },
    { allowedDirectories: ["relative/path"] }, { allowedDirectories: [root + "\0"] }])(
    "rejects missing, empty or invalid roots: %j", (value) => {
      expect(() => parseConfig(value, environment)).toThrow(ConfigurationError);
    },
  );

  it.skipIf(process.platform !== "win32")("rejects ambiguous Windows root forms", () => {
    for (const value of ["C:relative", "\\relative", "\\\\?\\C:\\data", "\\\\.\\C:\\data"]) {
      expect(() => parseConfig({ allowedDirectories: [value] }, environment)).toThrow();
    }
  });

  it("makes defensive immutable copies of roots and limits", () => {
    const input = { allowedDirectories: [root], filesystemLimits: { maxFilesPerCall: 7 } };
    const config = parseConfig(input, environment);
    input.allowedDirectories.push(path.resolve("other"));
    input.filesystemLimits.maxFilesPerCall = 9;
    expect(config.allowedDirectories).toEqual([root]);
    expect(config.filesystemLimits.maxFilesPerCall).toBe(7);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.allowedDirectories)).toBe(true);
    expect(Object.isFrozen(config.filesystemLimits)).toBe(true);
  });

  it("allows partial local limits without changing other defaults", () => {
    const config = parseConfig({ ...local, maxRequestBodyBytes: 1234,
      filesystemLimits: { maxConcurrentTools: 2 } }, environment);
    expect(config.maxRequestBodyBytes).toBe(1234);
    expect(config.filesystemLimits).toEqual({ ...DEFAULT_FILESYSTEM_LIMITS, maxConcurrentTools: 2 });
  });

  it.each(Object.keys(DEFAULT_FILESYSTEM_LIMITS))("validates numeric limits: %s", (key) => {
    for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "2", null]) {
      expect(() => parseConfig({ ...local, filesystemLimits: { [key]: value } }, environment)).toThrow();
    }
  });

  it("rejects inconsistent budgets, overflowing timers and misspelled limits", () => {
    expect(() => parseConfig({ ...local, filesystemLimits: { maxReadBytesPerCall: 1 } }, environment)).toThrow();
    expect(() => parseConfig({ ...local, filesystemLimits: { maxOperationMs: 2_147_483_648 } }, environment)).toThrow();
    expect(() => parseConfig({ ...local, filesystemLimits: { maxFiles: 10 } }, environment)).toThrow();
    expect(() => parseConfig({ ...local, maxRequestBodyBytes: 0 }, environment)).toThrow();
  });

  it("keeps roots/limits out of remote or unrecognized environment fields", () => {
    const config = parseConfig(local, { ...environment, ALLOWED_DIRECTORIES: "C:\\",
      MAX_FILE_BYTES: "999999", HOST: "0.0.0.0", AUTH_MODE: "none",
      "X-ACK_UNAUTHENTICATED_FILESYSTEM_ACCESS": UNAUTHENTICATED_ACCESS_ACK });
    expect(config.allowedDirectories).toEqual([root]);
    expect(config.filesystemLimits).toEqual(DEFAULT_FILESYSTEM_LIMITS);
    expect(config.host).toBe("127.0.0.1");
    expect(() => assertExposureAcknowledged(config)).toThrow();
  });

  it.each(["", "http://example.com", "https://user:pass@example.com", "https://example.com/api",
    "https://example.com/?", "https://example.com/#", "not a URL"])(
    "rejects a noncanonical public origin: %s", (origin) => {
      expect(() => parseConfig(local, { ...environment, PUBLIC_ORIGIN: origin })).toThrow();
    },
  );

  it("accepts explicit origin, port and reject mode", () => {
    expect(parseConfig(local, { ...environment, PUBLIC_ORIGIN: "https://example.com/", PORT: "4000",
      MCP_LEGACY_MODE: "reject" })).toMatchObject({ publicOrigin: "https://example.com",
      mcpResource: "https://example.com/mcp", port: 4000, legacyMode: "reject" });
  });

  it.each(["0", "65536", "1.5", "3000junk", "", " 3000"])("rejects invalid port %j", (port) => {
    expect(() => parseConfig(local, { ...environment, PORT: port })).toThrow();
  });

  it("rejects an unsupported legacy mode", () => {
    expect(() => parseConfig(local, { ...environment, MCP_LEGACY_MODE: "stateful" })).toThrow();
  });
});
