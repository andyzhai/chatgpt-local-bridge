export {
  assertExposureAcknowledged,
  ConfigurationError,
  DEFAULT_FILESYSTEM_LIMITS,
  parseConfig,
  UNAUTHENTICATED_ACCESS_ACK,
} from "./config.js";
export type { BridgeConfig, FilesystemLimits } from "./config.js";
export { createFilesystemServer, createFilesystemServerFactory } from "./filesystem/server.js";
export { createBridgeHttpServer } from "./http.js";
export type { FilesystemServerOptions } from "./filesystem/roots.js";
