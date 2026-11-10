import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { getMigrations } from "better-auth/db/migration";
import { ConfigurationError, requireOAuthConfig, type BridgeConfig } from "../config.js";
import { validateRoots } from "../filesystem/roots.js";
import { authOptions, createAuth, type BridgeAuth } from "./options.js";

/** One bridge/admin process owns state at a time. Never guess that a lock is stale. */
export async function openAuthStorage(config: BridgeConfig, create = false): Promise<{ database: Database.Database; close(): Promise<void> }> {
  const { databasePath } = requireOAuthConfig(config);
  const directory = path.dirname(databasePath);
  await validateRoots(config.allowedDirectories, { controlPaths: [directory] });
  if (create) {
    const created = await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (created && process.platform === "win32") {
      // A newly created dedicated directory has inherited ACEs only. Remove
      // inheritance before creating any credentials; leave existing ACLs alone.
      const run = promisify(execFile);
      const { stdout } = await run("whoami.exe", [], { windowsHide: true, timeout: 5000 });
      await run("icacls.exe", [directory, "/inheritance:r", "/grant:r",
        `${stdout.trim()}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"], { windowsHide: true, timeout: 5000 });
    }
  }
  const canonicalDirectory = await fs.realpath(directory);
  const lockPath = path.join(canonicalDirectory, `${path.basename(databasePath)}.lock`);
  let lock;
  try { lock = await fs.open(lockPath, "wx", 0o600); }
  catch { throw new ConfigurationError("Auth state is locked; stop other bridge/admin processes before proceeding. Inspect stale locks manually."); }
  let database: Database.Database | undefined;
  try {
    await lock.writeFile(String(process.pid));
    // No automatic creation during serving or owner bootstrap.
    database = new Database(databasePath, { fileMustExist: !create, timeout: 5000 });
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    const opened = database;
    let closed = false;
    return { database: opened, async close() {
      if (closed) return;
      closed = true;
      try { opened.close(); } finally { await lock.close(); await fs.unlink(lockPath); }
    } };
  } catch (error) {
    database?.close(); await lock.close(); await fs.unlink(lockPath); throw error;
  }
}

export async function assertSchema(config: BridgeConfig, database: Database.Database) {
  const plan = await getMigrations(authOptions(config, database));
  if (plan.toBeCreated.length || plan.toBeAdded.length || plan.toBeAddedIndexes.length ||
      plan.unsafeChanges.length || plan.schemaProblems.length) {
    throw new ConfigurationError("Auth schema is missing or incompatible; stop the service and run auth:migrate.");
  }
}

export function ownerCount(database: Database.Database): number {
  return (database.prepare('SELECT count(*) AS count FROM "user"').get() as { count: number }).count;
}

export async function assertSigningState(auth: BridgeAuth, database: Database.Database) {
  // Plugin initialization may still be seeding persisted resource metadata.
  // Settle it before any readiness failure can close the database underneath it.
  await auth.$context;
  if (!(database.prepare('SELECT count(*) AS count FROM "jwks"').get() as { count: number }).count) {
    throw new ConfigurationError("Persisted signing keys are missing; run auth:migrate before serving.");
  }
  // Exercise the library's key decryption/signing path before opening a listener.
  await auth.api.signJWT({ body: { payload: { purpose: "startup-check", exp: Math.floor(Date.now() / 1000) } } });
}

export async function migrateAuth(config: BridgeConfig) {
  const storage = await openAuthStorage(config, true);
  try {
    const plan = await getMigrations(authOptions(config, storage.database));
    if (plan.schemaProblems.length || plan.unsafeChanges.length) throw new ConfigurationError("Unsafe or incompatible auth schema; inspect the generated migration before continuing.");
    // SQLite backup includes committed WAL contents. Keep backups with protected state.
    const tables = storage.database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    if (tables.length && (plan.toBeCreated.length || plan.toBeAdded.length || plan.toBeAddedIndexes.length)) {
      await storage.database.backup(`${requireOAuthConfig(config).databasePath}.${Date.now()}.bak`);
    }
    const sql = await plan.compileMigrations();
    await plan.runMigrations();
    const auth = createAuth(config, storage.database);
    await auth.api.getJwks();
    await assertSigningState(auth, storage.database);
    await assertSchema(config, storage.database);
    return sql;
  } finally { await storage.close(); }
}

export async function createOwner(config: BridgeConfig, owner: { name: string; email: string; password: string }) {
  const storage = await openAuthStorage(config);
  try {
    await assertSchema(config, storage.database);
    if (ownerCount(storage.database) !== 0) throw new ConfigurationError("An owner already exists; bootstrap refused.");
    const auth = createAuth(config, storage.database, true);
    await assertSigningState(auth, storage.database);
    await auth.api.signUpEmail({ body: owner });
    if (ownerCount(storage.database) !== 1) throw new ConfigurationError("Owner invariant failed.");
  } finally { await storage.close(); }
}
