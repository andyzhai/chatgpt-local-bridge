import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FILESYSTEM_LIMITS, type FilesystemLimits } from "../src/config.js";
import { budget, runTool, textResult } from "../src/filesystem/budget.js";
import boundedFs from "../src/filesystem/bounded-fs.js";
import { call, connect, makeTempDir, textOf, type Connected } from "./upstream/helpers.js";

let dir: string;
const connections: Connected[] = [];
beforeEach(async () => { dir = await makeTempDir("localbridge-boundaries-"); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const connection of connections.splice(0)) await connection.close();
  await fs.rm(dir, { recursive: true, force: true });
});
async function client(overrides: Partial<FilesystemLimits>) {
  const connection = await connect([dir], { filesystem: { filesystemLimits: overrides } });
  connections.push(connection); return connection.client;
}

describe("resource boundaries and actual work", () => {
  it.each([15, 16, 17])("counts UTF-8 file bytes at %i bytes", async bytes => {
    const c = await client({ maxFileBytes: 16, maxReadBytesPerCall: 16 });
    const file = path.join(dir, "utf8"); await fs.writeFile(file, "unchanged");
    const content = "界".repeat(5) + "x".repeat(bytes - 15);
    const result = await call(c, "write_file", { path: file, content });
    expect(result.isError === true).toBe(bytes > 16);
    expect(await fs.readFile(file, "utf8")).toBe(bytes > 16 ? "unchanged" : content);
  });
  it.each([15, 16, 17])("counts aggregate read bytes at %i bytes and closes every handle", async bytes => {
    const c = await client({ maxFileBytes: 9, maxReadBytesPerCall: 16 });
    const files = [path.join(dir, "a"), path.join(dir, "b")];
    await fs.writeFile(files[0]!, "x".repeat(8)); await fs.writeFile(files[1]!, "x".repeat(bytes - 8));
    const open = fs.open.bind(fs); let read = 0, opened = 0, closed = 0, peakChunk = 0;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args); opened++;
      const originalRead = handle.read.bind(handle), originalClose = handle.close.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(async (...readArgs: Parameters<typeof handle.read>) => {
        const result = await originalRead(...readArgs);
        read += result.bytesRead; peakChunk = Math.max(peakChunk, result.bytesRead); return result;
      });
      vi.spyOn(handle, "close").mockImplementation(async () => { await originalClose(); closed++; });
      return handle;
    });
    const result = await call(c, "read_multiple_files", { paths: files });
    expect(result.isError === true).toBe(bytes > 16);
    expect(read).toBe(bytes); expect(peakChunk).toBeLessThanOrEqual(9); expect(closed).toBe(opened);
  });
  it.each([2, 3, 4])("checks multi-file input count %i before opening files", async count => {
    const c = await client({ maxFilesPerCall: 3 });
    const file = path.join(dir, "file"); await fs.writeFile(file, "ok");
    const open = vi.spyOn(fs, "open");
    const result = await call(c, "read_multiple_files", { paths: Array(count).fill(file) });
    expect(result.isError === true).toBe(count > 3);
    expect(open).toHaveBeenCalledTimes(count > 3 ? 0 : count);
  });
  it.each([4, 5, 6])("bounds visited entries at %i even for sparse/excluded results", async count => {
    const c = await client({ maxEntriesVisited: 5 });
    for (let i = 0; i < count; i++) await fs.writeFile(path.join(dir, `${i}`), "");
    const opendir = fs.opendir.bind(fs); let visited = 0, openHandles = 0;
    vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
      const handle = await opendir(...args), read = handle.read.bind(handle), close = handle.close.bind(handle);
      openHandles++;
      vi.spyOn(handle, "read").mockImplementation(async () => { const entry = await read(); if (entry) visited++; return entry; });
      vi.spyOn(handle, "close").mockImplementation(async () => { await close(); openHandles--; });
      return handle;
    });
    for (const name of ["list_directory", "list_directory_with_sizes", "directory_tree", "search_files"]) {
      visited = 0;
      const result = await call(c, name, { path: dir, pattern: "no-match", excludePatterns: ["**/*"] });
      expect(result.isError === true, name).toBe(count > 5);
      if (count > 5) expect(textOf(result)).toContain("maxEntriesVisited");
      expect(visited).toBe(Math.min(count, 6)); expect(openHandles).toBe(0);
    }
  });
  it.each([1, 2, 3])("checks traversal depth %i relative to the requested root", async depth => {
    const c = await client({ maxTraversalDepth: 2 });
    await fs.mkdir(path.join(dir, ...Array(depth).fill("d")), { recursive: true });
    for (const name of ["directory_tree", "search_files"]) {
      const result = await call(c, name, { path: dir, pattern: "**/*" });
      expect(result.isError === true, name).toBe(depth > 2);
    }
  });
  it("stops collecting long directory names before the intermediate buffer exceeds its cap", async () => {
    for (let i = 0; i < 30; i++) await fs.writeFile(path.join(dir, `${i}-${"x".repeat(100)}`), "");
    const opendir = fs.opendir.bind(fs); let visited = 0, closed = false;
    vi.spyOn(fs, "opendir").mockImplementationOnce(async (...args) => {
      const handle = await opendir(...args), read = handle.read.bind(handle), close = handle.close.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(async () => { visited++; return read(); });
      vi.spyOn(handle, "close").mockImplementation(async () => { await close(); closed = true; });
      return handle;
    });
    const result = await runTool({ ...DEFAULT_FILESYSTEM_LIMITS, maxToolResponseBytes: 512 }, undefined, async () => {
      await boundedFs.readdir(dir); return textResult("unexpected success");
    });
    expect(result.isError).toBe(true); expect(textOf(result)).toContain("maxToolResponseBytes");
    expect(visited).toBeLessThanOrEqual(6); expect(closed).toBe(true);
  });
  it("stops collecting multi-file error strings before visiting every failing input", async () => {
    const c = await client({ maxToolResponseBytes: 512 });
    const paths = Array.from({ length: 40 }, (_, i) => path.join(dir, `missing-${i}`));
    const realpath = vi.spyOn(fs, "realpath");
    const result = await call(c, "read_multiple_files", { paths });
    expect(result.isError).toBe(true); expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(512);
    expect(realpath.mock.calls.some(args => args[0] === paths.at(-1))).toBe(false);
  });
  it("rejects oversized edit inputs before reading and preserves the original", async () => {
    const c = await client({ maxFileBytes: 128, maxReadBytesPerCall: 128 });
    const file = path.join(dir, "edit"); await fs.writeFile(file, "original");
    const open = vi.spyOn(fs, "open");
    const result = await call(c, "edit_file", { path: file, edits: [{ oldText: "original", newText: "x".repeat(129) }] });
    expect(textOf(result)).toContain("maxFileBytes"); expect(open).not.toHaveBeenCalled();
    expect(await fs.readFile(file, "utf8")).toBe("original");
  });
  it("bounds whitespace indentation expansion before allocating the expanded string", async () => {
    const c = await client({ maxFileBytes: 256, maxReadBytesPerCall: 256 });
    const file = path.join(dir, "indent"), original = " ".repeat(32) + "old\n";
    await fs.writeFile(file, original);
    const newText = "\t".repeat(100) + "new", repeat = String.prototype.repeat;
    let oversizedAllocation = false;
    const spy = vi.spyOn(String.prototype, "repeat").mockImplementation(function (this: string, count: number) {
      if (String(this).length * count > 256) { oversizedAllocation = true; throw new Error("unbounded indentation allocation"); }
      return repeat.call(this, count);
    });
    let result;
    try { result = await call(c, "edit_file", { path: file, edits: [{ oldText: "\told", newText }] }); }
    finally { spy.mockRestore(); }
    expect(textOf(result)).toContain("maxFileBytes"); expect(oversizedAllocation).toBe(false);
    expect(await fs.readFile(file, "utf8")).toBe(original);
  });
  it.each([".png", ".wav", ".bin"])("checks the exact serialized media boundary for %s", async extension => {
    const file = path.join(dir, "media" + extension); await fs.writeFile(file, Buffer.alloc(512, 0xab));
    const reference = await call(await client({}), "read_media_file", { path: file });
    const size = Buffer.byteLength(JSON.stringify(reference));
    for (const cap of [size - 1, size, size + 1]) {
      const result = await call(await client({ maxToolResponseBytes: cap }), "read_media_file", { path: file });
      expect(result.isError === true).toBe(cap < size);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(cap);
    }
  });
  it.each(["create_directory", "move_file"])("preflights %s response before mutating", async name => {
    const c = await client({ maxToolResponseBytes: 512 });
    const parent = path.join(dir, "p".repeat(80)); await fs.mkdir(parent);
    const destination = path.join(parent, "d".repeat(100)), source = path.join(dir, "source");
    await fs.writeFile(source, "untouched");
    const result = await call(c, name, name === "move_file" ? { source, destination } : { path: destination });
    expect(textOf(result)).toContain("maxToolResponseBytes");
    await expect(fs.stat(destination)).rejects.toThrow(); expect(await fs.readFile(source, "utf8")).toBe("untouched");
  });
  it("stops traversal on cancellation and closes the open directory", async () => {
    for (let i = 0; i < 8; i++) await fs.writeFile(path.join(dir, `${i}`), "");
    const abort = new AbortController(), opendir = fs.opendir.bind(fs); let reads = 0, closed = false;
    vi.spyOn(fs, "opendir").mockImplementationOnce(async (...args) => {
      const handle = await opendir(...args), read = handle.read.bind(handle), close = handle.close.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(async () => { const entry = await read(); reads++; abort.abort(); return entry; });
      vi.spyOn(handle, "close").mockImplementation(async () => { await close(); closed = true; });
      return handle;
    });
    const result = await runTool(DEFAULT_FILESYSTEM_LIMITS, abort.signal, async () => {
      await boundedFs.readdir(dir); return textResult("unexpected success");
    });
    expect(textOf(result)).toContain("cancelled"); expect(reads).toBe(1); expect(closed).toBe(true);
  });
  it("retains the byte counter when a large head scan hits its limit", async () => {
    const file = path.join(dir, "large"); await fs.writeFile(file, "x".repeat(100_000));
    const { headFile } = await import("../src/filesystem/lib.js");
    let bytes = 0;
    const result = await runTool({ ...DEFAULT_FILESYSTEM_LIMITS, maxFileBytes: 1024, maxReadBytesPerCall: 1024 }, undefined, async () => {
      try { return textResult(await headFile(file, 1)); } finally { bytes = budget()!.readBytes; }
    });
    expect(result.isError).toBe(true); expect(bytes).toBe(1025);
  });
});
