import { join } from "node:path";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { ARTIFACT_EXTENSION, ArtifactStore, DEFAULT_MAX_ARTIFACT_CHARS } from "./store.js";

//#region dsh-artifact (host half)
/**
 * Artifact bundle, host half: the harness wiring around `ArtifactStore`.
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
 * Every filesystem operation lives in `./store.js`, which imports nothing from
 * the harness and is therefore testable on its own.
 */

const DEFAULT_ARTIFACT_DIRNAME = "artifacts";

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
	/**
	 * Color overrides handed to previewed artifacts, on top of the app's own
	 * live theme. Keys are custom properties; a key without a leading `--` is
	 * read as an alias token, so `state-business-primary` and
	 * `--dsw-alias-state-business-primary` mean the same thing.
	 */
	palette: z.dict(z.string()),
});

/** Normalize a palette key to the custom property an artifact would reference. */
function paletteProperty(key) {
	return key.startsWith("--") ? key : "--dsw-alias-" + key;
}

/**
 * The `artifact` Remote service: a thin harness face over one `ArtifactStore`.
 *
 * Every wire method carries the `Artifact` suffix. The client gateway builds
 * one `RemoteNamespaceService` per namespace and rejects any method name that
 * collides with that class — `ctx`, `empty`, `invokeRemote`, `methods`, `name`,
 * `namespace`, `assertMethodAvailable`, `has`, `install`, `installDirect`,
 * `installScoped`, `remove`. A bare verb like `list` or `remove` is one gateway
 * release away from that list; a suffixed name cannot land on it.
 */
class ArtifactService extends TypertRemoteService {
	static Config = Config;

	constructor(ctx, config = {}) {
		super(ctx, "artifact");
		this.store = new ArtifactStore(
			config.root ?? dshHomePath(DEFAULT_ARTIFACT_DIRNAME),
			config.maxArtifactChars,
		);
		const palette = {};
		for (const [key, value] of Object.entries(config.palette ?? {})) {
			if (typeof value === "string" && value.trim() !== "") palette[paletteProperty(key)] = value;
		}
		this.palette = Object.freeze(palette);
	}

	/** The absolute artifact directory, named by the tool, prompt, and skill. */
	get root() {
		return this.store.root;
	}

	/** Resolve a path for presentation; undefined when it escapes the store. */
	resolveArtifactPath(path) {
		return this.store.resolvePath(path);
	}

	/** @Remote listArtifacts — every artifact in the store, newest first. */
	async listArtifacts(request) {
		void request;
		const result = await this.store.list();
		if (!result.ok) return result;
		return Object.freeze({
			ok: true,
			value: Object.freeze({ ...result.value, palette: this.palette }),
		});
	}

	/** @Remote readArtifact — read one artifact's full HTML. */
	async readArtifact(request) {
		return await this.store.read(request?.path);
	}

	/** @Remote writeArtifact — create or replace one artifact's full HTML. */
	async writeArtifact(request) {
		return await this.store.write(request?.path, request?.content);
	}

	/** @Remote deleteArtifact — delete one artifact. */
	async deleteArtifact(request) {
		return await this.store.delete(request?.path);
	}
}
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
- \`:root { color-scheme: light dark }\`. Scrollbars, form controls, and the canvas behind the page are painted by the browser, not by your CSS, and it paints them **light** until the document opts in — so a dark artifact otherwise scrolls with a bright scrollbar down its side.
- Explicit \`background\` and \`color\` on \`body\`. The iframe paints nothing behind the page; a transparent body borrows whatever sits underneath and can render dark text on a dark ground.

## Colors: ask the app first

Prefer the app's palette over colors you invent. The browser panel injects these tokens into every artifact, so \`var(--dsw-alias-label-primary, …)\` resolves to whatever the user's theme — including a theme a plugin overrode — is actually using:

| Token | Use |
|---|---|
| \`--dsw-alias-bg-base\` | page background |
| \`--dsw-alias-bg-layer-1\` / \`-2\` | raised surfaces, table stripes |
| \`--dsw-alias-label-primary\` | body text |
| \`--dsw-alias-label-secondary\` | de-emphasized text |
| \`--dsw-alias-label-tertiary\` | captions, metadata |
| \`--dsw-alias-border-l1\` / \`-l2\` | hairlines, table rules |
| \`--dsw-alias-state-business-primary\` | the one accent |
| \`--dsw-alias-state-error-primary\` | errors, negative numbers |
| \`--dsw-alias-markdown-code-block\` | code block background |

**Always write a fallback**, because an artifact is also a file someone opens directly in a browser where no token exists: \`var(--dsw-alias-bg-base, #fff)\`. Define the pair once as your own custom properties, then use those everywhere.

Support both themes by overriding **the fallbacks** inside \`@media (prefers-color-scheme: dark)\` — inside the panel the tokens already won, so the override only matters standalone. Keep it and \`color-scheme\` in agreement: together they are what make the page and the browser's own chrome darken as one.

Make it responsive: relative units, \`max-width: 100%\` on images, and wide content — tables, code blocks, diagrams — inside its own \`overflow-x: auto\` container so the page body never scrolls sideways.

The skeleton every artifact starts from:

\`\`\`html
<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Q3 收入分析</title>
<style>
  /* Each color asks the app for its token and falls back to dsh's default,
     so the artifact follows the user's theme in the browser panel and still
     looks right when the file is opened on its own. */
  :root {
    color-scheme: light dark;
    --bg:    var(--dsw-alias-bg-base, #fff);
    --fg:    var(--dsw-alias-label-primary, rgb(15, 17, 21));
    --muted: var(--dsw-alias-label-tertiary, rgb(173, 178, 184));
    --rule:  var(--dsw-alias-border-l2, rgba(0, 0, 0, .1));
    --accent:var(--dsw-alias-state-business-primary, rgb(65, 118, 230));
  }
  @media (prefers-color-scheme: dark) {
    /* Only the fallbacks change: in the panel the tokens already won. */
    :root {
      --bg:    var(--dsw-alias-bg-base, rgb(21, 21, 23));
      --fg:    var(--dsw-alias-label-primary, rgb(249, 250, 251));
      --muted: var(--dsw-alias-label-tertiary, rgb(129, 133, 140));
      --rule:  var(--dsw-alias-border-l2, rgba(255, 255, 255, .12));
      --accent:var(--dsw-alias-state-business-primary, rgb(103, 158, 254));
    }
  }
  body {
    background: var(--bg); color: var(--fg);
    font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
    max-width: 70ch; margin: 0 auto; padding: 40px 20px;
  }
  h1, h2 { line-height: 1.25; margin: 2em 0 .5em; }
  h1 { margin-top: 0; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border-bottom: 1px solid var(--rule); padding: 8px 12px; text-align: left; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  @media print { body { max-width: none; padding: 0; } h1, h2 { break-after: avoid; } }
</style>
</head>
<body>
  <h1>Q3 收入分析</h1>
  <p>结论先写在这里。</p>
  <div class="scroll"><table>…</table></div>
</body>
</html>
\`\`\`

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
async function apply(ctx, config = {}) {
	await ctx.plugin(ArtifactService, config);
	const service = ctx.get("artifact");
	if (service === undefined) {
		throw new Error("dsh-artifact: ArtifactService failed to register");
	}
	registerTool(ctx, service);
	if (config.promptSection !== false) registerPromptSection(ctx, service);
	if (config.skill !== false) registerSkill(ctx, service);
}

//#endregion
const inject = ["tools"];
const name = "artifact";
export { apply, inject, name, Config, ArtifactService };
