// LocalBridge stdio entry point for MCP Inspector.
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createFilesystemServer } from './filesystem/server.js';
// Inspector passes one or more permitted directories as CLI arguments.
// Keep the allowed roots explicit; do not grant the project directory by default.
const allowedDirectories = process.argv.slice(2);

if (allowedDirectories.length === 0) {
  console.error('Usage: npx tsx src/stdio.ts <allowed-directory> [another-directory]');
  process.exit(1);
}

// Uses the filesystem tools without an HTTP listener or port.
// Never write debug output to stdout: stdout carries MCP JSON-RPC messages.
serveStdio(() => createFilesystemServer(allowedDirectories));
