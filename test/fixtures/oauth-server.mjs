// A fresh process, real SQLite/auth/HTTP, isolated test networking only.
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "@better-auth/cimd/node") return { url: new URL("./oauth-metadata.mjs", import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
} });
let bridge;
process.on("message", async message => {
  try {
    if (message.command === "start") {
      globalThis.fixtureMetadata = message.metadata;
      const { createBridgeHttpServer } = await import("../../src/http.ts");
      bridge = await createBridgeHttpServer(message.config);
      await new Promise(resolve => bridge.server.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${bridge.server.address().port}`;
      const realFetch = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url === message.config.publicOrigin + "/api/auth/jwks") return realFetch(base + "/api/auth/jwks", init);
        if (url.startsWith("https:")) throw new Error("Unexpected external networking");
        return realFetch(input, init);
      };
      process.send({ base, pid: process.pid });
    } else {
      await bridge?.close(); process.disconnect();
    }
  } catch {
    process.send({ error: "Isolated OAuth process failed" });
    await bridge?.close(); process.disconnect(); process.exitCode = 1;
  }
});
