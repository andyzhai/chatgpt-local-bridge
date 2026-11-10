// The browser passes the provider's signed query intact. Only provider responses
// supply navigation destinations; no user-supplied callback/return URL is used.
const script = `
const form = document.querySelector('form');
const status = document.getElementById('status');
const query = new URLSearchParams(location.search);
const oauth_query = query.toString();
const consent = location.pathname === '/consent';
async function api(path, body) {
  const response = await fetch('/api/auth/' + path, {
    method: 'POST', credentials: 'same-origin',
    headers: {'Content-Type': 'application/json', 'Accept': 'application/json'},
    body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(response.status === 429 ? 'Too many attempts. Please wait and retry.' : 'Request failed. Restart authorization or check your credentials.');
  return result;
}
async function prepare() {
  if (!query.has('sig') || !query.has('client_id')) throw new Error('Start authorization from your MCP client.');
  const client = await api('oauth2/public-client-prelogin', {client_id: query.get('client_id'), oauth_query});
  document.getElementById('client').textContent = client.client_name || query.get('client_id');
  document.getElementById('identity').textContent = query.get('client_id');
  document.getElementById('scopes').textContent = (query.get('scope') || '').split(' ').map(scope =>
    scope === 'files' ? 'files: read, write, edit, and move files in the owner-configured folders.' :
    scope === 'offline_access' ? 'offline_access: renew access later without signing in again.' : scope).join(' ');
  form.hidden = false;
  status.textContent = '';
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  const buttons = [...form.querySelectorAll('button')];
  buttons.forEach(button => button.disabled = true);
  try {
    const data = new FormData(form);
    const result = consent ? await api('oauth2/consent', {accept: event.submitter.value === 'accept', oauth_query}) :
      await api('sign-in/email', {email: data.get('email'), password: data.get('password'), oauth_query});
    const redirect = result.redirect_uri || result.url;
    if (typeof redirect !== 'string') throw new Error('Authorization did not continue. Restart from your MCP client.');
    location.assign(redirect);
  } catch (error) { status.textContent = error.message; buttons.forEach(button => button.disabled = false); }
});
prepare().catch(error => { status.textContent = error.message; });
`;

export function authPage(request: Request): Response | undefined {
  const pathname = new URL(request.url).pathname;
  if (!["/sign-in", "/consent", "/auth-ui.js"].includes(pathname)) return;
  const headers = {
    "Content-Type": pathname === "/auth-ui.js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8",
    "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  };
  if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  const consent = pathname === "/consent";
  const body = pathname === "/auth-ui.js" ? script : `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>LocalBridge ${consent ? "consent" : "sign in"}</title><script src="/auth-ui.js" defer></script></head>
<body><main><h1>${consent ? "Authorize filesystem access" : "Sign in to LocalBridge"}</h1>
<p>Client: <strong id="client"></strong></p><p id="identity"></p><p id="scopes"></p>
<form hidden>${consent ? '<button type="submit" value="accept">Allow access</button> <button type="submit" value="deny">Deny</button>' : '<p><label>Email <input name="email" type="email" autocomplete="username" required></label></p><p><label>Password <input name="password" type="password" autocomplete="current-password" required></label></p><button type="submit">Sign in</button>'}</form>
<p id="status" role="status">Validating authorization request…</p></main></body></html>`;
  return new Response(request.method === "HEAD" ? null : body, { headers });
}
