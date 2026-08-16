import { mkdir, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

//#region dsh-artifact (host half)
/**
 * Artifact bundle, host half.
 *
 * An artifact is one self-contained HTML file in the harness's own artifact
 * store. Four surfaces share that single model:
 *
 * 1. `artifact` — a Typert Remote service the browser half calls over the
 *    `remote.artifact` namespace to drive the artifact browser.
 * 2. `artifact` — a model-facing tool so the agent can list/read/write/delete
 *    the same files.
 * 3. A system-prompt section naming the absolute store, so the model knows
 *    both that the surface exists and where its output lands.
 * 4. The bundled `writing-artifacts` skill, registered as a runtime skill so
 *    it travels inside this package rather than needing a skill root on disk.
 *
 * Artifacts are plain HTML documents: a human opens one in a browser, the
 * agent rewrites it as text, and the in-app browser renders it in a sandboxed
 * iframe. One format, three readers.
 *
 * WHY node:fs AND NOT ctx.fs — the store is harness user data under
 * `$DSH_HOME`, a sibling of `sessions/` and `storages/`, not workspace
 * content. Three facts make the filesystem service the wrong tool for it:
 * the service exposes no delete and no mkdir at all, so half of this
 * plugin's operations have no counterpart there; and its sandbox exists to
 * confine writes to the session workspace, which the store sits outside of,
 * so every artifact write under the default `workspace-write` policy would
 * be denied until the user approved an escalation. Confinement is enforced
 * here instead: every path resolves inside `root` or is rejected.
 */

const ARTIFACT_EXTENSION = ".html";
const DEFAULT_ARTIFACT_DIRNAME = "artifacts";
const DEFAULT_MAX_ARTIFACT_CHARS = 400_000;
/** Bytes scanned from the head of each artifact when listing, to find its title. */
const TITLE_SCAN_BYTES = 8192;

/**
 * Recreate the compiled `@Remote("method")` decorator without decorator
 * syntax. The `Remote(exportName)` decorator records a private marker on the
 * class prototype via `context.addInitializer`; we supply the same
 * `ClassMethodDecoratorContext` shape and a dummy instance whose prototype is
 * the target class, which is exactly what `remoteMethods(service)` later reads.
 * @param cls - the Service subclass.
 * @param methodName - public instance method name to expose on the wire.
 */
function markRemote(cls, methodName) {
	Remote(methodName)(cls.prototype[methodName], {
		kind: "method",
		name: methodName,
		static: false,
		private: false,
		addInitializer(fn) {
			fn.call(Object.create(cls.prototype));
		},
	});
}

/** Runtime configuration schema. */
const Config = z.object({
	// Schemastery fields are optional unless `.required()` says otherwise —
	// there is no `.optional()`, and calling one crashes at module evaluation.
	/** Absolute directory owning artifact HTML files (default: `$DSH_HOME/artifacts`). */
	root: z.string(),
	/** Maximum characters accepted in one write. */
	maxArtifactChars: z.number().default(DEFAULT_MAX_ARTIFACT_CHARS),
	/** Register the system-prompt section that tells the model artifacts exist. */
	promptSection: z.boolean().default(true),
	/** Register the bundled `writing-artifacts` skill. */
	skill: z.boolean().default(true),
});

/** Frozen business-failure branch shared with the client Remote union. */
function rejected(code, message, details = {}) {
	return Object.freeze({ ok: false, error: Object.freeze({ code, message, ...details }) });
}
/** Frozen business-success branch shared with the client Remote union. */
function success(value) {
	return Object.freeze({ ok: true, value });
}

/**
 * Pull a display title out of artifact markup: `<title>` first, then the first
 * heading, then nothing. Cheap string scanning on purpose — listing artifacts
 * must not pay for an HTML parser, and a missing title degrades to the
 * filename rather than to an error.
 * @param html - artifact markup, or its head when listing.
 * @returns the trimmed title, or undefined when the markup carries none.
 */
function extractTitle(html) {
	if (typeof html !== "string") return undefined;
	const head = html.slice(0, TITLE_SCAN_BYTES);
	const match =
		/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head) ?? /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(head);
	if (match === null) return undefined;
	const text = match[1].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
	return text.length === 0 ? undefined : text.slice(0, 200);
}

/** Artifact list/read/write/delete Remote service backing the browser UI. */
class ArtifactService extends TypertRemoteService {
	static Config = Config;

	constructor(ctx, config = {}) {
		super(ctx, "artifact");
		this.root = resolve(config.root ?? dshHomePath(DEFAULT_ARTIFACT_DIRNAME));
		this.maxArtifactChars =
			Number.isSafeInteger(config.maxArtifactChars) && config.maxArtifactChars > 0
				? config.maxArtifactChars
				: DEFAULT_MAX_ARTIFACT_CHARS;
	}

	/**
	 * Resolve a model- or UI-supplied path to an absolute artifact path inside
	 * the store, or return undefined when it escapes.
	 *
	 * Confinement is a property of this resolver rather than a check bolted on
	 * afterwards: `..` segments, a sibling-directory prefix, and an absolute
	 * path pointing anywhere else all fail the same way, and an artifact that
	 * cannot be located again is exactly the failure this prevents.
	 * @param path - artifact path, absolute or relative to the store.
	 * @returns the absolute path, or undefined when it lands outside the store.
	 */
	resolveArtifactPath(path) {
		const named = path.endsWith(ARTIFACT_EXTENSION) ? path : path + ARTIFACT_EXTENSION;
		const absolute = resolve(isAbsolute(named) ? named : join(this.root, named));
		const within = relative(this.root, absolute);
		if (within.length === 0 || within.startsWith("..") || isAbsolute(within)) return undefined;
		return absolute;
	}

	/** Read at most the head of one artifact, for title extraction while listing. */
	async readHead(path) {
		const handle = await open(path, "r");
		try {
			const buffer = Buffer.alloc(TITLE_SCAN_BYTES);
			const { bytesRead } = await handle.read(buffer, 0, TITLE_SCAN_BYTES, 0);
			return buffer.subarray(0, bytesRead).toString("utf8");
		} finally {
			await handle.close();
		}
	}

	/**
	 * @Remote listArtifacts — every artifact in the store, newest first.
	 *
	 * A store that does not exist yet is empty state, not a failure: it is
	 * created by the first write, and a fresh install must show an empty
	 * browser rather than an error.
	 */
	async listArtifacts(request) {
		void request;
		try {
			let entries;
			try {
				entries = await readdir(this.root, { withFileTypes: true });
			} catch (error) {
				if (error?.code === "ENOENT") return success({ artifacts: [], root: this.root });
				throw error;
			}
			const artifacts = [];
			for (const entry of entries) {
				if (!entry.isFile() || !entry.name.endsWith(ARTIFACT_EXTENSION)) continue;
				const path = join(this.root, entry.name);
				let title;
				let modified = 0;
				try {
					title = extractTitle(await this.readHead(path));
					modified = (await stat(path)).mtimeMs;
				} catch (_) {
					/* an unreadable artifact still belongs in the list, titled by its filename */
				}
				artifacts.push({
					path,
					name: entry.name,
					title: title ?? entry.name.slice(0, -ARTIFACT_EXTENSION.length),
					modified,
				});
			}
			artifacts.sort((a, b) => b.modified - a.modified || (a.name < b.name ? -1 : 1));
			return success({ artifacts, root: this.root });
		} catch (error) {
			return rejected("list-failed", error instanceof Error ? error.message : String(error));
		}
	}

	/** @Remote readArtifact — read one artifact's full HTML. */
	async readArtifact(request) {
		const path = request?.path;
		if (typeof path !== "string" || path.trim().length === 0) {
			return rejected("invalid-path", "path must be a non-empty string");
		}
		const absolute = this.resolveArtifactPath(path);
		if (absolute === undefined) {
			return rejected("outside-store", "path must stay inside the artifact store " + this.root);
		}
		try {
			const content = await readFile(absolute, "utf8");
			return success({ path: absolute, content, title: extractTitle(content) });
		} catch (error) {
			if (error?.code === "ENOENT") return rejected("not-found", "no artifact at " + absolute);
			return rejected("read-failed", error instanceof Error ? error.message : String(error));
		}
	}

	/** @Remote writeArtifact — create or replace one artifact's full HTML. */
	async writeArtifact(request) {
		const path = request?.path;
		const content = request?.content;
		if (typeof path !== "string" || path.trim().length === 0) {
			return rejected("invalid-path", "path must be a non-empty string");
		}
		if (typeof content !== "string") {
			return rejected("invalid-content", "content must be a string");
		}
		if (content.length > this.maxArtifactChars) {
			return rejected("too-large", "artifact exceeds " + this.maxArtifactChars + " characters", {
				maxChars: this.maxArtifactChars,
				actualChars: content.length,
			});
		}
		const absolute = this.resolveArtifactPath(path);
		if (absolute === undefined) {
			return rejected("outside-store", "path must stay inside the artifact store " + this.root);
		}
		try {
			// Nothing else creates the store: no install step writes it, and the
			// filesystem service has no mkdir. Without this the very first
			// artifact of a fresh install fails to write and never appears.
			await mkdir(absolute.slice(0, absolute.lastIndexOf(sep)), { recursive: true });
			await writeFile(absolute, content, "utf8");
			return success({ path: absolute, title: extractTitle(content) });
		} catch (error) {
			return rejected("write-failed", error instanceof Error ? error.message : String(error));
		}
	}

	/** @Remote deleteArtifact — delete one artifact. */
	async deleteArtifact(request) {
		const path = request?.path;
		if (typeof path !== "string" || path.trim().length === 0) {
			return rejected("invalid-path", "path must be a non-empty string");
		}
		const absolute = this.resolveArtifactPath(path);
		if (absolute === undefined) {
			return rejected("outside-store", "path must stay inside the artifact store " + this.root);
		}
		try {
			const info = await stat(absolute);
			if (!info.isFile()) return rejected("not-found", "no artifact at " + absolute);
			await rm(absolute);
			return success({ path: absolute, removed: true });
		} catch (error) {
			if (error?.code === "ENOENT") return rejected("not-found", "no artifact at " + absolute);
			return rejected("delete-failed", error instanceof Error ? error.message : String(error));
		}
	}
}
// Every wire method carries the `Artifact` suffix. The client gateway builds
// one `RemoteNamespaceService` per namespace and rejects any method name that
// collides with that class — `ctx`, `empty`, `invokeRemote`, `methods`, `name`,
// `namespace`, `assertMethodAvailable`, `has`, `install`, `installDirect`,
// `installScoped`, `remove`. A bare verb like `list` or `remove` is one gateway
// release away from that list; a suffixed name cannot land on it.
markRemote(ArtifactService, "listArtifacts");
markRemote(ArtifactService, "readArtifact");
markRemote(ArtifactService, "writeArtifact");
markRemote(ArtifactService, "deleteArtifact");

/** The model-facing tool description, which names the concrete store. */
function toolDescription(root) {
	return `Create, read, update, and delete artifacts: self-contained HTML documents the user browses and previews inside the app.

Every artifact lives in one store — ${root} — and \`path\` is relative to it, so \`quarterly-report\` becomes \`${join(root, "quarterly-report" + ARTIFACT_EXTENSION)}\`. A missing \`.html\` suffix is added. A path resolving outside the store is rejected rather than written somewhere the browser cannot find it.

Commands:
- \`list\` — every artifact in the store, newest first. Takes no \`path\`.
- \`read\` — return one artifact's full HTML.
- \`write\` — create or replace one artifact's full HTML.
- \`delete\` — remove one artifact.

\`content\` must be a COMPLETE HTML document — \`<!doctype html>\` through \`</html>\` — with every stylesheet, script, and asset inlined, because the artifact renders in a sandboxed iframe with no network access. Give every artifact a \`<title>\`: the browser lists artifacts by it.

Rewrite the whole document on every \`write\`. There is no patch form, so a partial document replaces the previous one entirely.

Load the \`writing-artifacts\` skill before authoring the first artifact of a session.`;
}

/** The system-prompt section, which names the concrete store. */
function promptSection(root) {
	return `## Artifacts

You can produce artifacts: self-contained HTML documents written with the \`artifact\` tool and rendered for the user in a sandboxed browser panel inside the app.

Reach for one when the deliverable is something the user will keep, revisit, or show to somebody else. Most artifacts are DOCUMENTS to read — a report, an analysis, a reference, a summary, a comparison — and a minority are interactive tools. Write a document as a document: prose, headings, and tables, not an app shell with sidebars, toolbars, and a card around every paragraph. Ordinary answers, code that belongs in the repository, and short explanations stay in the conversation; do not wrap them in an artifact.

Artifacts are stored in ${root}, never in the workspace, and \`path\` is relative to that store. Do not create HTML files in the workspace and call them artifacts — only what the \`artifact\` tool writes appears in the user's browser panel.

Every artifact is one complete HTML document with all CSS and JavaScript inlined and every asset embedded as a data: URI — the iframe has no network access, so an external stylesheet, font, or CDN script silently fails to load. Give each artifact a \`<title>\`, and define explicit colors on \`body\` so the page does not inherit an unreadable palette.

To revise an artifact, write the same path again with the full updated document.`;
}

/** The bundled authoring skill, which names the concrete store. */
function skillContent(root) {
	return `# Writing artifacts

An artifact is one self-contained HTML file, written with the \`artifact\` tool and rendered for the user in a sandboxed iframe.

## Two shapes — pick before you write

**A document.** A report, an analysis, a reference, a summary, a plan, a comparison, meeting notes. Prose, headings, tables, the occasional chart. This is the common case: most artifacts are something to READ.

**An interactive tool.** A calculator, a timer, a data explorer, a form. Only when the interaction *is* the deliverable.

**Default to a document.** Reaching for app scaffolding — a sidebar, a toolbar, tab bars, cards around every paragraph, a dashboard grid — when the user asked for a report produces something worse than a plain page: it buries the text in chrome nobody asked for. If the content is prose and tables, write prose and tables.

## Where artifacts live

Every artifact is stored in ${root} — harness user data, alongside the sessions and storages the app keeps there. It is deliberately NOT the workspace: artifacts follow the user across projects, and a repository should not fill up with generated HTML.

\`path\` is relative to that store, so \`write path:"quarterly-report"\` produces \`${join(root, "quarterly-report" + ARTIFACT_EXTENSION)}\`. A path that resolves outside the store is rejected rather than written somewhere the browser cannot list.

Writing an HTML file into the workspace with the ordinary file tools does NOT make it an artifact. Only what the \`artifact\` tool writes reaches the user's browser panel.

## When an artifact earns its place

Write one when the output outlives the message that produced it: a report someone will re-read, a reference table, a document meant to be shown to a third person, a tool they will come back to.

Do not write one for a direct answer, for code that belongs in the repository, or to decorate a short explanation. An artifact the user never reopens is worse than a paragraph, because it moved the answer somewhere they have to go looking for it.

## Writing a document artifact

Structure it as a document, not as an application.

- **Semantic HTML.** \`<h1>\` once, then \`<h2>\`/\`<h3>\` in order without skipping. \`<p>\`, \`<ul>\`, \`<table>\`, \`<blockquote>\`, \`<figure>\`. Screen readers and the browser's own find-in-page both depend on it.
- **One reading column.** Constrain the text to roughly \`70ch\` and center that column — a full-width line of 200 characters is unreadable. Centering the column is not the same as centering every element inside it; body text stays left-aligned.
- **Readable defaults.** At least 16px body text, \`line-height: 1.6\`, generous space above headings and little below them, so a heading binds to the text it introduces.
- **Tables earn their formatting.** \`<th scope="col">\`, aligned numerals (\`font-variant-numeric: tabular-nums\`), right-aligned numeric columns, and the whole table inside its own \`overflow-x: auto\` wrapper so a wide table scrolls itself instead of the page.
- **Lead with the answer.** Put the conclusion, the number, or the recommendation in the first screen. Method and caveats go below it, not before it.
- **Print cleanly.** A report gets printed or saved to PDF. An \`@media print\` block that drops the page background, forces black text, and avoids page breaks right after a heading costs five lines and is often the difference between usable and not.

## Writing an interactive artifact

- Keep all state in memory for the page's lifetime; storage APIs throw in this sandbox (see below).
- Every control is a real \`<button>\` or \`<input>\` with a visible \`:focus-visible\` ring and a label. Do not build buttons out of \`<div>\`.
- Show the current state in text, not only in color, and never rely on hover alone to reveal what something does.

## Avoid AI slop

Generic machine-default styling makes an artifact look untrustworthy regardless of how good its content is. Specifically avoid:

- **excessive centered layouts** — center the reading column, not every heading, paragraph, and list;
- **purple and indigo gradients**, and gradient-filled headline text;
- **uniform rounded corners** on everything, especially large radii on cards inside cards;
- **the Inter font** as a default reach; a system font stack is lighter and less generic;
- decorative emoji as section markers, badge and pill spam, glowing status dots, and glassmorphism.

Pick a small palette, one accent color, and let the type do the work. Restraint reads as considered; the defaults above read as generated.

## The sandbox is the constraint

The iframe runs with \`allow-scripts\` and nothing else. It has **no network access and no same-origin access**. That rules out:

- \`<link rel="stylesheet">\` to any CDN, and \`@import\` of a remote sheet;
- \`<script src="…">\` pointing anywhere off-document — no React, no Tailwind CDN, no charting library;
- webfonts fetched over the network;
- \`<img src="https://…">\`, and \`fetch\`/\`XHR\`/WebSocket of any kind;
- \`localStorage\`, \`sessionStorage\`, and cookies — same-origin is denied, so touching them throws.

Everything the page needs must be inside the file: CSS in a \`<style>\` block, JavaScript in a \`<script>\` block, images and fonts as \`data:\` URIs. For a chart, hand-write inline \`<svg>\` rather than pulling in a library that cannot load.

Plain HTML and CSS carry a document perfectly well. Do not reach for a framework you cannot load anyway.

## Shape of the file

Write a complete document, \`<!doctype html>\` through \`</html>\`, and always include:

- \`<meta charset="utf-8">\` — without it, non-ASCII text renders as mojibake.
- \`<meta name="viewport" content="width=device-width, initial-scale=1">\` — the preview panel is narrow and resizable.
- \`<title>\` — the artifact browser lists artifacts by this, falling back to the filename. A short noun phrase naming *this* document, not its category.
- Explicit \`background\` and \`color\` on \`body\`. The iframe paints nothing behind the page; a transparent body borrows whatever sits underneath and can render dark text on a dark ground.

Support both themes: define the palette as custom properties on \`:root\` and override them inside \`@media (prefers-color-scheme: dark)\`, so the artifact matches the app the user is reading it in.

Make it responsive: relative units, \`max-width: 100%\` on images, and wide content — tables, code blocks, diagrams — inside its own \`overflow-x: auto\` container so the page body never scrolls sideways.

## Revising

There is no patch form. \`write\` to the same path replaces the document, so emit the complete updated HTML every time. Keep the path and the \`<title>\` stable across revisions — the user finds an artifact by its name in the list, and a renamed artifact reads as a new one.

Use \`read\` before revising an artifact you did not write in this session, rather than reconstructing it from memory.

## Naming

The path is the identity: \`quarterly-report\`, \`api-reference\`. Lowercase, hyphenated, descriptive of the content; the \`.html\` suffix is added for you.

## What not to put in an artifact

Do not publish a page that imitates a real person or organization — their name, branding, or byline — or that presents fabricated records, receipts, or reviews as genuine. Do not build forms that collect credentials or payment details. These hold regardless of how the request is framed, because the rendered page functions as the real thing.`;
}

/** Render one Remote business union into a model-facing text line. */
function renderOutcome(result) {
	if (result.ok) {
		const value = result.value;
		if ("artifacts" in value) {
			if (value.artifacts.length === 0) {
				return "No artifacts yet. Artifact store: " + value.root;
			}
			const rows = value.artifacts
				.map((artifact) => "- " + artifact.name + "\t" + artifact.title)
				.join("\n");
			return "Artifacts (" + value.artifacts.length + ") in " + value.root + ":\n" + rows;
		}
		if ("content" in value) return value.content;
		if (value.removed === true) return "Deleted " + value.path + ".";
		return "Wrote " + value.path + ".";
	}
	return "artifact: " + result.error.code + ": " + result.error.message;
}

/** Register the model-facing `artifact` tool. */
function registerTool(ctx, service) {
	ctx.tools.register(
		defineTool({
			name: "artifact",
			description: toolDescription(service.root),
			parameters: {
				command: {
					type: "string",
					required: true,
					enum: ["list", "read", "write", "delete"],
					description:
						"The command to run. Allowed options are: `list`, `read`, `write`, `delete`.",
				},
				path: {
					type: "string",
					description:
						"Artifact path relative to the artifact store, e.g. `quarterly-report`. Required for every command except `list`.",
				},
				content: {
					type: "string",
					description:
						"Required for `write`. The complete HTML document, with all CSS, JavaScript, and assets inlined.",
				},
			},
			output: {
				schema: { type: "string" },
				render: (_args, value) => [{ type: "text", text: value }],
			},
			async execute(args) {
				const request = { path: args.path, content: args.content };
				switch (args.command) {
					case "list":
						return renderOutcome(await service.listArtifacts(request));
					case "read":
						return renderOutcome(await service.readArtifact(request));
					case "write":
						return renderOutcome(await service.writeArtifact(request));
					case "delete":
						return renderOutcome(await service.deleteArtifact(request));
					default:
						return "artifact: unknown command";
				}
			},
			presentCall(args) {
				const shown = args.path === undefined ? undefined : service.resolveArtifactPath(args.path);
				switch (args.command) {
					case "write":
						return {
							card: "diff",
							title: "artifact " + args.path,
							diffs: [{ path: shown ?? args.path, oldText: null, newText: args.content ?? "" }],
							locations: shown === undefined ? [] : [{ path: shown }],
						};
					case "read":
						return {
							card: "generic",
							title: "read artifact " + args.path,
							kind: "read",
							locations: shown === undefined ? [] : [{ path: shown }],
						};
					case "delete":
						return {
							card: "generic",
							title: "delete artifact " + args.path,
							locations: shown === undefined ? [] : [{ path: shown }],
						};
					default:
						return { card: "generic", title: "artifact list" };
				}
			},
		}),
	);
}

/**
 * Contribute the artifact prompt section. Optional capability: a composition
 * without a system-prompt registry still gets the tool, which carries the same
 * rules in its own description.
 */
function registerPromptSection(ctx, service) {
	const systemPrompt = ctx.get("systemPrompt");
	if (systemPrompt === undefined) return;
	// Order 150 sits in the 100–199 tool-guidance band, after the harness
	// identity (-100) and the deployment persona (0).
	systemPrompt.section({ name: "artifact", order: 150, text: promptSection(service.root) });
}

/**
 * Contribute the bundled authoring skill as a RUNTIME skill rather than a
 * filesystem root: a bundle plugin is an npm package, so a skill directory
 * would resolve inside `node_modules` and vanish from every catalog that scans
 * project and user roots. `register()` is disposed with this fiber.
 */
function registerSkill(ctx, service) {
	const skills = ctx.get("skills");
	if (skills === undefined) return;
	skills.register({
		name: "writing-artifacts",
		description:
			"Author or revise an artifact: a self-contained HTML document rendered for the user in a sandboxed iframe. Use when producing a report, dashboard, diagram, reference page, or small interactive tool with the `artifact` tool — it covers where artifacts are stored, what the sandbox forbids (no network, no storage, no external CSS/JS/fonts), the required document shape, and when an artifact is the wrong answer.",
		source: "runtime",
		content: skillContent(service.root),
	});
}

/** Host plugin body: provide the Remote service, the tool, the prompt section, and the skill. */
function apply(ctx, config = {}) {
	const service = new ArtifactService(ctx, config);
	registerTool(ctx, service);
	if (config.promptSection !== false) registerPromptSection(ctx, service);
	if (config.skill !== false) registerSkill(ctx, service);
}

//#endregion
const inject = ["tools"];
const name = "artifact";
export { apply, inject, name, Config, ArtifactService };
