import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Syntax-check every shipped plugin file: the host half and the browser half. */
const libDir = join(dirname(fileURLToPath(import.meta.url)), "..", "lib");
const files = (await readdir(libDir)).filter((file) => file.endsWith(".js"));

let failed = false;
for (const file of files) {
	const result = spawnSync(process.execPath, ["--check", join(libDir, file)], { stdio: "inherit" });
	if (result.status !== 0) failed = true;
}

if (failed) {
	console.error("syntax check failed");
	process.exit(1);
}
console.log(`checked ${files.length} plugin file(s): OK`);
