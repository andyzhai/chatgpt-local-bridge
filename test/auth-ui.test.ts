import vm from "node:vm";
import { expect, it, vi } from "vitest";
import { authPage } from "../src/auth/ui.js";

async function browser(consent = false, valid = true) {
  const nodes = Object.fromEntries(["status", "client", "identity", "scopes"].map(id => [id, { textContent: "" }]));
  let submit!: (event: unknown) => Promise<void>;
  const buttons = [{ disabled: false }, { disabled: false }];
  const form = { hidden: true, querySelectorAll: () => buttons, addEventListener: (_event: string, callback: typeof submit) => { submit = callback; } };
  const fetch = vi.fn().mockResolvedValueOnce(Response.json(valid ? { client_name: "<img src=x onerror=alert(1)>" } : {}, { status: valid ? 200 : 400 }))
    .mockResolvedValueOnce(Response.json({ url: "https://client.example/callback?code=provider-owned" }));
  const location = { pathname: consent ? "/consent" : "/sign-in", search: "?client_id=https%3A%2F%2Fclient.example%2Fmeta&scope=files+offline_access&sig=fixture&return_url=https%3A%2F%2Fevil.example", assign: vi.fn() };
  const script = await authPage(new Request("https://auth.example/auth-ui.js"))!.text();
  new vm.Script(script).runInNewContext({ URLSearchParams, location, fetch,
    FormData: class { get(name: string) { return name === "email" ? "owner@example.com" : "password-fixture"; } },
    document: { querySelector: () => form, getElementById: (id: string) => nodes[id] },
  });
  await vi.waitFor(() => expect(valid ? !form.hidden : nodes.status!.textContent.length > 0).toBe(true));
  return { nodes, form, fetch, location, submit, buttons };
}

it.each([false, true])("uses text-only client display and preserves signed continuation (consent=%s)", async consent => {
  const page = await browser(consent);
  expect(page.nodes.client!.textContent).toBe("<img src=x onerror=alert(1)>");
  expect(page.nodes.scopes!.textContent).toContain("read, write, edit, and move");
  expect(page.nodes.scopes!.textContent).toContain("renew access");
  await page.submit({ preventDefault() {}, submitter: { value: "accept" } });
  const [route, init] = page.fetch.mock.calls[1]!;
  expect(route).toBe(consent ? "/api/auth/oauth2/consent" : "/api/auth/sign-in/email");
  const body = JSON.parse(init.body);
  expect(body.oauth_query).toBe(new URLSearchParams(page.location.search).toString());
  expect(body.callbackURL).toBeUndefined();
  expect(page.location.assign).toHaveBeenCalledWith("https://client.example/callback?code=provider-owned");
});
it("keeps forms hidden when signed client lookup fails", async () => {
  const page = await browser(false, false); expect(page.form.hidden).toBe(true);
  expect(page.location.assign).not.toHaveBeenCalled();
});
it("sends explicit denial and follows only the provider response", async () => {
  const page = await browser(true);
  await page.submit({ preventDefault() {}, submitter: { value: "deny" } });
  expect(JSON.parse(page.fetch.mock.calls[1]![1].body).accept).toBe(false);
});
