// Isolated process: V8 GC is explicit, so retained-memory measurements are not
// polluted by the test runner or other suites. Only disposable files are used.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createFilesystemServer } from "../../src/filesystem/server.ts";

assert.equal(typeof global.gc, "function", "Run with --expose-gc");
const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "localbridge-load-")));
let server, client;
const originalOpen = fs.open, originalOpendir = fs.opendir;
const handles = new Set();
let opens = 0, closes = 0, maxHandles = 0, maxReadChunk = 0, bytesRead = 0;
function track(handle) {
  handles.add(handle); opens++; maxHandles = Math.max(maxHandles, handles.size);
  const close = handle.close.bind(handle);
  handle.close = async () => { await close(); handles.delete(handle); closes++; };
  return handle;
}
const snapshot = () => {
  global.gc();
  const { heapUsed, rss, external } = process.memoryUsage();
  return { heapUsed, rss, external, activeResources: process.getActiveResourcesInfo().sort(), trackedHandles: handles.size };
};
try {
  const file = path.join(dir, "file"), image = path.join(dir, "image.png"), wide = path.join(dir, "wide");
  await fs.writeFile(file, "x".repeat(4096)); await fs.writeFile(image, Buffer.alloc(4096)); await fs.mkdir(wide);
  for (let i = 0; i < 60; i++) await fs.writeFile(path.join(wide, `${i}-${"n".repeat(80)}`), "");
  server = await createFilesystemServer([dir], { filesystemLimits: {
    maxFileBytes: 8192, maxReadBytesPerCall: 8192, maxToolResponseBytes: 2048, maxEntriesVisited: 20,
  } });
  client = new Client({ name: "resource-probe", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  fs.open = async (...args) => {
    const handle = track(await originalOpen(...args)), read = handle.read.bind(handle);
    handle.read = async (...readArgs) => {
      const result = await read(...readArgs); bytesRead += result.bytesRead;
      maxReadChunk = Math.max(maxReadChunk, result.bytesRead); return result;
    };
    return handle;
  };
  fs.opendir = async (...args) => track(await originalOpendir(...args));
  const calls = [
    ["read_text_file", { path: file }], ["read_media_file", { path: image }],
    ["directory_tree", { path: wide }], ["search_files", { path: wide, pattern: "no-match" }],
    ["read_multiple_files", { paths: Array.from({ length: 50 }, (_, i) => path.join(dir, `missing-${i}`)) }],
    ["edit_file", { path: file, edits: [{ oldText: "x".repeat(4096), newText: "y".repeat(4096) }] }],
  ];
  let maxResultBytes = 0;
  async function cycle() {
    for (const [name, args] of calls) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, name);
      assert.match(result.content[0].text, /Filesystem limit:/, name);
      const bytes = Buffer.byteLength(JSON.stringify(result)); maxResultBytes = Math.max(maxResultBytes, bytes);
      assert.ok(bytes <= 2048, `${name} response bytes`);
      assert.equal(handles.size, 0, `${name} leaked a file/directory handle`);
    }
  }
  for (let i = 0; i < 10; i++) await cycle();
  await new Promise(resolve => setImmediate(resolve));
  const baseline = snapshot(), samples = [];
  const started = performance.now();
  for (let batch = 0; batch < 3; batch++) {
    for (let i = 0; i < 40; i++) await cycle();
    await new Promise(resolve => setImmediate(resolve)); samples.push(snapshot());
  }
  assert.equal(await fs.readFile(file, "utf8"), "x".repeat(4096), "failed edits changed the fixture");
  assert.equal(opens, closes);
  const final = samples.at(-1);
  const retainedHeapGrowth = final.heapUsed - baseline.heapUsed;
  const peakRssGrowth = Math.max(...samples.map(s => s.rss)) - baseline.rss;
  // Broad cross-platform regression ceilings, not promises about production RAM.
  assert.ok(retainedHeapGrowth < 24 * 1024 * 1024, "retained heap grew by 24 MiB");
  assert.ok(peakRssGrowth < 96 * 1024 * 1024, "RSS grew by 96 MiB");
  assert.deepEqual(final.activeResources, baseline.activeResources, "active Node resources grew");
  assert.ok(maxReadChunk <= 8193);
  console.log(JSON.stringify({ platform: process.platform, node: process.version, measuredFailures: 720,
    elapsedMs: Math.round(performance.now() - started), retainedHeapGrowth, peakRssGrowth,
    maxResultBytes, maxReadChunk, bytesRead, maxHandles, opens, closes, baseline, samples }));
} finally {
  fs.open = originalOpen; fs.opendir = originalOpendir;
  await client?.close(); await server?.close();
  await fs.rm(dir, { recursive: true, force: true });
}
