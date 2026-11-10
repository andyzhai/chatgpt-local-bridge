# Set up and test LocalBridge with MCP Inspector and ChatGPT

This guide describes an example HTTPS deployment and repeatable connection checks. Replace example values with your own configuration.

## Example network

```text
ChatGPT web or MCP Inspector
  -> https://mcp.example.com/mcp
  -> Caddy (public VM, TLS termination)
  -> VM 127.0.0.1:9000
  -> reverse SSH tunnel
  -> Windows 127.0.0.1:3000
  -> LocalBridge (AUTH_MODE=oauth)
  -> your configured allowed directories
```

`mcp.example.com` is illustrative. Replace it with a DNS name and HTTPS endpoint **you control**. Other reverse-proxy/tunnel arrangements can work if the URL and OAuth resource/issuer are consistent.

## 1. Start the local server

In PowerShell at your installed LocalBridge project:

```powershell
npm ci
npm run build
```

For initial configuration, copy `.env.example` to `.env` and `config.example.json` to `config.json`. In `.env`, explicitly set:

```dotenv
AUTH_MODE=oauth
PUBLIC_ORIGIN=https://mcp.example.com
PORT=3000
DATABASE_PATH=D:/localbridge-private-data/auth.sqlite
BETTER_AUTH_SECRET=<long-random-secret-kept-private>
```

Use an existing directory in `config.json` and **do not expose** the application, `.env`, config file, private keys, SQLite database, WAL/SHM, backups or other control state in `allowedDirectories`.

Generate a secret once with `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"`, then store it only in private configuration. For a **new** database, initialize the owner before serving:

```powershell
npm run auth:migrate
npm run owner:create
npm start
```

For an **existing** database, preserve its original secret and signing keys; do **not** rerun owner creation. Stop other running LocalBridge/admin processes before database administration.

Expected startup includes `AUTH_MODE=oauth listening at http://127.0.0.1:3000/mcp`. The `files` scope means permission to use filesystem tools; the allowed directory list still controls which paths they can reach.

## 2. Verify the HTTPS, Caddy and SSH path

Example Caddyfile on the public VM (`/etc/caddy/Caddyfile`):

```caddyfile
mcp.example.com {
    handle /inspector-client.json {
        root * /var/www/localbridge
        file_server
    }
    handle {
        reverse_proxy 127.0.0.1:9000
    }
}
```

Caddy is a separate process: this application does not start or manage it. To inspect/reload a manually started Caddy:

```bash
ps aux | grep '[c]addy'
sudo caddy validate --config /etc/caddy/Caddyfile
sudo caddy reload --config /etc/caddy/Caddyfile
```

With a PuTTY Plink reverse tunnel running on Windows, a *sample* command is:

```powershell
& "C:\Program Files\PuTTY\plink.exe" `
  -i "C:\path\to\your-key.ppk" `
  -N -R 9000:127.0.0.1:3000 `
  ubuntu@your-vm-host.example
```

Substitute your key location, SSH account and actual VM hostname. Keep that tunnel process running while testing. Use its normal host-key verification; don't disable host-key checks to make the command succeed.

Verify discovery through the **public** URL:

```powershell
Invoke-RestMethod https://mcp.example.com/.well-known/oauth-protected-resource
Invoke-RestMethod https://mcp.example.com/.well-known/oauth-authorization-server
```

The protected resource should be exactly `https://mcp.example.com/mcp`; the authorization server issuer should be `https://mcp.example.com`. Confirm S256, CIMD and `authorization_code` / `refresh_token`. Public discovery metadata **should not require an access token**, whereas an unauthenticated MCP POST should return `401`.

## 3. Publish the MCP Inspector client metadata document (CIMD)

Inspector's client document is **different from ChatGPT's**. If the OAuth server has disabled Dynamic Client Registration (DCR), Inspector needs a publicly reachable HTTPS client metadata URL.

On the VM, create the directory and JSON file:

```bash
sudo mkdir -p /var/www/localbridge
sudo tee /var/www/localbridge/inspector-client.json > /dev/null <<'EOF'
{
  "client_id": "https://mcp.example.com/inspector-client.json",
  "client_name": "LocalBridge MCP Inspector",
  "application_type": "native",
  "redirect_uris": [
    "http://localhost:6274/oauth/callback",
    "http://127.0.0.1:6274/oauth/callback"
  ],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none"
}
EOF
```

The `client_id` must equal the **actual public document URL** and the configured callback must exactly match the Inspector instance's displayed callback. Adjust both if your hostname/Inspector port differs. Edit/validate/reload Caddy as shown above, then check:

```bash
curl -i https://mcp.example.com/inspector-client.json
```

Expected: HTTP `200` and the correct JSON. That alone **does not** prove the SSH tunnel or local Node server is responding: Caddy serves this file directly.

## 4. Test with MCP Inspector

Start Inspector on Windows:

```powershell
npx -y @modelcontextprotocol/inspector@2.10.1
```

Open the browser UI printed by the command. In the Inspector connection settings:

- **Transport:** Streamable HTTP
- **Server URL:** `https://mcp.example.com/mcp`
- **Authentication:** OAuth
- **Client registration:** CIMD (not DCR)
- **Client ID metadata URL:** `https://mcp.example.com/inspector-client.json`
- **Scopes:** `files offline_access`, if the field is available
- **Callback URL:** confirm it exactly matches a `redirect_uris` entry

Connect, sign into LocalBridge as the owner, approve consent, then list tools. There should be **14** filesystem tools. Start with `list_allowed_directories`, `list_directory`, and `read_text_file`; use disposable files for `write_file`, `edit_file`, and `move_file`.

If you have an old failed OAuth attempt, clear Inspector's saved OAuth state before retrying.

## 5. Install in ChatGPT web

In ChatGPT web, open the Plugins interface and add a **custom MCP server/plugin**. The UI can change; use the fields displayed by your current product.

- **Name:** LocalBridge
- **Server URL:** `https://mcp.example.com/mcp`
- **Authentication:** OAuth
- **Client registration:** CIMD
- **CIMD URL:** ChatGPT's own, e.g. `https://chatgpt.com/oauth/client.json` in the tested connection (not `inspector-client.json`)
- **OIDC:** not needed for this OAuth-only server; leave OIDC-specific fields unset unless your server is deliberately extended

If requested, use `files offline_access` as scopes. Complete owner sign-in and consent. In a new conversation, select `@LocalBridge` and ask it to list allowed directories.

ChatGPT's successful connection proves the tool path it exercised, **not** every tool or token-refresh case.

## 6. Troubleshooting

### Public client document works, but OAuth discovery times out

These tests identify the failing hop:

```powershell
# Caddy only: may work even with a broken SSH tunnel
curl.exe --max-time 8 -I https://mcp.example.com/inspector-client.json

# Caddy + SSH tunnel + Windows LocalBridge
curl.exe --max-time 8 -i https://mcp.example.com/.well-known/oauth-authorization-server

# Windows LocalBridge, bypassing VM/tunnel
curl.exe --max-time 5 -i http://127.0.0.1:3000/.well-known/oauth-authorization-server
```

On the VM:

```bash
curl --max-time 5 -i http://127.0.0.1:9000/.well-known/oauth-authorization-server
sudo ss -ltnp | grep ':9000'
```

If local Windows responds but VM port 9000 hangs, inspect/restart the **reverse SSH tunnel**, not Caddy/Node unnecessarily.

### Authentication errors

- `401` at `/mcp` without a token is expected in OAuth mode.
- Check `PUBLIC_ORIGIN`, issuer and `/mcp` resource, OAuth scope (`files`), callback URL and client document.
- If Inspector succeeds but ChatGPT does not, check the **ChatGPT CIMD flow** separately; they identify as different OAuth clients.
- The `offline_access` scope must actually be requested and granted to establish refresh behavior. Successful first sign-in alone does not prove refresh.

### Database lock after moving/installing the server

Stop the previous server and admin processes before starting the relocated installation. Confirm that `DATABASE_PATH` points to the **SQLite file**, not just a directory. If a crash leaves `<database>.lock`, inspect for live processes and remove **only** a stale lock after proving the DB is not in use. Never delete the database, WAL or SHM to clear a lock.

### Root overlaps application/control state

Move the **running application** outside the allowed root, or narrow the allowed root to a separate test-data folder. Do not disable the overlap protection to make startup succeed.

## 7. Acceptance checks

On disposable data, verify listing, reading, writing, editing and moving files; confirm requests outside the allowed roots are rejected. Test reconnect after restart and refresh after access-token expiry separately from first sign-in. Keep the same database, secret and signing state across restarts.

The [README](../README.md) describes known interoperability and security limitations. Automated tests run with `npm run check`; successful local tests alone do not establish acceptance through a particular remote client or proxy.
