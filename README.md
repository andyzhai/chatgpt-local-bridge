# LocalBridge

LocalBridge makes the official MCP Filesystem Server's tools available over **MCP Streamable HTTP**. You can connect an MCP client, such as MCP Inspector or ChatGPT, to read and manage files in **directories you explicitly allow**.

It preserves **14 filesystem tools**, including reading, writing, editing, searching, directory listing, media reads, and moving files. Filesystem restrictions are enforced by the server; they do not depend on client instructions.

> **Status:** The server implements 14 filesystem tools and OAuth. Authenticated Inspector and ChatGPT web listing have been exercised. Full ChatGPT tool coverage, refresh after expiry, desktop interoperability, and POSIX runtime verification remain incomplete.

## Requirements

- Node.js **24 LTS** and npm. Windows is the locally verified platform; CI is configured for Windows and Ubuntu.
- One or more local directories that you intend to expose to MCP clients.
- To connect remotely: a reachable HTTPS URL that forwards to the LocalBridge HTTP listener and, for OAuth mode, a working OAuth authorization flow.

LocalBridge binds to `127.0.0.1` (normally port `3000`). How you securely route HTTPS traffic to that port is a separate deployment decision; the application does not manage your VM, DNS, TLS proxy, or SSH tunnel.

## Install

From a clone of this repository, in PowerShell:

```powershell
node --version
npm --version
npm ci
npm run build
```

Run `npm run check` for typechecking, the production build, and automated tests. Use `npm test` for tests alone. The repository commits `package-lock.json` to make dependency installation reproducible.

## Configure

Copy the safe templates into private local files:

```powershell
Copy-Item .env.example .env
Copy-Item config.example.json config.json
```

1. In `config.json`, replace the illustrative `allowedDirectories` path with an **existing absolute path** to the folder you want to make accessible.
2. Keep the running application, `.env`, `config.json`, OAuth database, database sidecars, backups, and private keys **outside the allowed roots**. LocalBridge refuses roots overlapping application/control state.
3. In `.env`, set `PUBLIC_ORIGIN` to **your own public HTTPS origin**, for example `https://mcp.example.com` (an example, not a working server). The public MCP endpoint is `PUBLIC_ORIGIN + /mcp`.
4. Keep `AUTH_MODE=oauth` for remote usage. It is the default mode. Use a dedicated `DATABASE_PATH` outside the allowed roots.

Example `config.json`:

```json
{
  "allowedDirectories": ["D:\\shared-mcp-files"]
}
```

Create that directory yourself before startup. The provided `config.example.json` also shows optional request and filesystem resource limits.

`PUBLIC_ORIGIN` is required in both authentication modes and for auth administration. It must be an HTTPS origin without credentials, a path, a query, or a fragment. Startup fails if it is absent or invalid. Standalone filesystem factories do not require HTTP configuration.

## Run with OAuth (recommended for remote access)

Generate one persistent secret, then save it as `BETTER_AUTH_SECRET` in your **private** `.env`:

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Complete `.env` with `AUTH_MODE=oauth`, `PUBLIC_ORIGIN`, `BETTER_AUTH_SECRET`, and `DATABASE_PATH`. For a **new** auth database, run:

```powershell
npm run auth:migrate
npm run owner:create
npm start
```

`owner:create` prompts locally for the one owner account; it does **not** open an HTTP listener. The service itself disables public signup. For an **existing** database, retain its associated secret and signing state; do not recreate the owner or regenerate keys. Stop the running server before migration or other admin commands. A stale `<database>.lock` after a crash must only be removed after verifying no server/admin process is using that database; do not delete the SQLite DB/WAL/SHM files.

Successful startup reports an endpoint such as `http://127.0.0.1:3000/mcp` and `AUTH_MODE=oauth`. Public OAuth discovery endpoints (under `/.well-known/`) are intentionally accessible without a token; `/mcp` still requires a valid access token with the `files` permission.

## Optional unauthenticated mode

`AUTH_MODE=none` is supported to test functionality without OAuth. **Everyone who can reach the endpoint can use all 14 tools within the configured directories**, including write/edit/move. Neither HTTPS, a loopback listener, Caddy, nor an SSH tunnel authenticates internet callers.

Starting the normal server in this mode additionally requires the exact local acknowledgment:

```dotenv
AUTH_MODE=none
ACK_UNAUTHENTICATED_FILESYSTEM_ACCESS=I_UNDERSTAND_PUBLIC_READ_WRITE_ACCESS
```

Use disposable allowed folders and avoid exposing no-auth mode on a public URL. Filesystem path and resource-limit checks still apply in both authentication modes.

## Connect and test

- **MCP Inspector:** Start `npx -y @modelcontextprotocol/inspector@2.10.1`, select **Streamable HTTP**, and connect to your MCP URL. For OAuth + CIMD, Inspector needs its own publicly reachable HTTPS *client metadata document* whose callback matches the Inspector session.
- **ChatGPT web:** Add a custom MCP plugin using your `https://<your-domain>/mcp` URL, choose **OAuth** and **CIMD**, and use ChatGPT's own client document (for the tested setup, `https://chatgpt.com/oauth/client.json`). Log in as owner and approve the requested `files` scope; `offline_access` supports refresh when the client requests and is granted it.
- **Manual tool check:** Call `list_allowed_directories`, then `list_directory`, then `read_text_file` on a test file. Test writes and moves only on disposable data. Confirm a path outside the allowed root is rejected.

Detailed commands for the VM reverse proxy, Inspector client metadata document, ChatGPT screens, and connection troubleshooting are in the [setup and testing guide](docs/SETUP_AND_TESTING.md).

## Security and limitations

LocalBridge's root restrictions, symlink/junction checks, size and concurrency budgets reduce risk, but **are not a full OS sandbox**; hostile concurrent local processes and some filesystem aliases remain outside the protection guarantee. Use least-privilege OS permissions and keep confidential files outside allowed directories. OAuth access tokens are verified as signed JWTs with a 15-minute lifetime. Revocation may not invalidate an already-issued access token immediately; treat it as potentially usable until expiry. Refresh-token rotation allows a 30-second retry overlap.

This software gives remote clients access to real local files. Before authorizing a client, verify your allowed roots and what tools/scopes it will receive.

## Development

Run `npm run check` for strict typechecking, a production build, and the automated suite. Tests use temporary fixtures; platform- or privilege-dependent skips are reported explicitly. The vendored source is required by the tool-contract tests and is excluded from the production build.

Dependency versions are pinned. `.npmrc` disables dependency install scripts; verify native SQLite loads after a clean installation when changing Node, dependencies, or platforms. Do not suppress compatibility errors with `--legacy-peer-deps`.

See [setup and testing](docs/SETUP_AND_TESTING.md), [upstream provenance](vendor/UPSTREAM.md), and [contributor instructions](AGENTS.md).

## License

Original LocalBridge contributions are [MIT licensed](LICENSE). Adapted and vendored upstream material retains its [upstream licenses](vendor/upstream/LICENSE); see [third-party notices](THIRD_PARTY_NOTICES.md).

No OpenAI developer API key is needed to connect the MCP server through a supported ChatGPT client.
