import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore, SESSIONS_DIR, VERSIONS_DIR, extractTitle } from "../lib/store.js";

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

console.log("flat store");
check("nested write rejected", (await store.write("reports/q3", doc)).error?.code === "outside-store");
check("nested read rejected", (await store.read("reports/q3")).error?.code === "outside-store");
check("the versions directory is not an artifact name", (await store.write(VERSIONS_DIR, doc)).error?.code === "outside-store");

console.log("versions");
const vroot = join(base, "versioned");
const vstore = new ArtifactStore(vroot);
const pause = () => new Promise((done) => setTimeout(done, 12));

await vstore.write("doc", "<title>One</title>v1");
r = await vstore.listVersions("doc");
check("a first write keeps no history", r.ok && r.value.versions.length === 0, r.value?.versions);

await pause();
await vstore.write("doc", "<title>Two</title>v2");
r = await vstore.listVersions("doc");
check("overwriting keeps the displaced content", r.ok && r.value.versions.length === 1, r.value?.versions);
check("the kept version is titled by its own markup", r.value.versions[0]?.title === "One", r.value.versions[0]);
check("the kept version reports its size", r.value.versions[0]?.bytes > 0, r.value.versions[0]);

await pause();
await vstore.write("doc", "<title>Two</title>v2");
r = await vstore.listVersions("doc");
check("an unchanged rewrite adds no version", r.ok && r.value.versions.length === 1, r.value?.versions);

await pause();
await vstore.write("doc", "<title>Three</title>v3");
r = await vstore.listVersions("doc");
check("history is newest first", r.value.versions.map((v) => v.title).join(",") === "Two,One", r.value.versions);

const oldest = r.value.versions[1].id;
r = await vstore.readVersion("doc", oldest);
check("a version round-trips its content", r.ok && r.value.content === "<title>One</title>v1", r);
check("an unknown version is not found", (await vstore.readVersion("doc", "1")).error?.code === "not-found");
for (const bad of ["", "..", "../../escape", "abc", "1a", undefined]) {
	check(
		"version id rejected: " + JSON.stringify(bad),
		(await vstore.readVersion("doc", bad)).error?.code === "invalid-version",
	);
}

console.log("restore");
r = await vstore.restoreVersion("doc", oldest);
check("restore succeeds", r.ok && r.value.restored === oldest, r);
check("the artifact holds the restored content", (await vstore.read("doc")).value?.content === "<title>One</title>v1");
r = await vstore.listVersions("doc");
check("restoring snapshots what it displaced", r.value.versions[0]?.title === "Three", r.value.versions);
check("a restore can itself be undone", r.value.versions.length === 3, r.value.versions.length);

console.log("retention");
const kroot = join(base, "kept");
const kstore = new ArtifactStore(kroot, 400_000, 2);
for (const n of [1, 2, 3, 4, 5]) {
	await kstore.write("k", "<title>v" + n + "</title>");
	await pause();
}
r = await kstore.listVersions("k");
check("history stops at the limit", r.value.versions.length === 2, r.value.versions.length);
check("the oldest go first", r.value.versions.map((v) => v.title).join(",") === "v4,v3", r.value.versions);

const zstore = new ArtifactStore(join(base, "unversioned"), 400_000, 0);
await zstore.write("z", "a");
await zstore.write("z", "b");
check("a zero limit keeps no history at all", (await zstore.listVersions("z")).value.versions.length === 0);

console.log("history is invisible");
check("versions do not appear in the artifact list", (await vstore.list()).value.artifacts.every((a) => a.name.endsWith(".html") && !a.name.startsWith(".")), (await vstore.list()).value.artifacts.map((a) => a.name));
check("the store root holds one artifact and the history directory", (await readdir(vroot)).sort().join(",") === ".versions,doc.html", await readdir(vroot));

console.log("delete takes the history");
check("delete succeeds", (await vstore.delete("doc")).ok);
check("the history directory is gone", !(await readdir(join(vroot, VERSIONS_DIR))).includes("doc"), await readdir(join(vroot, VERSIONS_DIR)));
check("a fresh artifact of the same name starts empty", (await vstore.listVersions("doc")).value.versions.length === 0);

console.log("diff");
// Load the browser half the way the app does: a stub module loader captures the
// registration, and the factory is called with a `require` that answers with
// empty objects. Nothing in the factory touches react or the icon set until a
// view mounts, so the pure helpers come back usable.
let registered = null;
globalThis.window = { __ModuleLoader__: { load: (spec) => (registered = spec) } };
await import("../lib/client.js");
const { diffRevisions, foldUnchanged, formatBytes, splitForDiff } = registered.factory(() => ({}))
	.__internals;

check("bytes under a kilobyte are exact", formatBytes(512) === "512 B", formatBytes(512));
check("kilobytes are rounded", formatBytes(2048) === "2 KB", formatBytes(2048));
check("megabytes keep one decimal", formatBytes(1024 * 1024 * 3.5) === "3.5 MB", formatBytes(1024 * 1024 * 3.5));

check(
	"compact markup splits where tags meet",
	splitForDiff("<p>a</p><p>b</p>").length === 2,
	splitForDiff("<p>a</p><p>b</p>"),
);
check(
	"an inline unit is not torn apart",
	splitForDiff("<p>a</p>")[0] === "<p>a</p>",
	splitForDiff("<p>a</p>"),
);
check(
	"nesting gives the diff more to align on",
	splitForDiff("<div><p>a</p></div>").length === 3,
	splitForDiff("<div><p>a</p></div>"),
);

const page = (body) => "<html><head><title>T</title></head><body>" + body + "</body></html>";
check("identical revisions report no rows", diffRevisions(page("<p>a</p>"), page("<p>a</p>")).identical === true);

let d = diffRevisions(page("<p>a</p>"), page("<p>a</p><p>b</p>"));
check("an insertion is all additions", d.rows.every((r) => r.kind !== "remove"), d.rows);
check("an insertion shows the new line", d.rows.some((r) => r.kind === "add" && r.text.includes("b")), d.rows);

d = diffRevisions(page("<p>a</p><p>b</p>"), page("<p>a</p>"));
check("a deletion is all removals", d.rows.every((r) => r.kind !== "add"), d.rows);

d = diffRevisions(page("<p>old</p>"), page("<p>new</p>"));
check("a replacement is both", d.rows.some((r) => r.kind === "add") && d.rows.some((r) => r.kind === "remove"), d.rows);

// The head and tail this shares with itself must never reach the table: the
// trim is what keeps a one-line edit in a long document affordable.
const long = (mid) => page("<p>x</p>".repeat(200) + mid + "<p>y</p>".repeat(200));
d = diffRevisions(long("<p>a</p>"), long("<p>b</p>"));
check("common head and tail are trimmed off", d.rows.length < 10, d.rows.length);

const wide = (seed) => Array.from({ length: 2100 }, (_, n) => "<p>" + seed + n + "</p>").join("");
check("a pair too far apart declines rather than hangs", diffRevisions(page(wide("a")), page(wide("b"))).tooLarge === true);

const same = (n) => Array.from({ length: n }, (_, i) => ({ kind: "same", text: "line" + i }));
let folded = foldUnchanged([...same(20), { kind: "add", text: "new" }]);
check("a long unchanged run folds", folded.some((r) => r.kind === "fold"), folded.map((r) => r.kind));
check("the fold counts what it hid", folded.find((r) => r.kind === "fold")?.count === 14, folded);
check("context survives around the fold", folded.filter((r) => r.kind === "same").length === 6, folded.length);
check("the change itself is never folded", folded[folded.length - 1].kind === "add", folded[folded.length - 1]);
folded = foldUnchanged(same(4));
check("a short run stays whole", folded.length === 4 && folded.every((r) => r.kind === "same"), folded);

console.log("sessions");
// A separate store, so the artifacts written above do not blur what is scoped.
const scoped = new ArtifactStore(join(base, "scoped"));
await scoped.write("mine", doc, "s1");
await scoped.write("theirs", doc, "s2");
await scoped.write("unowned", doc);
await scoped.write("shared", doc, "s2");
await scoped.write("shared", doc + " ", "s1");
const names = async (id) => (await scoped.list(id)).value.artifacts.map((a) => a.name).sort();
check("unscoped lists every artifact", (await names()).length === 4, await names());
check("a session lists what it wrote", JSON.stringify(await names("s1")) === JSON.stringify(["mine.html", "shared.html"]), await names("s1"));
check("an artifact rewritten by another session belongs to both", (await names("s2")).includes("shared.html"), await names("s2"));
check("an artifact with no record belongs to no session", !(await names("s1")).includes("unowned.html"));
check("the record directory is not listed", !(await names()).some((n) => n.startsWith(".")), await names());
await scoped.delete("mine");
check("delete drops the session record", !(await readdir(join(base, "scoped", SESSIONS_DIR))).includes("mine.json"));
check("a session id cannot name an artifact", (await scoped.write(SESSIONS_DIR, doc)).error?.code === "outside-store");

await rm(base, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL OK" : "\n" + failures + " FAILURE(S)");
process.exitCode = failures === 0 ? 0 : 1;
