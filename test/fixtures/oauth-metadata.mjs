// Imported only by the isolated OAuth process test's module hook.
export async function fetchClientMetadataResource() {
  return Response.json(globalThis.fixtureMetadata, { headers: { "Cache-Control": "max-age=3600" } });
}
