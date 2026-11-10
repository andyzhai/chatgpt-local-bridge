import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { FilesystemLimits } from "../config.js";

export class BudgetError extends Error {
  constructor(readonly limit: string) {
    super(`Filesystem limit: ${limit}. Narrow the request or adjust local configuration; retry overload later.`);
  }
}

const context = new AsyncLocalStorage<OperationBudget>();
const active = new Set<OperationBudget>();
const idleWaiters = new Set<() => void>();
let activeFs = 0;
export const budget = () => context.getStore();

/** Call after stopping admission. OS operations and started mutations must
 * settle even when their HTTP exchange has already disconnected. */
export async function waitForFilesystemIdle(): Promise<void> {
  if (active.size === 0) return;
  await new Promise<void>(resolve => idleWaiters.add(resolve));
}

// Count JSON UTF-8 bytes without allocating the serialized response. Inputs are
// already bounded while collecting data; this also counts duplicated content.
export function jsonBytes(value: unknown, cap = Infinity): number {
  let bytes = 0;
  const add = (n: number) => { bytes += n; if (bytes > cap) throw new BudgetError("maxToolResponseBytes"); };
  const string = (s: string) => {
    add(2);
    for (let i = 0; i < s.length; i++) {
      if (i % 4096 === 0) budget()?.check();
      const c = s.charCodeAt(i);
      if (c === 34 || c === 92 || [8,9,10,12,13].includes(c)) add(2);
      else if (c < 32) add(6);
      else if (c < 128) add(1);
      else if (c < 2048) add(2);
      else if (c >= 0xd800 && c <= 0xdbff && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) { add(4); i++; }
      else if (c >= 0xd800 && c <= 0xdfff) add(6);
      else add(3);
    }
  };
  const visit = (v: unknown): void => {
    if (typeof v === "string") string(v);
    else if (Array.isArray(v)) { add(2 + Math.max(0,v.length-1)); for (const item of v) visit(item); }
    else if (v && typeof v === "object") {
      add(2); let first = true;
      for (const [key, item] of Object.entries(v)) {
        if (item === undefined) continue;
        add(first ? 1 : 2); first = false; string(key); visit(item);
      }
    } else add(JSON.stringify(v ?? null).length);
  };
  visit(value); return bytes;
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: { content: text } };
}
export function checkTextResult(text: string): void { budget()?.result(textResult(text)); }

export class OperationBudget {
  readonly deadline: number;
  readBytes = 0;
  entries = 0;
  reserved = 0;
  committed = false;
  constructor(readonly limits: FilesystemLimits, readonly signal?: AbortSignal) {
    this.deadline = performance.now() + limits.maxOperationMs;
  }
  check(): void {
    if (this.committed) return; // Settle a started mutation and report its real outcome.
    if (this.signal?.aborted) throw new BudgetError("cancelled");
    if (performance.now() >= this.deadline) throw new BudgetError("maxOperationMs");
  }
  remainingMs(): number { this.check(); return Math.max(1, this.deadline-performance.now()); }
  fileBytes(n: number): void { this.check(); if (n > this.limits.maxFileBytes) throw new BudgetError("maxFileBytes"); }
  read(n: number, fileTotal: number): void {
    this.check(); this.readBytes += n;
    if (this.readBytes > this.limits.maxReadBytesPerCall) throw new BudgetError("maxReadBytesPerCall");
    this.fileBytes(fileTotal);
  }
  files(n: number): void { this.check(); if (n > this.limits.maxFilesPerCall) throw new BudgetError("maxFilesPerCall"); }
  entry(): void { this.check(); if (++this.entries > this.limits.maxEntriesVisited) throw new BudgetError("maxEntriesVisited"); }
  depth(n: number): void { this.check(); if (n > this.limits.maxTraversalDepth) throw new BudgetError("maxTraversalDepth"); }
  responseEstimate(n: number): void { this.check(); if (n > this.limits.maxToolResponseBytes) throw new BudgetError("maxToolResponseBytes"); }
  reserveText(text: string): void { this.reserved += 2 * jsonBytes(text); this.responseEstimate(this.reserved); }
  result(value: unknown): void { this.check(); jsonBytes(value, this.limits.maxToolResponseBytes); }
  commit(): void { this.check(); this.committed = true; }
}

export async function fsOperation<T>(fn: () => Promise<T>, cleanup = false): Promise<T> {
  const current = budget();
  if (!current) return fn();
  if (!cleanup) current.check();
  const cap = Math.min(...[...active].map(b => b.limits.maxConcurrentFsOps));
  if (!cleanup && activeFs >= cap) throw new BudgetError("maxConcurrentFsOps (retryable overload)");
  activeFs++;
  try { return await fn(); } finally { activeFs--; }
}

export async function runTool(limits: FilesystemLimits, signal: AbortSignal | undefined,
  fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  const current = new OperationBudget(limits, signal);
  try {
    const cap = Math.min(limits.maxConcurrentTools, ...[...active].map(b => b.limits.maxConcurrentTools));
    if (active.size >= cap) throw new BudgetError("maxConcurrentTools (retryable overload)");
    active.add(current);
    return await context.run(current, async () => {
      current.check();
      const result = await fn();
      current.result(result);
      return result;
    });
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    if (Buffer.byteLength(message) > limits.maxToolResponseBytes / 2) message = "Filesystem error; narrow the request.";
    return { isError: true, content: [{ type: "text", text: message }] };
  } finally {
    active.delete(current);
    if (active.size === 0) {
      for (const resolve of idleWaiters) resolve();
      idleWaiters.clear();
    }
  }
}

export async function sequentialMap<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (const item of items) { budget()?.check(); results.push(await fn(item)); }
  return results;
}
