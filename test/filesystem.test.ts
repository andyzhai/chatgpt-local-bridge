import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { stripTypeScriptTypes } from "node:module";
import { createFilesystemServer, DEFAULT_FILESYSTEM_LIMITS } from "../src/index.js";
import { APPLICATION_DIRECTORY } from "../src/filesystem/roots.js";
import { budget, fsOperation, jsonBytes, runTool, textResult } from "../src/filesystem/budget.js";
import boundedFs from "../src/filesystem/bounded-fs.js";
import { call, connect, makeTempDir, textOf, type Connected } from "./upstream/helpers.js";

let dir: string;
const connections: Connected[] = [];
beforeEach(async () => { dir = await makeTempDir("localbridge-phase2-"); });
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(connections.splice(0).map(c => c.close()));
  await fs.rm(dir, {recursive:true, force:true});
});
async function limited(limits: Parameters<typeof createFilesystemServer>[1] = {}) {
  const conn = await connect([dir], {filesystem:limits}); connections.push(conn); return conn.client;
}
const limits = (overrides = {}) => ({...DEFAULT_FILESYSTEM_LIMITS, ...overrides});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return {promise, resolve};
}

describe("owner roots and confinement", () => {
  it("rejects empty, relative, missing, and file roots at construction", async () => {
    await fs.writeFile(path.join(dir,"file"),"x");
    for (const roots of [[], ["relative"], [path.join(dir,"missing")], [path.join(dir,"file")]]) {
      await expect(createFilesystemServer(roots)).rejects.toThrow();
    }
  });
  it("rejects application roots, ancestors, descendants and case aliases", async () => {
    for (const root of [APPLICATION_DIRECTORY, path.dirname(APPLICATION_DIRECTORY), path.join(APPLICATION_DIRECTORY,"src"), ...(process.platform === "win32" ? [APPLICATION_DIRECTORY.toUpperCase()] : [])]) {
      await expect(createFilesystemServer([root])).rejects.toThrow(/control state/);
    }
  });
  it("rejects owner-specified state and future database/backup paths inside roots", async () => {
    await expect(createFilesystemServer([dir], {controlPaths:[path.join(dir,"future","auth.db")]})).rejects.toThrow(/control state/);
    await expect(createFilesystemServer([dir], {controlPaths:[path.dirname(dir)]})).rejects.toThrow(/control state/);
  });
  it("copies roots and ignores client roots, notifications, and injected tool fields", async () => {
    const outside = await fs.mkdtemp(path.join(dir,"outside-"));
    const inside = await fs.mkdtemp(path.join(dir,"inside-"));
    const roots = [inside];
    const listRoots = vi.fn(() => [{uri:pathToFileURL(outside).href}]);
    const conn = await connect(roots, {capabilities:{roots:{listChanged:true}}, listRoots}); connections.push(conn);
    roots[0] = outside;
    await conn.client.notification({method:"notifications/roots/list_changed"});
    const result = await call(conn.client,"write_file",{path:path.join(outside,"escape"),content:"bad",allowedDirectories:[outside]});
    expect(result.isError).toBe(true);
    expect(listRoots).not.toHaveBeenCalled();
    expect(textOf(await call(conn.client,"list_allowed_directories"))).toBe(`Allowed directories:\n${inside}`);
    await expect(fs.stat(path.join(outside,"escape"))).rejects.toThrow();
  });
  it("supports configured junction aliases but rejects alias retargeting", async () => {
    const target = path.join(dir,"target"), other=path.join(dir,"other"), alias=path.join(dir,"alias");
    await fs.mkdir(target); await fs.mkdir(other); await fs.writeFile(path.join(target,"file"),"ok");
    await fs.symlink(target,alias,"junction");
    const conn=await connect([alias]); connections.push(conn);
    expect(textOf(await call(conn.client,"read_text_file",{path:path.join(alias,"file")}))).toBe("ok");
    await fs.unlink(alias); await fs.symlink(other,alias,"junction");
    expect(textOf(await call(conn.client,"write_file",{path:path.join(alias,"file"),content:"bad"}))).toMatch(/root alias changed/);
    await expect(fs.stat(path.join(other,"file"))).rejects.toThrow();
  });
  it("rejects a junction alias to application control files", async () => {
    const alias=path.join(dir,"app"); await fs.symlink(APPLICATION_DIRECTORY,alias,"junction");
    await expect(createFilesystemServer([alias])).rejects.toThrow(/control state/);
  });
  it("confines both move endpoints and recursive traversal through junctions", async () => {
    const root=path.join(dir,"root"), outside=path.join(dir,"outside");
    await fs.mkdir(root); await fs.mkdir(outside); await fs.writeFile(path.join(outside,"secret"),"secret");
    await fs.symlink(outside,path.join(root,"escape"),"junction");
    const conn=await connect([root]); connections.push(conn);
    for (const args of [
      {source:path.join(outside,"secret"),destination:path.join(root,"copy")},
      {source:path.join(root,"file"),destination:path.join(root,"escape","copy")},
    ]) expect((await call(conn.client,"move_file",args)).isError).toBe(true);
    expect(textOf(await call(conn.client,"search_files",{path:root,pattern:"**/*"}))).not.toContain("secret");
    expect(textOf(await call(conn.client,"directory_tree",{path:root}))).not.toContain("secret");
    expect((await call(conn.client,"create_directory",{path:path.join(root,"escape","new","nested")})).isError).toBe(true);
    await expect(fs.stat(path.join(outside,"new"))).rejects.toThrow();
  });
  it.skipIf(process.platform !== "win32")("rejects device, drive-relative and root-relative paths; accepts case aliases", async () => {
    const client=await limited(); await fs.writeFile(path.join(dir,"file"),"ok");
    expect(textOf(await call(client,"read_text_file",{path:path.join(dir,"file").toUpperCase()}))).toBe("ok");
    for (const item of ["C:file", "\\file", "\\\\?\\C:\\file", "\\\\.\\NUL"]) {
      expect((await call(client,"read_text_file",{path:item})).isError).toBe(true);
    }
  });
  it.skipIf(process.platform === "win32")("does not trim a sibling's trailing whitespace into an allowed root", async () => {
    const root=path.join(dir,"root"), sibling=root+" "; await fs.mkdir(root); await fs.mkdir(sibling);
    await fs.writeFile(path.join(sibling,"secret"),"secret");
    const conn=await connect([root]); connections.push(conn);
    expect((await call(conn.client,"read_text_file",{path:path.join(sibling,"secret")})).isError).toBe(true);
  });
});

describe("complete upstream wire contract", () => {
  it("preserves all 14 schemas, defaults, descriptions and annotations from the pinned source", async () => {
    const upstream=await fs.readFile(new URL("../vendor/upstream/src/filesystem/server.ts",import.meta.url),"utf8");
    const schemas=upstream.slice(upstream.indexOf("const JSON_SCHEMA_DIALECT"),upstream.indexOf("// Reads a file as a stream"));
    const registrations=upstream.slice(upstream.indexOf("  // Tool registrations"),upstream.indexOf("  // Updates allowed directories"));
    const js=stripTypeScriptTypes(schemas+"\n"+registrations);
    const expected: unknown[]=[];
    // Only schema/registration code is evaluated. Tool callback bodies are never invoked.
    new Function("z","server",js)(z,{registerTool(name:string,config:{inputSchema:z.ZodType;outputSchema:z.ZodType}) {
      expected.push({name,...config,inputSchema:z.toJSONSchema(config.inputSchema,{io:"input"}),outputSchema:z.toJSONSchema(config.outputSchema)});
    }});
    const client=await limited();
    expect(JSON.parse(JSON.stringify((await client.listTools()).tools))).toEqual(expected);
  });
});

describe("bounded filesystem work", () => {
  it("checks exact single-file boundaries before write and during read", async () => {
    const client=await limited({filesystemLimits:{maxFileBytes:16,maxReadBytesPerCall:32}});
    const file=path.join(dir,"file");
    for (const count of [15,16]) {
      expect((await call(client,"write_file",{path:file,content:"x".repeat(count)})).isError).not.toBe(true);
      expect(textOf(await call(client,"read_text_file",{path:file}))).toBe("x".repeat(count));
    }
    expect(textOf(await call(client,"write_file",{path:file,content:"x".repeat(17)}))).toContain("maxFileBytes");
    expect(await fs.readFile(file,"utf8")).toBe("x".repeat(16));
    await fs.writeFile(file,"x".repeat(17));
    expect(textOf(await call(client,"read_text_file",{path:file}))).toContain("maxFileBytes");
  });
  it("counts actual aggregate bytes and rejects excess multi-file count", async () => {
    const client=await limited({filesystemLimits:{maxFileBytes:8,maxReadBytesPerCall:16,maxFilesPerCall:3}});
    const files=["a","b","c"].map(n=>path.join(dir,n)); for (const f of files) await fs.writeFile(f,"12345678");
    expect((await call(client,"read_multiple_files",{paths:files.slice(0,2)})).isError).not.toBe(true);
    expect(textOf(await call(client,"read_multiple_files",{paths:files}))).toContain("maxReadBytesPerCall");
    expect(textOf(await call(client,"read_multiple_files",{paths:[...files,files[0]]}))).toContain("maxFilesPerCall");
  });
  it("detects file growth after stat and stops with at most one probe byte", async () => {
    const file=path.join(dir,"growing"); await fs.writeFile(file,"1234");
    const open=fs.open.bind(fs); let readBytes=0;
    vi.spyOn(fs,"open").mockImplementationOnce(async (...args) => {
      const handle=await open(...args); const stat=handle.stat.bind(handle);
      vi.spyOn(handle,"stat").mockImplementationOnce(async () => { const snapshot=await stat(); await fs.appendFile(file,"x".repeat(100)); return snapshot; });
      return handle;
    });
    const result=await runTool(limits({maxFileBytes:8,maxReadBytesPerCall:8}),undefined,async()=> {
      try { return textResult(await boundedFs.readFile(file,"utf8")); }
      finally { readBytes=budget()!.readBytes; }
    });
    expect(textOf(result)).toMatch(/maxReadBytesPerCall|maxFileBytes/); expect(readBytes).toBe(9);
  });
  it("allows bounded head/tail on large sources and rejects long scanned lines", async () => {
    const client=await limited({filesystemLimits:{maxFileBytes:2048,maxReadBytesPerCall:4096}});
    const file=path.join(dir,"large"); await fs.writeFile(file,"line\n".repeat(20_000));
    expect(textOf(await call(client,"read_text_file",{path:file,head:1}))).toBe("line");
    expect(textOf(await call(client,"read_text_file",{path:file,tail:2}))).toBe("line\n");
    await fs.writeFile(file,"x".repeat(100_000));
    expect(textOf(await call(client,"read_text_file",{path:file,head:1}))).toContain("maxFileBytes");
  });
  it("bounds complete serialized responses including escaping and duplicate fields", async () => {
    const text="\"é\n😀".repeat(30), size=jsonBytes(textResult(text));
    const file=path.join(dir,"text"); await fs.writeFile(file,text);
    for (const cap of [size-1,size,size+1]) {
      const client=await limited({filesystemLimits:{maxToolResponseBytes:cap}});
      const result=await call(client,"read_text_file",{path:file});
      expect(result.isError === true).toBe(cap < size);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(cap);
    }
  });
  it("bounds media base64 expansion and mirrored structured content", async () => {
    const file=path.join(dir,"image.png"); await fs.writeFile(file,Buffer.alloc(1000));
    const client=await limited({filesystemLimits:{maxToolResponseBytes:2100}});
    const result=await call(client,"read_media_file",{path:file});
    expect(textOf(result)).toContain("maxToolResponseBytes");
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(2100);
  });
  it("counts excluded entries and enforces recursion depth without partial success", async () => {
    for (let i=0;i<6;i++) await fs.writeFile(path.join(dir,`${i}.txt`),"");
    const client=await limited({filesystemLimits:{maxEntriesVisited:5}});
    for (const tool of ["list_directory","list_directory_with_sizes","directory_tree","search_files"]) {
      expect(textOf(await call(client,tool,{path:dir,pattern:"no-match",excludePatterns:["**/*"]}))).toContain("maxEntriesVisited");
    }
    await fs.mkdir(path.join(dir,"a","b","c"),{recursive:true});
    const shallow=await limited({filesystemLimits:{maxTraversalDepth:1}});
    for (const tool of ["directory_tree","search_files"]) {
      expect(textOf(await call(shallow,tool,{path:dir,pattern:"**/*"}))).toContain("maxTraversalDepth");
    }
  });
  it("preflights edit/diff response before changing the file", async () => {
    const file=path.join(dir,"edit"); const original="old\n".repeat(200); await fs.writeFile(file,original);
    const client=await limited({filesystemLimits:{maxToolResponseBytes:512}});
    const result=await call(client,"edit_file",{path:file,edits:[{oldText:original,newText:"new\n".repeat(200)}]});
    expect(textOf(result)).toContain("maxToolResponseBytes"); expect(await fs.readFile(file,"utf8")).toBe(original);
  });
  it("allows a small edit diff for a source larger than the response limit", async () => {
    const file=path.join(dir,"small-diff"), original="unchanged\n".repeat(1000)+"old\n";
    await fs.writeFile(file,original);
    const client=await limited({filesystemLimits:{maxToolResponseBytes:1024}});
    const result=await call(client,"edit_file",{path:file,edits:[{oldText:"old",newText:"new"}]});
    expect(result.isError).not.toBe(true); expect(await fs.readFile(file,"utf8")).toBe(original.replace("old","new"));
  });
  it("preflights write success response before committing", async () => {
    const client=await limited({filesystemLimits:{maxToolResponseBytes:512}});
    const parent=path.join(dir,"a".repeat(80)); await fs.mkdir(parent);
    const file=path.join(parent,"b".repeat(100));
    const result=await call(client,"write_file",{path:file,content:"x"});
    expect(textOf(result)).toContain("maxToolResponseBytes"); await expect(fs.stat(file)).rejects.toThrow();
  });
  it("requires enough response space for an explicit error", async () => {
    await expect(createFilesystemServer([dir],{filesystemLimits:{maxToolResponseBytes:511}})).rejects.toThrow(/at least 512/);
  });
});

describe("cancellation, deadline and shared admission", () => {
  it.each(["maxConcurrentTools","maxConcurrentFsOps"] as const)("shares %s across separate server instances without queuing", async limit => {
    const client=await limited({filesystemLimits:{[limit]:1}}), second=await limited({filesystemLimits:{[limit]:1}});
    const file=path.join(dir,"file"); await fs.writeFile(file,"ok");
    const gate=deferred(), entered=deferred(), open=fs.open.bind(fs);
    vi.spyOn(fs,"open").mockImplementationOnce(async (...args)=>{entered.resolve(); await gate.promise; return open(...args);});
    const first=call(client,"read_text_file",{path:file}); await entered.promise;
    try { expect(textOf(await call(second,"read_text_file",{path:file}))).toContain(limit); }
    finally { gate.resolve(); }
    expect(textOf(await first)).toBe("ok");
    expect(textOf(await call(second,"read_text_file",{path:file}))).toBe("ok");
  });
  it("settles outstanding I/O before releasing a cancelled tool slot", async () => {
    const gate=deferred(), entered=deferred(), abort=new AbortController();
    const configured=limits({maxConcurrentTools:1});
    const pending=runTool(configured,abort.signal,async()=>{await fsOperation(async()=>{entered.resolve();await gate.promise;}); budget()!.check(); return textResult("ok");});
    await entered.promise; abort.abort();
    expect(textOf(await runTool(configured,undefined,async()=>textResult("bad")))).toContain("maxConcurrentTools");
    gate.resolve(); expect(textOf(await pending)).toContain("cancelled");
    expect(textOf(await runTool(configured,undefined,async()=>textResult("ok")))).toBe("ok");
  });
  it("checks deadlines between I/O steps and reports started mutations truthfully", async () => {
    const config=limits({maxOperationMs:10});
    const expired=await runTool(config,undefined,async()=>{await new Promise(r=>setTimeout(r,25)); await fsOperation(async()=>undefined); return textResult("bad");});
    expect(textOf(expired)).toContain("maxOperationMs");
    const committed=await runTool(config,undefined,async()=>{budget()!.commit();await new Promise(r=>setTimeout(r,25));return textResult("committed");});
    expect(textOf(committed)).toBe("committed");
  });
  it("bounds worst-case diff work by deadline before mutation", async () => {
    const file=path.join(dir,"large-diff");
    const original=Array.from({length:8000},(_,i)=>`old-${i}\n`).join("");
    const replacement=Array.from({length:8000},(_,i)=>`new-${i}\n`).join("");
    await fs.writeFile(file,original);
    const client=await limited({filesystemLimits:{maxOperationMs:40}});
    const started=performance.now();
    const result=await call(client,"edit_file",{path:file,edits:[{oldText:original,newText:replacement}]});
    expect(textOf(result)).toContain("maxOperationMs");
    expect(performance.now()-started).toBeLessThan(2000);
    expect(await fs.readFile(file,"utf8")).toBe(original);
  });
  it("counts JSON exactly without building a second full serialized string", () => {
    for (const value of [textResult("\u0000\b\t\n\r\f\"\\é😀\ud800"),{a:undefined,b:[true,false,null,12,"漢字"]}]) {
      expect(jsonBytes(value)).toBe(Buffer.byteLength(JSON.stringify(value)));
    }
  });
});
