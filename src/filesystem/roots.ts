import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigurationError, parseLocalConfig, type FilesystemLimits } from "../config.js";
import { isPathWithinAllowedDirectories as contains } from "./path-validation.js";
import { fsOperation } from "./budget.js";

export interface FilesystemServerOptions {
  readonly filesystemLimits?: Partial<FilesystemLimits>;
  /** Additional owner-managed configuration, auth state, scripts and backups.
   * The application directory is always protected and cannot be overridden. */
  readonly controlPaths?: readonly string[];
  /** Descriptive HTTP integration metadata; never an authorization decision. */
  readonly toolMetadata?: Readonly<Record<string, unknown>>;
}

// Same location from src/filesystem and dist/filesystem.
export const APPLICATION_DIRECTORY = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

async function canonicalPotential(filePath: string): Promise<string> {
  try { return await fs.realpath(filePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(filePath);
    if (parent === filePath) throw error;
    return path.join(await canonicalPotential(parent), path.basename(filePath));
  }
}

export async function validateRoots(roots: readonly string[], options: FilesystemServerOptions) {
  const parsed = parseLocalConfig({allowedDirectories: [...roots], filesystemLimits: options.filesystemLimits});
  // Leave space for a bounded explanatory error and JSON-RPC framing.
  if (parsed.filesystemLimits.maxToolResponseBytes < 512) throw new ConfigurationError("maxToolResponseBytes must be at least 512");
  const controlPaths = [APPLICATION_DIRECTORY, ...(options.controlPaths ?? [])];
  const protectedPaths: string[] = [];
  for (const item of controlPaths) {
    if (!path.isAbsolute(item) || item.includes("\0")) throw new ConfigurationError("controlPaths must be absolute local paths");
    protectedPaths.push(path.resolve(item), await canonicalPotential(path.resolve(item)));
  }
  const aliases: {original: string; canonical: string}[] = [];
  for (const item of parsed.allowedDirectories) {
    const original = path.normalize(path.resolve(item));
    let canonical: string;
    try {
      canonical = await fs.realpath(original);
      if (!(await fs.stat(canonical)).isDirectory()) throw new Error("not a directory");
    } catch (error) { throw new ConfigurationError(`Invalid allowed directory ${original}: ${String(error)}`); }
    for (const root of [original, canonical]) for (const control of protectedPaths) {
      if (contains(root, [control]) || contains(control, [root])) throw new ConfigurationError(`Allowed directory overlaps application/control state: ${original}`);
    }
    aliases.push({original, canonical});
  }
  const allowedDirectories = Object.freeze([...new Set(aliases.flatMap(a => [a.original, a.canonical]))]);
  return {
    allowedDirectories,
    limits: parsed.filesystemLimits,
    async verifyRoots() {
      for (const {original, canonical} of aliases) {
        const actual = await fsOperation(() => fs.realpath(original));
        if (actual !== canonical) throw new Error("Access denied - configured root alias changed; restart with validated local configuration");
      }
    },
  };
}
