import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import dns from "node:dns/promises";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";

// Exercise the actual pinned Node transport while controlling DNS and sockets.
const network = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
beforeEach(() => {
  network.lookup.mockReset(); network.request.mockReset();
  vi.spyOn(dns, "lookup").mockImplementation(network.lookup);
  vi.spyOn(https, "request").mockImplementation(network.request);
  syncBuiltinESMExports();
});
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); });

describe("production CIMD DNS and pinned TLS transport", () => {
  it.each(["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1"])("refuses resolved special-use address %s before connecting", async address => {
    network.lookup.mockResolvedValue([{ address, family: address.includes(":") ? 6 : 4 }]);
    await expect(fetchClientMetadataResource("https://client.example/metadata")).rejects.toThrow("public-routable");
    expect(network.lookup).toHaveBeenCalledTimes(1); expect(network.request).not.toHaveBeenCalled();
  });
  it("rejects mixed public/private answers instead of selecting the public answer", async () => {
    network.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]);
    await expect(fetchClientMetadataResource("https://client.example/metadata")).rejects.toThrow("public-routable");
    expect(network.request).not.toHaveBeenCalled();
  });
  it("pins the validated answer for both Node lookup forms, preserves TLS identity, and never follows redirects", async () => {
    network.lookup.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }]).mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    network.request.mockImplementation((_url, options, callback) => {
      expect(options.agent).toBe(false); expect(options.servername).toBe("client.example");
      expect(options.headers.host).toBe("client.example");
      const single = vi.fn(), all = vi.fn();
      options.lookup("client.example", {}, single); options.lookup("client.example", { all: true }, all);
      expect(single).toHaveBeenCalledWith(null, "8.8.8.8", 4);
      expect(all).toHaveBeenCalledWith(null, [{ address: "8.8.8.8", family: 4 }]);
      const socket = Object.assign(new EventEmitter(), { end() {
        const response = Object.assign(Readable.from([]), { statusCode: 302, headers: { location: "https://127.0.0.1/secret" }, statusMessage: "Found" });
        callback(response);
      } });
      return socket;
    });
    const response = await fetchClientMetadataResource("https://client.example/metadata");
    expect(response.status).toBe(302); expect(network.lookup).toHaveBeenCalledTimes(1); expect(network.request).toHaveBeenCalledTimes(1);
  });
  it("rejects HTTP before DNS and fails closed on empty DNS results", async () => {
    await expect(fetchClientMetadataResource("http://client.example/metadata")).rejects.toThrow("HTTPS");
    expect(network.lookup).not.toHaveBeenCalled(); network.lookup.mockResolvedValue([]);
    await expect(fetchClientMetadataResource("https://client.example/metadata")).rejects.toThrow("no DNS");
  });
});
