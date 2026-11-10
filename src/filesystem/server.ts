// Adapted from the pinned official filesystem server; see vendor/UPSTREAM.md.
import { McpServer, type CallToolResult, type ToolAnnotations } from "@modelcontextprotocol/server";
import fs from "./bounded-fs.js";
import { validateRoots, type FilesystemServerOptions } from "./roots.js";
import { runTool, budget, checkTextResult, sequentialMap, BudgetError, jsonBytes } from "./budget.js";
import path from "path";
import { pathToFileURL } from "url";
import { z } from "zod";
import { minimatch } from "minimatch";
import {
  formatSize,
  validatePath,
  getFileStats,
  readFileContent,
  writeFileContent,
  moveFile,
  searchFilesWithValidation,
  applyFileEdits,
  tailFile,
  headFile,
} from "./lib.js";


// The JSON Schema dialect every advertised tool schema declares (#4841). The
// SDK 1.x tools/list handler renders zod schemas with zod's draft-07 target and
// stamps "$schema": draft-07 on each one, which validators that accept only
// 2020-12 (the dialect MCP assumes for tool schemas) reject outright. Setting
// $schema in the root object's zod metadata overrides that stamp. The schemas
// below use nothing whose draft-07 and 2020-12 renderings differ (no tuples),
// so the label is the only change; server-tools.test.ts fails if a draft-07-only
// keyword ever appears under it.
const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/** A tool's input or output shape as an object schema declaring 2020-12. */
function jsonSchema2020<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.object(shape).meta({ $schema: JSON_SCHEMA_DIALECT });
}

// Schema definitions
const ReadTextFileArgsSchema = z.object({
  path: z.string(),
  tail: z
    .number()
    .optional()
    .describe("If provided, returns only the last N lines of the file"),
  head: z
    .number()
    .optional()
    .describe("If provided, returns only the first N lines of the file"),
});

const ReadMediaFileArgsSchema = z.object({
  path: z.string(),
});

const ReadMultipleFilesArgsSchema = z.object({
  paths: z
    .array(z.string())
    .min(1)
    .describe(
      "Array of file paths to read. Each path must be a string pointing to a valid file within allowed directories.",
    ),
});

const WriteFileArgsSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const EditOperation = z.object({
  oldText: z.string().describe("Text to search for - must match exactly"),
  newText: z.string().describe("Text to replace with"),
});

const EditFileArgsSchema = z.object({
  path: z.string(),
  edits: z.array(EditOperation),
  dryRun: z
    .boolean()
    .default(false)
    .describe("Preview changes using git-style diff format"),
});

const CreateDirectoryArgsSchema = z.object({
  path: z.string(),
});

const ListDirectoryArgsSchema = z.object({
  path: z.string(),
});

const ListDirectoryWithSizesArgsSchema = z.object({
  path: z.string(),
  sortBy: z
    .enum(["name", "size"])
    .optional()
    .default("name")
    .describe("Sort entries by name or size"),
});

const DirectoryTreeArgsSchema = z.object({
  path: z.string(),
  excludePatterns: z.array(z.string()).optional().default([]),
});

const MoveFileArgsSchema = z.object({
  source: z.string(),
  destination: z.string(),
});

const SearchFilesArgsSchema = z.object({
  path: z.string(),
  pattern: z.string(),
  excludePatterns: z.array(z.string()).optional().default([]),
});

const GetFileInfoArgsSchema = z.object({
  path: z.string(),
});

async function readFileAsBase64Stream(filePath: string, overhead: number): Promise<string> {
  const data = await fs.readFile(filePath);
  budget()?.responseEstimate(2 * 4 * Math.ceil(data.length / 3) + overhead);
  return data.toString("base64");
}

/** Owner-only construction. No client roots or authentication state is consulted. */
export async function createFilesystemServer(
  initialAllowedDirectories: readonly string[],
  options: FilesystemServerOptions = {},
): Promise<McpServer> {
  return (await createFilesystemServerFactory(initialAllowedDirectories, options))();
}

/** Validate owner roots once, then reuse the same immutable authorization for
 * every HTTP request. Revalidating from scratch would trust retargeted aliases. */
export async function createFilesystemServerFactory(
  initialAllowedDirectories: readonly string[],
  options: FilesystemServerOptions = {},
): Promise<() => McpServer> {
  const roots = await validateRoots(initialAllowedDirectories, options);
  const toolMetadata = options.toolMetadata ? structuredClone(options.toolMetadata) : undefined;
  return () => createServerFromValidatedRoots(roots, toolMetadata);
}

function createServerFromValidatedRoots({ allowedDirectories, limits, verifyRoots }:
  Awaited<ReturnType<typeof validateRoots>>, toolMetadata?: Readonly<Record<string, unknown>>): McpServer {
  const server = new McpServer({ name: "secure-filesystem-server", version: "0.1.0" });
  function registerTool<S extends z.ZodRawShape, O extends z.ZodRawShape>(name: string, config: {
    title: string; description: string; inputSchema: z.ZodObject<S>;
    outputSchema: z.ZodObject<O>; annotations: ToolAnnotations;
  }, handler: (args: z.infer<z.ZodObject<S>>) => Promise<CallToolResult>) {
    server.registerTool(name, { ...config, ...(toolMetadata ? { _meta: toolMetadata } : {}) }, async (args, ctx) =>
      runTool(limits, ctx.mcpReq.signal, async () => {
        await verifyRoots();
        return handler(args);
      }));
  }

  // Tool registrations

  // read_file (deprecated) and read_text_file
  const readTextFileHandler = async (
    args: z.infer<typeof ReadTextFileArgsSchema>,
  ) => {
    const validPath = await validatePath(args.path, allowedDirectories);

    if (args.head && args.tail) {
      throw new Error(
        "Cannot specify both head and tail parameters simultaneously",
      );
    }

    let content: string;
    if (args.tail) {
      content = await tailFile(validPath, args.tail);
    } else if (args.head) {
      content = await headFile(validPath, args.head);
    } else {
      content = await readFileContent(validPath);
    }

    return {
      content: [{ type: "text" as const, text: content }],
      structuredContent: { content },
    };
  };

  registerTool(
    "read_file",
    {
      title: "Read File (Deprecated)",
      description:
        "Read the complete contents of a file as text. DEPRECATED: Use read_text_file instead.",
      inputSchema: jsonSchema2020(ReadTextFileArgsSchema.shape),
      outputSchema: jsonSchema2020({ content: z.string() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    readTextFileHandler,
  );

  registerTool(
    "read_text_file",
    {
      title: "Read Text File",
      description:
        "Read the complete contents of a file from the file system as text. " +
        "Handles various text encodings and provides detailed error messages " +
        "if the file cannot be read. Use this tool when you need to examine " +
        "the contents of a single file. Use the 'head' parameter to read only " +
        "the first N lines of a file, or the 'tail' parameter to read only " +
        "the last N lines of a file. Operates on the file as text regardless of extension. " +
        "Only works within allowed directories.",
      inputSchema: jsonSchema2020({
        path: z.string(),
        tail: z
          .number()
          .optional()
          .describe("If provided, returns only the last N lines of the file"),
        head: z
          .number()
          .optional()
          .describe("If provided, returns only the first N lines of the file"),
      }),
      outputSchema: jsonSchema2020({ content: z.string() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    readTextFileHandler,
  );

  registerTool(
    "read_media_file",
    {
      title: "Read Media File",
      description:
        "Read a file and return it as a base64-encoded content block with its MIME type. " +
        "Image and audio files are returned as image/audio content; any other file type is " +
        "returned as an embedded resource. Only works within allowed directories.",
      inputSchema: jsonSchema2020(ReadMediaFileArgsSchema.shape),
      outputSchema: jsonSchema2020({
        content: z.array(
          z.union([
            z.object({
              type: z.enum(["image", "audio"]),
              data: z.string(),
              mimeType: z.string(),
            }),
            z.object({
              type: z.literal("resource"),
              resource: z.object({
                uri: z.string(),
                // Optional, matching the SDK's BlobResourceContents shape (the handler always sets it).
                mimeType: z.string().optional(),
                blob: z.string(),
              }),
            }),
          ]),
        ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args: z.infer<typeof ReadMediaFileArgsSchema>) => {
      const validPath = await validatePath(args.path, allowedDirectories);
      const extension = path.extname(validPath).toLowerCase();
      const mimeTypes: Record<string, string> = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".bmp": "image/bmp",
        ".svg": "image/svg+xml",
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".ogg": "audio/ogg",
        ".flac": "audio/flac",
      };
      const mimeType = mimeTypes[extension] || "application/octet-stream";
      const emptyItem = mimeType.startsWith("image/")
        ? { type: "image", data: "", mimeType }
        : mimeType.startsWith("audio/")
          ? { type: "audio", data: "", mimeType }
          : { type: "resource", resource: { uri: pathToFileURL(validPath).href, mimeType, blob: "" } };
      const overhead = jsonBytes({content: [emptyItem], structuredContent: {content: [emptyItem]}});
      const data = await readFileAsBase64Stream(validPath, overhead);

      // Map the MIME type to a valid MCP content block. The spec only allows
      // text, image, audio, resource_link, and resource — so non-image/audio
      // binaries are returned as an embedded resource (NOT type:"blob", which the
      // SDK content-block union rejects on schema validation).
      const contentItem = mimeType.startsWith("image/")
        ? { type: "image" as const, data, mimeType }
        : mimeType.startsWith("audio/")
          ? { type: "audio" as const, data, mimeType }
          : {
              type: "resource" as const,
              resource: {
                uri: pathToFileURL(validPath).href,
                mimeType,
                blob: data,
              },
            };
      return {
        content: [contentItem],
        structuredContent: { content: [contentItem] },
      };
    },
  );

  registerTool(
    "read_multiple_files",
    {
      title: "Read Multiple Files",
      description:
        "Read the contents of multiple files simultaneously. This is more " +
        "efficient than reading files one by one when you need to analyze " +
        "or compare multiple files. Each file's content is returned with its " +
        "path as a reference. Failed reads for individual files won't stop " +
        "the entire operation. Only works within allowed directories.",
      inputSchema: jsonSchema2020(ReadMultipleFilesArgsSchema.shape),
      outputSchema: jsonSchema2020({ content: z.string() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args: z.infer<typeof ReadMultipleFilesArgsSchema>) => {
      budget()?.files(args.paths.length);
      const results = await sequentialMap(args.paths, async (filePath: string) => {
          try {
            const validPath = await validatePath(filePath, allowedDirectories);
            const content = await readFileContent(validPath);
            const result = `${filePath}:\n${content}\n`;
            budget()?.reserveText(result);
            return result;
          } catch (error) {
            if (error instanceof BudgetError) throw error;
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            const result = `${filePath}: Error - ${errorMessage}`;
            budget()?.reserveText(result);
            return result;
          }
        });
      const text = results.join("\n---\n");
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: { content: text },
      };
    },
  );

  registerTool(
    "write_file",
    {
      title: "Write File",
      description:
        "Create a new file or completely overwrite an existing file with new content. " +
        "Use with caution as it will overwrite existing files without warning. " +
        "Handles text content with proper encoding. Only works within allowed directories.",
      inputSchema: jsonSchema2020(WriteFileArgsSchema.shape),
      outputSchema: jsonSchema2020({ content: z.string() }),
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (args: z.infer<typeof WriteFileArgsSchema>) => {
      const validPath = await validatePath(args.path, allowedDirectories);
      checkTextResult(`Successfully wrote to ${args.path}`);
      await writeFileContent(validPath, args.content);
      const text = `Successfully wrote to ${args.path}`;
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: { content: text },
      };
    },
  );

  registerTool(
    "edit_file",
    {
      title: "Edit File",
      description:
        "Make line-based edits to a text file. Each edit replaces exact line sequences " +
        "with new content. Returns a git-style diff showing the changes made. " +
        "Only works within allowed directories.",
      inputSchema: jsonSchema2020(EditFileArgsSchema.shape),
      outputSchema: jsonSchema2020({ content: z.string() }),
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (args: z.infer<typeof EditFileArgsSchema>) => {
      let editBytes = 0;
      for (const edit of args.edits) {
        editBytes += Buffer.byteLength(edit.oldText) + Buffer.byteLength(edit.newText) + 16;
        budget()?.fileBytes(editBytes);
      }
      const validPath = await validatePath(args.path, allowedDirectories);
      const result = await applyFileEdits(validPath, args.edits, args.dryRun);
      return {
        content: [{ type: "text" as const, text: result }],
        structuredContent: { content: result },
      };
    },
  );

  registerTool(
    "create_directory",
    {
      title: "Create Directory",
      description:
        "Create a new directory or ensure a directory exists. Can create multiple " +
        "nested directories in one operation. If the directory already exists, " +
        "this operation will succeed silently. Perfect for setting up directory " +
        "structures for projects or ensuring required paths exist. Only works within allowed directories.",
      inputSchema: jsonSchema2020(CreateDirectoryArgsSchema.shape),
      outputSchema: jsonSchema2020({ content: z.string() }),
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args: z.infer<typeof CreateDirectoryArgsSchema>) => {
      const validPath = await validatePath(args.path, allowedDirectories);
      checkTextResult(`Successfully created directory ${args.path}`);
      await fs.mkdir(validPath, { recursive: true });
      const text = `Successfully created directory ${args.path}`;
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: { content: text },
      };
    },
  );

  registerTool(
    "list_directory",
    {
      title: "List Directory",
      description:
        "Get a detailed listing of all files and directories in a specified path. " +
        "Results clearly distinguish between files and directories with [FILE] and [DIR] " +
        "prefixes. This tool is essential for understanding directory structure and " +
        "finding specific files within a directory. Only works within allowed directories.",
      inputSchema: jsonSchema2020(ListDirectoryArgsSchema.shape),
      outputSchema: jsonSchema2020({ content: z.string() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args: z.infer<typeof ListDirectoryArgsSchema>) => {
      const validPath = await validatePath(args.path, allowedDirectories);
      const entries = await fs.readdir(validPath, { withFileTypes: true });
      const formatted = entries
        .map(
          (entry) =>
            `${entry.isDirectory() ? "[DIR]" : "[FILE]"} ${entry.name}`,
        )
        .join("\n");
      return {
        content: [{ type: "text" as const, text: formatted }],
        structuredContent: { content: formatted },
      };
    },
  );

  registerTool(
    "list_directory_with_sizes",
    {
      title: "List Directory with Sizes",
      description:
        "Get a detailed listing of all files and directories in a specified path, including sizes. " +
        "Results clearly distinguish between files and directories with [FILE] and [DIR] " +
        "prefixes. This tool is useful for understanding directory structure and " +
        "finding specific files within a directory. Only works within allowed directories.",
      inputSchema: jsonSchema2020(ListDirectoryWithSizesArgsSchema.shape),
      outputSchema: jsonSchema2020({ content: z.string() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args: z.infer<typeof ListDirectoryWithSizesArgsSchema>) => {
      const validPath = await validatePath(args.path, allowedDirectories);
      const entries = await fs.readdir(validPath, { withFileTypes: true });

      // Get detailed information for each entry
      const detailedEntries = await sequentialMap(entries, async (entry) => {
          const entryPath = path.join(validPath, entry.name);
          try {
            const stats = await fs.stat(await validatePath(entryPath, allowedDirectories));
            return {
              name: entry.name,
              isDirectory: entry.isDirectory(),
              size: stats.size,
              mtime: stats.mtime,
            };
          } catch (error) {
            if (error instanceof BudgetError) throw error;
            return {
              name: entry.name,
              isDirectory: entry.isDirectory(),
              size: 0,
              mtime: new Date(0),
            };
          }
        });

      // Sort entries based on sortBy parameter
      const sortedEntries = [...detailedEntries].sort((a, b) => {
        if (args.sortBy === "size") {
          return b.size - a.size; // Descending by size
        }
        // Default sort by name
        return a.name.localeCompare(b.name);
      });

      // Format the output
      const formattedEntries = sortedEntries.map(
        (entry) =>
          `${entry.isDirectory ? "[DIR]" : "[FILE]"} ${entry.name.padEnd(30)} ${
            entry.isDirectory ? "" : formatSize(entry.size).padStart(10)
          }`,
      );

      // Add summary
      const totalFiles = detailedEntries.filter((e) => !e.isDirectory).length;
      const totalDirs = detailedEntries.filter((e) => e.isDirectory).length;
      const totalSize = detailedEntries.reduce(
        (sum, entry) => sum + (entry.isDirectory ? 0 : entry.size),
        0,
      );

      const summary = [
        "",
        `Total: ${totalFiles} files, ${totalDirs} directories`,
        `Combined size: ${formatSize(totalSize)}`,
      ];

      const text = [...formattedEntries, ...summary].join("\n");
      const contentBlock = { type: "text" as const, text };
      return {
        content: [contentBlock],
        structuredContent: { content: text },
      };
    },
  );

  registerTool(
    "directory_tree",
    {
      title: "Directory Tree",
      description:
        "Get a recursive tree view of files and directories as a JSON structure. " +
        "Each entry includes 'name', 'type' (file/directory), and 'children' for directories. " +
        "Files have no children array, while directories always have a children array (which may be empty). " +
        "The output is formatted with 2-space indentation for readability. Only works within allowed directories.",
      inputSchema: jsonSchema2020(DirectoryTreeArgsSchema.shape),
      outputSchema: jsonSchema2020({ content: z.string() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args: z.infer<typeof DirectoryTreeArgsSchema>) => {
      interface TreeEntry {
        name: string;
        type: "file" | "directory";
        children?: TreeEntry[];
      }
      const rootPath = args.path;

      async function buildTree(
        currentPath: string,
        excludePatterns: string[] = [],
        depth = 0,
      ): Promise<TreeEntry[]> {
        budget()?.depth(depth);
        const validPath = await validatePath(currentPath, allowedDirectories);
        const entries = await fs.readdir(validPath, { withFileTypes: true });
        const result: TreeEntry[] = [];

        for (const entry of entries) {
          const relativePath = path.relative(
            rootPath,
            path.join(currentPath, entry.name),
          );
          const shouldExclude = excludePatterns.some((pattern) => {
            if (pattern.includes("*")) {
              return minimatch(relativePath, pattern, { dot: true });
            }
            // For files: match exact name or as part of path
            // For directories: match as directory path
            return (
              minimatch(relativePath, pattern, { dot: true }) ||
              minimatch(relativePath, `**/${pattern}`, { dot: true }) ||
              minimatch(relativePath, `**/${pattern}/**`, { dot: true })
            );
          });
          if (shouldExclude) continue;

          const entryData: TreeEntry = {
            name: entry.name,
            type: entry.isDirectory() ? "directory" : "file",
          };

          if (entry.isDirectory()) {
            const subPath = path.join(currentPath, entry.name);
            entryData.children = await buildTree(subPath, excludePatterns, depth + 1);
          }

          budget()?.reserveText(entry.name + " ".repeat(depth * 2) + "x".repeat(64));
          result.push(entryData);
        }

        return result;
      }

      const treeData = await buildTree(rootPath, args.excludePatterns);
      const text = JSON.stringify(treeData, null, 2);
      const contentBlock = { type: "text" as const, text };
      return {
        content: [contentBlock],
        structuredContent: { content: text },
      };
    },
  );

  registerTool(
    "move_file",
    {
      title: "Move File",
      description:
        "Move or rename files and directories. Can move files between directories " +
        "and rename them in a single operation. If the destination exists, the " +
        "operation will fail. Works across different directories and can be used " +
        "for simple renaming within the same directory. Both source and destination must be within allowed directories.",
      inputSchema: jsonSchema2020(MoveFileArgsSchema.shape),
      outputSchema: jsonSchema2020({ content: z.string() }),
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (args: z.infer<typeof MoveFileArgsSchema>) => {
      const validSourcePath = await validatePath(
        args.source,
        allowedDirectories,
      );
      const validDestPath = await validatePath(
        args.destination,
        allowedDirectories,
      );
      checkTextResult(`Successfully moved ${args.source} to ${args.destination}`);
      await moveFile(validSourcePath, validDestPath);
      const text = `Successfully moved ${args.source} to ${args.destination}`;
      const contentBlock = { type: "text" as const, text };
      return {
        content: [contentBlock],
        structuredContent: { content: text },
      };
    },
  );

  registerTool(
    "search_files",
    {
      title: "Search Files",
      description:
        "Recursively search for files and directories matching a pattern. " +
        "The patterns should be glob-style patterns that match paths relative to the working directory. " +
        "Use pattern like '*.ext' to match files in current directory, and '**/*.ext' to match files in all subdirectories. " +
        "Returns full paths to all matching items. Great for finding files when you don't know their exact location. " +
        "Only searches within allowed directories.",
      inputSchema: jsonSchema2020(SearchFilesArgsSchema.shape),
      outputSchema: jsonSchema2020({ content: z.string() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args: z.infer<typeof SearchFilesArgsSchema>) => {
      const validPath = await validatePath(args.path, allowedDirectories);
      const results = await searchFilesWithValidation(
        validPath,
        args.pattern,
        allowedDirectories,
        { excludePatterns: args.excludePatterns },
      );
      const text = results.length > 0 ? results.join("\n") : "No matches found";
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: { content: text },
      };
    },
  );

  registerTool(
    "get_file_info",
    {
      title: "Get File Info",
      description:
        "Retrieve detailed metadata about a file or directory. Returns comprehensive " +
        "information including size, creation time, last modified time, permissions, " +
        "and type. This tool is perfect for understanding file characteristics " +
        "without reading the actual content. Only works within allowed directories.",
      inputSchema: jsonSchema2020(GetFileInfoArgsSchema.shape),
      outputSchema: jsonSchema2020({ content: z.string() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args: z.infer<typeof GetFileInfoArgsSchema>) => {
      const validPath = await validatePath(args.path, allowedDirectories);
      const info = await getFileStats(validPath);
      const text = Object.entries(info)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n");
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: { content: text },
      };
    },
  );

  registerTool(
    "list_allowed_directories",
    {
      title: "List Allowed Directories",
      description:
        "Returns the list of directories that this server is allowed to access. " +
        "Subdirectories within these allowed directories are also accessible. " +
        "Use this to understand which directories and their nested paths are available " +
        "before trying to access files.",
      inputSchema: jsonSchema2020({}),
      outputSchema: jsonSchema2020({ content: z.string() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const text = `Allowed directories:\n${allowedDirectories.join("\n")}`;
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: { content: text },
      };
    },
  );

  return server;
}
