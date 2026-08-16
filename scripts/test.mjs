import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore, extractTitle } from "../lib/store.js";

/**
 * Exercise the store against a REAL temporary directory.
 *
 * Nothing is stubbed. An earlier version of this suite faked the filesystem and
 * so validated the code against its author's assumptions rather than the
 * platform: it invented a `remove` method the harness filesystem service does
 * not have, and passed while delete was broken in every real run.
 */

let failures = 0;
const check = (label, condition, detail) => {
	if (condition) {
		console.log("  ok   " + label);
		return;
	}
	failures += 1;
	console.log("  FAIL " + label + " -> " + JSON.stringify(detail));
};

const base = await mkdtemp(join(tmpdir(), "dsh-artifact-test-"));
const root = join(base, "artifacts");
const store = new ArtifactStore(root);
const doc = "<!doctype html><html><head><title>Q3 Report</title></head><body>hi</body></html>";

console.log("titles");
check("reads <title>", extractTitle(doc) === "Q3 Report", extractTitle(doc));
check("falls back to <h1>", extractTitle("<h1>Fallback</h1>") === "Fallback", extractTitle("<h1>Fallback</h1>"));
check("strips inline markup", extractTitle("<title>A <b>B</b></title>") === "A B", extractTitle("<title>A <b>B</b></title>"));
check("undefined without either", extractTitle("<p>none</p>") === undefined, extractTitle("<p>none</p>"));
check("undefined for non-strings", extractTitle(null) === undefined, extractTitle(null));

console.log("empty store");
let r = await store.list();
check("missing store lists empty", r.ok && r.value.artifacts.length === 0, r);
check("missing store reports root", r.ok && r.value.root === root, r.value?.root);

console.log("write");
r = await store.write("q3", doc);
check("write succeeds", r.ok, r);
check("extracts the title", r.ok && r.value.title === "Q3 Report", r.value?.title);
check("appends .html", r.ok && r.value.path === join(root, "q3.html"), r.value?.path);
check("creates the store directory", (await readdir(root)).includes("q3.html"), await readdir(root));
check("keeps an explicit .html suffix", (await store.write("q4.html", doc)).value?.path === join(root, "q4.html"));

console.log("read");
r = await store.read("q3");
check("round-trips the content", r.ok && r.value.content === doc, r.ok && r.value.content);
check("absolute path inside the store is fine", (await store.read(join(root, "q3.html"))).ok);
check("missing artifact rejected", (await store.read("nope")).error?.code === "not-found");
check("empty path rejected", (await store.read("")).error?.code === "invalid-path");
check("non-string path rejected", (await store.read(undefined)).error?.code === "invalid-path");

console.log("list");
await new Promise((done) => setTimeout(done, 12));
await store.write("later", "<title>Later</title>");
r = await store.list();
check(
	"newest first",
	r.ok && r.value.artifacts[0].name === "later.html",
	r.value?.artifacts?.map((a) => a.name),
);
await writeFile(join(root, "untitled.html"), "<p>no title here</p>", "utf8");
r = await store.list();
check("untitled falls back to the filename", r.value.artifacts.some((a) => a.title === "untitled"));
check("ignores non-html files", !(await store.list()).value.artifacts.some((a) => a.name.endsWith(".txt")));

console.log("confinement");
for (const escape of ["../outside", "../../outside", "sub/../../outside", join(base, "outside")]) {
	check(
		"write rejects " + JSON.stringify(escape),
		(await store.write(escape, doc)).error?.code === "outside-store",
	);
	check(
		"read rejects " + JSON.stringify(escape),
		(await store.read(escape)).error?.code === "outside-store",
	);
	check(
		"delete rejects " + JSON.stringify(escape),
		(await store.delete(escape)).error?.code === "outside-store",
	);
}
check("nothing escaped the store", (await readdir(base)).join(",") === "artifacts", await readdir(base));

console.log("limits");
check("oversize write rejected", (await store.write("big", "y".repeat(500_000))).error?.code === "too-large");
check("non-string content rejected", (await store.write("bad", 42)).error?.code === "invalid-content");
check("a smaller cap is honoured", (await new ArtifactStore(root, 10).write("tiny", doc)).error?.code === "too-large");

console.log("delete");
r = await store.delete("q3");
check("delete succeeds", r.ok && r.value.removed === true, r);
check("the file is really gone", !(await readdir(root)).includes("q3.html"), await readdir(root));
check("deleting a missing artifact is rejected", (await store.delete("q3")).error?.code === "not-found");

await rm(base, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL OK" : "\n" + failures + " FAILURE(S)");
process.exitCode = failures === 0 ? 0 : 1;
