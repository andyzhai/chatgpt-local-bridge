// Keep upstream path/write logic, but bound allocation and I/O at its edges.
import nativeFs, { type FileHandle } from "fs/promises";
import type { Dirent } from "node:fs";
import { budget, fsOperation, jsonBytes } from "./budget.js";

async function open(...args: Parameters<typeof nativeFs.open>): Promise<FileHandle> {
  const safeArgs = [...args] as Parameters<typeof nativeFs.open>;
  if (budget() && safeArgs[1] === "r") safeArgs[1] = nativeFs.constants.O_RDONLY | (nativeFs.constants.O_NONBLOCK ?? 0);
  const handle = await fsOperation(() => nativeFs.open(...safeArgs));
  if (!budget()) return handle;
  if (args[1] === "r") {
    try {
      const stat = await fsOperation(() => handle.stat());
      if (!stat.isFile()) throw new Error(`Refusing to read: not a regular file: ${args[0]}`);
    } catch (error) { await fsOperation(() => handle.close(), true); throw error; }
  }
  let total = 0;
  return new Proxy(handle, { get(target, property) {
    if (property === "read") return async (buffer: Buffer, offset: number, length: number, position: number) => {
      const b = budget()!;
      const boundedLength = Math.min(length, b.limits.maxFileBytes - total + 1, b.limits.maxReadBytesPerCall - b.readBytes + 1);
      const result = await fsOperation(() => target.read(buffer, offset, boundedLength, position));
      total += result.bytesRead;
      b.read(result.bytesRead, total);
      return result;
    };
    const value: unknown = Reflect.get(target, property, target);
    if (typeof value !== "function") return value;
    return (...params: unknown[]) => fsOperation(async () => {
      if (property === "truncate" || property === "writeFile") budget()?.commit();
      return Reflect.apply(value, target, params);
    }, property === "close");
  } });
}

async function readFile(filePath: string): Promise<Buffer>;
async function readFile(filePath: string, encoding: BufferEncoding, enforceResponse?: boolean): Promise<string>;
async function readFile(filePath: string, encoding?: BufferEncoding, enforceResponse = true): Promise<Buffer | string> {
  if (!budget()) return encoding ? nativeFs.readFile(filePath, encoding) : nativeFs.readFile(filePath);
  const handle = await open(filePath, nativeFs.constants.O_RDONLY | (nativeFs.constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${stat.isDirectory() ? "EISDIR" : "Refusing to read"}: not a regular file: ${filePath}`);
    budget()!.fileBytes(stat.size);
    const chunks: Buffer[] = []; let position = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, budget()!.limits.maxFileBytes + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (!bytesRead) break;
      if (enforceResponse) budget()!.responseEstimate(2 * (position + bytesRead));
      chunks.push(chunk.subarray(0,bytesRead)); position += bytesRead;
    }
    const data = Buffer.concat(chunks, position);
    return encoding ? data.toString(encoding) : data;
  } finally { await handle.close(); }
}

async function readdir(filePath: string): Promise<string[]>;
async function readdir(filePath: string, options: {withFileTypes: true}): Promise<Dirent[]>;
async function readdir(filePath: string, options?: {withFileTypes: true}): Promise<string[] | Dirent[]> {
  if (!budget()) return options ? nativeFs.readdir(filePath, options) : nativeFs.readdir(filePath);
  const directory = await fsOperation(() => nativeFs.opendir(filePath));
  const entries: Dirent[] = [];
  let nameBytes = 0;
  try {
    for (;;) {
      const entry = await fsOperation(() => directory.read());
      if (!entry) break;
      budget()!.entry();
      // Bound materialized names too: counting entries alone permits a wide
      // directory of long names to exceed the response-sized scratch budget.
      nameBytes += jsonBytes(entry.name) + 1;
      budget()!.responseEstimate(nameBytes);
      entries.push(entry);
    }
  } finally { await fsOperation(() => directory.close(), true); }
  return options ? entries : entries.map(e => e.name);
}

const fs = {
  constants: nativeFs.constants, open, readFile, readdir,
  realpath: (...args: Parameters<typeof nativeFs.realpath>) => fsOperation(() => nativeFs.realpath(...args)),
  stat: (filePath: string) => fsOperation(() => nativeFs.stat(filePath)),
  lstat: (filePath: string) => fsOperation(() => nativeFs.lstat(filePath)),
  mkdir: (filePath: string, options: {recursive: true}) => fsOperation(() => {
    budget()?.commit(); return nativeFs.mkdir(filePath, options);
  }),
  writeFile: (filePath: string, content: string, options: {encoding: "utf-8"; flag: "wx"}) => fsOperation(async () => {
    budget()?.fileBytes(Buffer.byteLength(content)); budget()?.commit();
    try { return await nativeFs.writeFile(filePath, content, options); }
    catch (error) {
      // Exclusive open did not mutate anything. The checked overwrite still
      // needs a fresh cancellation/deadline check before its own commit.
      if ((error as NodeJS.ErrnoException).code === "EEXIST" && budget()) budget()!.committed = false;
      throw error;
    }
  }),
  rename: (source: string, destination: string) => fsOperation(() => {
    budget()?.commit(); return nativeFs.rename(source, destination);
  }),
};
export default fs;
