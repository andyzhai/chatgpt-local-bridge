import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { parseConfig } from "../config.js";
import { validateRoots } from "../filesystem/roots.js";
import { createOwner, migrateAuth } from "./storage.js";

/** Passwords are accepted only from an interactive terminal, with no echo. */
async function passwordPrompt(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("owner:create requires an interactive terminal.");
  process.stdout.write("Password (12+ characters): ");
  process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      process.stdin.off("data", onData); process.stdin.setRawMode(false); process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\u0003" || char === "\u0004") { finish(new Error("Owner creation cancelled.")); return; }
        if (char === "\r" || char === "\n") { finish(); return; }
        if (char === "\b" || char === "\u007f") value = [...value].slice(0, -1).join("");
        else if (char >= " ") value += char;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function main() {
  const [command, file = "config.json", ...extra] = process.argv.slice(2);
  if (extra.length || !["migrate", "owner"].includes(command ?? "")) throw new Error("Usage: auth/admin.js migrate|owner [local-config.json]");
  const configFile = path.resolve(file);
  const config = parseConfig(JSON.parse(await fs.readFile(configFile, "utf8")), { ...process.env, AUTH_MODE: "oauth" });
  await validateRoots(config.allowedDirectories, { controlPaths: [configFile] });
  if (command === "migrate") {
    console.log(await migrateAuth(config));
    console.log("Auth schema and signing state ready. Keep the database directory and secret private.");
  } else {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("owner:create requires an interactive terminal.");
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    let name: string, email: string;
    try { name = await prompt.question("Owner name: "); email = await prompt.question("Owner email: "); }
    finally { prompt.close(); }
    const password = await passwordPrompt();
    await createOwner(config, { name, email, password });
    console.log("Owner created. No listener was started.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main().catch(() => {
    // Avoid echoing validation errors that might contain owner input.
    console.error("Auth administration failed. Check configuration, migration, owner existence, and the state lock.");
    process.exitCode = 1;
  });
}
