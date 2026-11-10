import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import { call, textOf } from "./upstream/helpers.js";

/** Identical tool and confinement scenario for anonymous and OAuth clients. */
export async function exerciseAllTools(client: Client, dir: string) {
    const tools = (await client.listTools()).tools;
    const seen = new Set<string>();
    async function invoke(name: string, args: Record<string, unknown> = {}) {
      seen.add(name); const result = await call(client, name, args);
      expect(result.isError, JSON.stringify(result)).not.toBe(true); return result;
    }
    const file = path.join(dir, "hello.txt"), folder = path.join(dir, "nested"), moved = path.join(folder, "moved.txt");
    await invoke("write_file", { path: file, content: "hello 世界\nsecond line\n" });
    expect(textOf(await invoke("read_file", { path: file }))).toContain("世界");
    expect(textOf(await invoke("read_text_file", { path: file, head: 1 }))).toBe("hello 世界");
    await invoke("read_multiple_files", { paths: [file] });
    await invoke("edit_file", { path: file, edits: [{ oldText: "hello", newText: "goodbye" }] });
    expect(await fs.readFile(file, "utf8")).toContain("goodbye");
    await invoke("create_directory", { path: folder });
    await invoke("move_file", { source: file, destination: moved });
    await expect(fs.stat(file)).rejects.toThrow();
    await invoke("list_directory", { path: dir });
    await invoke("list_directory_with_sizes", { path: folder });
    await invoke("directory_tree", { path: dir });
    await invoke("search_files", { path: dir, pattern: "*.txt" });
    await invoke("get_file_info", { path: moved });
    await invoke("list_allowed_directories");
    const png = path.join(dir, "pixel.png");
    await fs.writeFile(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", "base64"));
    expect((await invoke("read_media_file", { path: png })).content[0]?.type).toBe("image");
    expect([...seen].sort()).toEqual(tools.map(t => t.name).sort());
    expect((await call(client, "read_text_file", { path: path.join(dir, "..", "outside") })).isError).toBe(true);
}

export async function prepareBoundaryFixture(root: string, outside: string) {
  await fs.mkdir(root, { recursive: true }); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "secret"), "secret");
  await fs.writeFile(path.join(root, "inside"), "original");
  await fs.symlink(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
}
export async function exerciseBoundaryTools(client: Client, root: string, outside: string, notifyRoots: () => Promise<void>) {
    const secret = path.join(outside, "secret"), inside = path.join(root, "inside");
    const badPaths = [secret, path.join(root, "..", "root-sibling", "secret"), path.join(root, "escape", "secret"), `${inside}\0suffix`,
      ...(process.platform === "win32" ? [secret.replaceAll("\\", "/"), "C:relative", "\\root-relative", "\\\\?\\C:\\device", "\\\\invalid-server\\share\\file"] : [])];
    for (const requested of badPaths) {
      expect((await call(client, "read_text_file", { path: requested })).isError).toBe(true);
      expect((await call(client, "write_file", { path: requested, content: "bad" })).isError).toBe(true);
    }
    for (const args of [{ source: inside, destination: path.join(root, "escape", "moved") }, { source: secret, destination: path.join(root, "stolen") }]) {
      expect((await call(client, "move_file", args)).isError).toBe(true);
    }
    const partial = textOf(await call(client, "read_multiple_files", { paths: [inside, secret] }));
    expect(partial).toContain("original"); expect(partial).toContain("Error"); expect(partial).not.toContain("\nsecret\n");
    const responses = await Promise.all(Array.from({ length: 3 }, () => call(client, "write_file", {
      path: inside, content: "x".repeat(129), allowedDirectories: [outside], filesystemLimits: { maxFileBytes: 999999 },
      _meta: { allowedDirectories: [outside], client_metadata: { allowedDirectories: [outside] } },
    })));
    for (const response of responses) expect(response.isError).toBe(true);
    await notifyRoots();
    expect(textOf(await call(client, "list_allowed_directories"))).toBe(`Allowed directories:\n${root}`);
    expect(await fs.readFile(inside, "utf8")).toBe("original"); expect(await fs.readFile(secret, "utf8")).toBe("secret");
    expect(await fs.readdir(outside)).toEqual(["secret"]);
}
