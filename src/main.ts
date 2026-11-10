import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseConfig } from "./config.js";
import { createBridgeHttpServer } from "./http.js";

/** Load only explicit local operator inputs. Node's --env-file flag can load
 * .env; no HTTP input participates in startup configuration. */
export async function startBridge(configFile = "config.json", environment = process.env) {
  const configPath = path.resolve(configFile);
  const config = parseConfig(JSON.parse(await fs.readFile(configPath, "utf8")), environment);
  const bridge = await createBridgeHttpServer(config, [configPath, path.resolve(".env")]);
  try {
    await new Promise<void>((resolve, reject) => {
      bridge.server.once("error", reject);
      bridge.server.listen(config.port, config.host, () => {
        bridge.server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await bridge.close();
    throw error;
  }
  console.warn(`LocalBridge AUTH_MODE=${config.authMode} listening at http://${config.host}:${config.port}/mcp; legacy=${config.legacyMode}.` +
    (config.authMode === "none" ? " Anyone who can reach this endpoint can read and modify allowed files." : " OAuth files scope required."));
  return bridge;
}

async function main(): Promise<void> {
  if (process.argv.length > 3) throw new Error("Usage: node dist/main.js [local-config.json]");
  const bridge = await startBridge(process.argv[2]);
  const shutdown = () => {
    void bridge.close().then(() => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
    }).catch(error => {
      console.error("LocalBridge shutdown failed:", error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main().catch(error => {
    console.error("LocalBridge startup failed:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
