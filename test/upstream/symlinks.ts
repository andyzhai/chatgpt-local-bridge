import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "localbridge-symlink-probe-"));
export const symlinksAvailable = await (async () => {
  try {
    await fs.writeFile(path.join(dir, "target"), "probe");
    await fs.symlink(path.join(dir, "target"), path.join(dir, "link"));
    return true;
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    return false;
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
})();
