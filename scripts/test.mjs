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
// React is not a dependency of this package — it is a PEER the app provides — so
// the factory's `require` answers with the one function the row components call.
// That is enough to render them for real: a component built from
// `createElement` returns a plain element tree, which a test can walk and press.
// The row also keeps two refs and an effect, so the stub carries just enough of
// a hook runtime for one component at a time: `hooks` is the instance being
// rendered, and an effect runs after its render, as React's would.
let hooks = null;
const reactStub = {
	createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
	useRef: (initial) => {
		const slot = hooks.cursor++;
		if (!(slot in hooks.slots)) hooks.slots[slot] = { current: initial };
		return hooks.slots[slot];
	},
	useEffect: (effect) => {
		hooks.cursor++;
		hooks.effects.push(effect);
	},
};
/** Render one instance of a component; render it again with `instance.render(props)`. */
const mountComponent = (Component) => {
	const instance = { slots: {}, cursor: 0, effects: [] };
	return {
		render(props) {
			hooks = instance;
			instance.cursor = 0;
			instance.effects = [];
			const tree = Component(props);
			for (const effect of instance.effects) effect();
			hooks = null;
			return tree;
		},
	};
};
const client = registered.factory((id) => (id === "react" ? reactStub : {}));
const { diffRevisions, foldUnchanged, formatBytes, splitForDiff } = client.__internals;

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

console.log("the conversation's artifact row");
// The row's one decision is whether the conversation links an artifact or not,
// and both directions of getting it wrong are silent: a link built for a `list`
// opens nothing, and a missing link is the whole feature absent. So the model is
// exercised here as plain data, exactly as a Tool block delivers it.
const { artifactFileName, artifactRowModel } = client.__internals;
check("a path without a suffix takes the store's", artifactFileName("q3-report") === "q3-report.html", artifactFileName("q3-report"));
check("an explicit suffix is not doubled", artifactFileName("q3-report.html") === "q3-report.html", artifactFileName("q3-report.html"));
check("the last segment is the name", artifactFileName("nested/q3") === "q3.html", artifactFileName("nested/q3"));
check("no path means no name", artifactFileName(undefined) === "" && artifactFileName("") === "", artifactFileName(undefined));

const settled = (args, extra) => ({
	kind: "tool-result",
	callId: "call-1",
	call: { name: "artifact", argsRaw: JSON.stringify(args) },
	content: [{ type: "text", text: "Wrote q3-report.html" }],
	isError: false,
	...extra,
});

let row = artifactRowModel(settled({ command: "write", path: "q3-report", content: "<html></html>" }));
check("a write names the artifact the store will hold", row.name === "q3-report.html", row);
check("a write reports its own command", row.command === "write", row);
check("a settled write is openable", row.openable === true, row);

check("a list has nothing to open", artifactRowModel(settled({ command: "list" })).openable === false);
check(
	"a list is still labelled as one",
	artifactRowModel(settled({ command: "list" })).command === "list",
);
check(
	"a list names no artifact, which is not the same as unreadable arguments",
	artifactRowModel(settled({ command: "list" })).name === "",
);
check(
	"a delete leaves nothing to open: it removed the file",
	artifactRowModel(settled({ command: "delete", path: "q3-report" })).openable === false,
);
check(
	"a read of an artifact is openable",
	artifactRowModel(settled({ command: "read", path: "q3-report" })).openable === true,
);

row = artifactRowModel(
	settled(
		{ command: "write", path: "q3-report", content: "<html></html>" },
		{ isError: true, error: { name: "ToolError", code: "too-large" }, content: [{ type: "text", text: "artifact: too-large: nope" }] },
	),
);
check("a failed write is not openable", row.openable === false, row);
check("a failure is summarized by its first line", row.errorSummary === "artifact: too-large: nope", row);

check("a preparing call is not openable", artifactRowModel({ phase: "preparing", callId: "call-2" }).openable === false);
check(
	"a preparing call says so",
	artifactRowModel({ phase: "preparing", callId: "call-2" }).state === "preparing",
);
check(
	"a started call reads its arguments for the link",
	artifactRowModel({ phase: "start", callId: "call-3", argsRaw: JSON.stringify({ command: "read", path: "x" }) }).name === "x.html",
);
check(
	"a running write offers no link yet: the file is not there",
	artifactRowModel({ phase: "start", callId: "call-3", argsRaw: JSON.stringify({ command: "write", path: "x" }) }).openable === false,
);
check(
	"unparsable arguments are a row, not a crash",
	artifactRowModel({ phase: "start", callId: "call-4", argsRaw: "{" }).name === "",
);
check(
	"a stopped call is not openable",
	artifactRowModel(settled({ command: "write", path: "x" }, { isError: true, error: { name: "E", code: "interrupted" } })).openable === false,
);

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

console.log("model-facing text");
// The host half imports harness packages that do not resolve outside a running
// dsh, so the model-facing strings live in their own module and are exercised
// here as plain text. That split exists because of the bug this section covers:
// tool output printed the absolute store path, the model linked an artifact like
// a file in a directory the app never serves, and the link failed silently.
const { renderOutcome, promptSection, skillContent, toolDescription } = await import("../lib/text.js");
const storeRoot = join(base, "artifacts");
const written = join(storeRoot, "q3.html");

check(
	"a write is reported by store-relative name, not by path",
	renderOutcome({ ok: true, value: { path: written, title: "Q3 Report" } }) ===
		"Wrote q3.html — the user opens it from the jump link on this call, or from the artifact panel.",
	renderOutcome({ ok: true, value: { path: written, title: "Q3 Report" } }),
);
check(
	"the write reply names the jump link the conversation carries",
	/jump link/i.test(renderOutcome({ ok: true, value: { path: written, title: "Q3 Report" } })),
	renderOutcome({ ok: true, value: { path: written, title: "Q3 Report" } }),
);
check(
	"a delete is reported by name too",
	renderOutcome({ ok: true, value: { path: written, removed: true } }) === "Deleted q3.html.",
	renderOutcome({ ok: true, value: { path: written, removed: true } }),
);
check(
	"an empty list says where the store is",
	renderOutcome({ ok: true, value: { artifacts: [], root: storeRoot } }) ===
		"No artifacts yet in " + storeRoot + ".",
	renderOutcome({ ok: true, value: { artifacts: [], root: storeRoot } }),
);
check(
	"a list is a readable name/title table",
	renderOutcome({
		ok: true,
		value: {
			artifacts: [
				{ name: "q3.html", title: "Q3 Report" },
				{ name: "later.html", title: "Later" },
			],
			root: storeRoot,
		},
	}) === "Artifacts (2):\n- q3.html\tQ3 Report\n- later.html\tLater",
	renderOutcome({
		ok: true,
		value: {
			artifacts: [
				{ name: "q3.html", title: "Q3 Report" },
				{ name: "later.html", title: "Later" },
			],
			root: storeRoot,
		},
	}),
);
check("a read still returns the raw document", renderOutcome({ ok: true, value: { content: doc } }) === doc);
check(
	"a failure names its code",
	renderOutcome({ ok: false, error: { code: "not-found", message: "no artifact at x" } }) ===
		"artifact: not-found: no artifact at x",
	renderOutcome({ ok: false, error: { code: "not-found", message: "no artifact at x" } }),
);

/**
 * The two things that made the store path usable as a link.
 *
 * `openable` is any absolute path or `file:` URL: what a model turns into an
 * href. `bareOpenable` is the harder rule — prose with code spans stripped —
 * because text inside backticks reads as a *value to pass*, while the same text
 * loose in a sentence reads as an address, which is what got linked. Every path
 * this plugin shows a model therefore lives in a code span, and the rule holds
 * for all four texts at once rather than with an exception carved out per file.
 */
const OPENABLE = /[A-Za-z]:[\\/]|\\\\|file:\/\//;
const bareOpenable = (text) => OPENABLE.test(text.replace(/`[^`]*`/g, ""));

// What the tool SAYS back is what a model quotes into a final answer, so no
// reply may carry a path at all.
for (const [label, outcome] of [
	["write", { ok: true, value: { path: written, title: "Q3 Report" } }],
	["delete", { ok: true, value: { path: written, removed: true } }],
]) {
	check("the " + label + " reply carries no path", !OPENABLE.test(renderOutcome(outcome)), renderOutcome(outcome));
}

// The prose builders name the store, because a model has to know where its
// output lands. What they must never do is leave a path loose in a sentence.
check("every path in the tool description is a code span", !bareOpenable(toolDescription(storeRoot)), toolDescription(storeRoot).slice(0, 300));
check("every path in the prompt section is a code span", !bareOpenable(promptSection(storeRoot)), promptSection(storeRoot).slice(0, 300));
check("every path in the skill body is a code span", !bareOpenable(skillContent(storeRoot)), skillContent(storeRoot).slice(0, 300));
check(
	"the tool description still names the store",
	/`path` is relative to it/.test(toolDescription(storeRoot)),
	toolDescription(storeRoot).slice(0, 200),
);
check(
	"the prompt tells the model not to link an artifact",
	/\bnever\b[^.]*\bpath\b/i.test(promptSection(storeRoot)) && /\blink\b/i.test(promptSection(storeRoot)),
	promptSection(storeRoot),
);
check(
	"the skill tells the model not to link an artifact",
	/never link it/i.test(skillContent(storeRoot)) && /artifact panel/i.test(skillContent(storeRoot)),
	skillContent(storeRoot).slice(0, 400),
);

console.log("client registrations");
// The browser half now registers into three surfaces that only exist on some
// host versions, and the failure this section exists to catch is the loud one:
// a service named in the plugin's own `inject` list that an older host does not
// provide leaves the whole fiber PENDING, taking the `artifact` tool, the panel
// and the session tab down with it. So the Cordis surface is stubbed, every
// registration is read back, and the fallback path is exercised by making the
// right Sidebar refuse exactly the way it refuses with no Session on screen.
function fakeClientContext({ withSidebar = true, withLayout = true, openTabRefuses = false } = {}) {
	const registrations = [];
	const tabTypes = [];
	const opened = [];
	const panels = [];
	const injected = [];
	const sidebarRight = {
		openTab(kind, options) {
			if (openTabRefuses) throw new Error("sidebarRight: nothing is mounted");
			opened.push({ kind, options });
		},
	};
	const sidebarRightTabs = {
		register(definition) {
			tabTypes.push(definition);
			return () => {};
		},
	};
	const ctx = {
		effect(execute) {
			return execute();
		},
		inject(names, callback) {
			injected.push(names);
			if (withSidebar) callback({ sidebarRight, sidebarRightTabs });
			return { dispose() {} };
		},
		get(name) {
			if (name === "remote.artifact") return {};
			if (name === "layout" && withLayout) return { selectPanel: (id) => panels.push(id) };
			return undefined;
		},
		locale: { register: () => () => {}, bind: () => (key) => key },
		remote: { $mount: async () => async () => {} },
		slots: {
			inject(key, callback) {
				callback();
				return () => {};
			},
			register(options, Component) {
				registrations.push({ options, Component });
				return () => {};
			},
		},
	};
	return { ctx, registrations, tabTypes, opened, panels, injected };
}

/** One registration by slot name and an option predicate. */
const findRegistered = (registrations, name, predicate) =>
	registrations.find(
		(entry) => entry.options.name === name && (predicate === undefined || predicate(entry.options)),
	);

check(
	"the right Sidebar is not a hard dependency",
	JSON.stringify(client.inject) === JSON.stringify(["slots", "remote", "locale"]),
	client.inject,
);

const wired = fakeClientContext({});
await client.apply(wired.ctx);
const toolview = findRegistered(wired.registrations, "tool.call.toolview", (o) => o.key === "artifact");
const tabBody = findRegistered(wired.registrations, "sidebar.right.pane.tab", (o) => o.key === "dsh-artifact");

check("the artifact call gets its own conversation row", toolview !== undefined && typeof toolview.Component === "function", toolview);
check("the row is localized by this plugin's namespace", toolview?.options.locale === "artifact", toolview?.options.locale);
check("the right Sidebar body is registered under the type's own id", tabBody !== undefined, tabBody);
check("the panel and its sidebar icon still exist", findRegistered(wired.registrations, "main", (o) => o.key === "artifacts") !== undefined && findRegistered(wired.registrations, "sidebar.panellist", (o) => o.id === "artifacts") !== undefined);
check("the per-conversation view tab still exists", findRegistered(wired.registrations, "conversation.view", (o) => o.id === "artifacts") !== undefined);

check(
	"the right Sidebar services are waited for, not required",
	wired.injected.some((names) => names.includes("sidebarRightTabs") && names.includes("sidebarRight")),
	wired.injected,
);
check("one tab type is registered", wired.tabTypes.length === 1, wired.tabTypes.length);
check("it is this package's own tab", wired.tabTypes[0]?.id === "dsh-artifact" && wired.tabTypes[0]?.kind === "artifact", wired.tabTypes[0]);
check("it is an extension, the band that may take a builtin over", wired.tabTypes[0]?.priority === "extension", wired.tabTypes[0]?.priority);
check(
	"the guide offers it as a page with a title",
	wired.tabTypes[0]?.guide?.length === 1 && typeof wired.tabTypes[0].guide[0].title() === "string" && wired.tabTypes[0].guide[0].order === 20,
	wired.tabTypes[0]?.guide,
);
check(
	"the tab's chip text re-resolves through a thunk",
	typeof wired.tabTypes[0]?.title === "function" && wired.tabTypes[0].title() === "tab.label",
	wired.tabTypes[0]?.title,
);

const reveal = toolview.options.inject().revealArtifact;
reveal("q3-report.html");
check(
	"a jump link opens the artifact tab with the path it names",
	wired.opened.length === 1 && wired.opened[0].kind === "artifact" && wired.opened[0].options.params.path === "q3-report.html",
	wired.opened,
);
check("and opens no panel behind it", wired.panels.length === 0, wired.panels);
reveal("");
reveal(undefined);
check("an empty path opens nothing at all", wired.opened.length === 1, wired.opened.length);

const legacy = fakeClientContext({ withSidebar: false });
await client.apply(legacy.ctx);
findRegistered(legacy.registrations, "tool.call.toolview", (o) => o.key === "artifact")
	.options.inject()
	.revealArtifact("q3-report.html");
check("without a right Sidebar the panel takes the jump", legacy.panels.join(",") === "artifacts", legacy.panels);
check("and no tab type is registered there", legacy.tabTypes.length === 0, legacy.tabTypes.length);

const refusing = fakeClientContext({ openTabRefuses: true });
await client.apply(refusing.ctx);
findRegistered(refusing.registrations, "tool.call.toolview", (o) => o.key === "artifact")
	.options.inject()
	.revealArtifact("q3-report.html");
check("a right Sidebar that refuses falls back to the panel", refusing.panels.join(",") === "artifacts", refusing.panels);

const bare = fakeClientContext({ withSidebar: false, withLayout: false });
await client.apply(bare.ctx);
findRegistered(bare.registrations, "tool.call.toolview", (o) => o.key === "artifact")
	.options.inject()
	.revealArtifact("q3-report.html");
check("a host with neither surface simply does nothing", bare.panels.length === 0 && bare.opened.length === 0);

console.log("the row as it renders");
// The pure model above says whether a call HAS an artifact; this section says
// what the reader gets, and that pressing it opens the artifact it names. Both
// halves matter, and the second one is the feature.
const findElement = (element, predicate) => {
	if (element === null || element === undefined || typeof element !== "object") return null;
	if (Array.isArray(element)) {
		for (const child of element) {
			const found = findElement(child, predicate);
			if (found !== null) return found;
		}
		return null;
	}
	if (predicate(element)) return element;
	return findElement(element.children ?? [], predicate);
};
const isLink = (node) => node.props?.className === "dsh-artifact__link";
const rowComponent = () => findRegistered(wired.registrations, "tool.call.toolview", (o) => o.key === "artifact").Component;
const renderRow = (block, revealArtifact) =>
	mountComponent(rowComponent()).render({ t: (key) => key, block, revealArtifact });
const renderLink = (block, revealArtifact) => findElement(renderRow(block, revealArtifact), isLink);

const openedPaths = [];
const link = renderLink(settled({ command: "write", path: "q3-report" }), (path) => openedPaths.push(path));
check("the row draws the artifact's name as a link", link !== null && link.children.join("") === "q3-report.html", link?.children);
check("it is a real button, not a div or a bare span", link?.type === "button", link?.type);
check("the link names the artifact in its accessible label", link?.props["aria-label"] === "row.openTitle", link?.props["aria-label"]);

let stopped = 0;
link.props.onClick({ stopPropagation: () => (stopped += 1) });
check("pressing it opens the artifact it names", openedPaths.join(",") === "q3-report.html", openedPaths);
check("and does not also toggle the tool call row", stopped === 1, stopped);

check("a list row draws no link at all", renderLink(settled({ command: "list" }), () => {}) === null);
check(
	"a failed write draws no dead link",
	renderLink(
		settled({ command: "write", path: "x" }, { isError: true, error: { name: "E", code: "nope" }, content: [] }),
		() => {},
	) === null,
);
check(
	"a row with no opener draws no dead link either",
	renderLink(settled({ command: "write", path: "x" }), undefined) === null,
);
check(
	"a preparing call says what it is doing",
	findElement(renderRow({ phase: "preparing", callId: "call-9" }, () => {}), (n) => n.props?.className === "dsh-artifact__toolnote")?.children.join("") === "row.preparing",
);
check(
	"every row keeps the tool's own name for the transcript",
	renderRow(settled({ command: "write", path: "x" }), () => {}).props["data-tool"] === "artifact",
);

// A write the reader watched finish opens beside the chat by itself; a row
// replayed from history does not, and neither does anything but a `write`.
{
	const shown = [];
	const showArtifact = (path) => shown.push(path);
	const live = mountComponent(rowComponent());
	const running = { phase: "start", callId: "call-1", argsRaw: JSON.stringify({ command: "write", path: "q3-report" }) };
	live.render({ t: (key) => key, block: running, showArtifact });
	check("a running write opens nothing yet", shown.length === 0, shown);
	live.render({ t: (key) => key, block: settled({ command: "write", path: "q3-report" }), showArtifact });
	check("a write that finishes on screen opens what it wrote", shown.join(",") === "q3-report.html", shown);
	live.render({ t: (key) => key, block: settled({ command: "write", path: "q3-report" }), showArtifact });
	check("and only once, however often the row renders again", shown.length === 1, shown);

	shown.length = 0;
	mountComponent(rowComponent()).render({ t: (key) => key, block: settled({ command: "write", path: "old" }), showArtifact });
	check("a write replayed from history stays shut", shown.length === 0, shown);

	const reading = mountComponent(rowComponent());
	reading.render({ t: (key) => key, block: { phase: "start", callId: "c", argsRaw: JSON.stringify({ command: "read", path: "q3" }) }, showArtifact });
	reading.render({ t: (key) => key, block: settled({ command: "read", path: "q3" }), showArtifact });
	check("a read opens nothing on its own", shown.length === 0, shown);
}

console.log("decks");
{
	const deckStore = new ArtifactStore(join(base, "decks"));
	const deck =
		'<!doctype html><html><head><title>Q3 review</title></head><body><section id="a" style="background:#fff"><h1 style="font-size:96px">Q3</h1></section></body></html>';

	let w = await deckStore.write("q3", deck, "s1", "slides");
	check("a deck is written as a deck", w.ok && w.value.kind === "slides", w);
	let l = await deckStore.list();
	check("the list says it is a deck", l.ok && l.value.artifacts[0]?.kind === "slides", l.value?.artifacts);
	w = await deckStore.write("q3", deck.replace("Q3</h1>", "Q3 again</h1>"));
	check("a rewrite that does not say keeps it a deck", w.ok && w.value.kind === "slides", w);
	let rd = await deckStore.read("q3");
	check("reading it says so too", rd.ok && rd.value.kind === "slides", rd.value?.kind);
	await deckStore.write("page", doc);
	rd = await deckStore.read("page");
	check("a page with no record is a page", rd.ok && rd.value.kind === "html", rd.value?.kind);
	w = await deckStore.write("q3", deck, undefined, "chart");
	check("an unknown kind is refused", !w.ok && w.error.code === "invalid-kind", w);

	const before = await deckStore.listVersions("q3");
	await deckStore.write("q3", deck.replace("Q3</h1>", "Q3, saved as it goes</h1>"), undefined, undefined, {
		keepVersion: false,
	});
	const after = await deckStore.listVersions("q3");
	check(
		"a save that keeps no version adds none",
		before.ok && after.ok && after.value.versions.length === before.value.versions.length,
		[before.value?.versions.length, after.value?.versions.length],
	);

	const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
	let a = await deckStore.writeAsset("q3", "image/png", png);
	check("a picture is kept under its hash", a.ok && /^assets\/[0-9a-f]{64}\.png$/.test(a.value.src), a);
	const again = await deckStore.writeAsset("q3", "image/png", png);
	check("the same picture twice is one file", again.ok && again.value.src === a.value.src, again);
	const back = await deckStore.readAsset("q3", a.value.src);
	check("it reads back byte for byte", back.ok && back.value.base64 === png && back.value.type === "image/png", back);
	a = await deckStore.writeAsset("q3", "image/svg+xml", png);
	check("a drawing that could run is refused", !a.ok && a.error.code === "invalid-asset", a);
	const out = await deckStore.readAsset("q3", "assets/../../q3.html");
	check("a name that is not the store's own is refused", !out.ok && out.error.code === "invalid-asset", out);

	const gone = await deckStore.delete("q3");
	check("deleting a deck deletes it", gone.ok, gone);
	const leftovers = await readdir(join(base, "decks", ".assets")).catch(() => []);
	check("and its pictures and its kind with it", leftovers.length === 0 && (await deckStore.list()).value.artifacts.every((x) => x.name !== "q3.html"), leftovers);

	const { readDeck, describeDeckDiagnostics } = await import("../lib/deck.js");
	const read = readDeck(deck.replace("<h1", '<h1 class="x"'));
	check("the bundled format reads a deck", read.deck.slides.length === 1, read.deck.slides.length);
	const empty = readDeck("<!doctype html><html><body><p>no slides</p></body></html>");
	check("and finds no slide where there is none", empty.deck.slides.length === 0, empty.deck.slides.length);
	const said = describeDeckDiagnostics(readDeck(deck.replace("<h1", "<h1 onclick=\"x()\"")).diagnostics);
	check("and says what it dropped", Array.isArray(said), said);

	const { renderOutcome: render } = await import("../lib/text.js");
	const reply = render({
		ok: true,
		value: { path: join(base, "decks", "q3.html"), title: "Q3", kind: "slides", dropped: ["Slide 1, line 3: onclick is not kept."] },
	});
	check("a deck's reply lists what was dropped", reply.includes("Slide 1, line 3: onclick is not kept."), reply);
	check("and still names no path", !reply.includes(base), reply);
}

await rm(base, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL OK" : "\n" + failures + " FAILURE(S)");
process.exitCode = failures === 0 ? 0 : 1;
