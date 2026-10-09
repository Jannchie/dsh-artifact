import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { describeDeckDiagnostics, readDeck } from "./deck.js";
import { ArtifactStore, DEFAULT_MAX_ARTIFACT_CHARS, DEFAULT_MAX_VERSIONS, rejected } from "./store.js";
// Every word this plugin says to a model lives in `./text.js` — the tool
// description, the prompt section, the bundled skill, and the text each command
// replies with. Nothing here spells model-facing prose, which is what keeps that
// prose reviewable in a diff and testable without a running harness.
import { promptSection, renderOutcome, skillContent, toolDescription } from "./text.js";

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
 * Every filesystem operation lives in `./store.js`, and every model-facing
 * string in `./text.js`. Neither imports the harness, so each is testable on its
 * own — which is the point: the strings are the plugin's contract with a model,
 * and `./text.js` is what makes that contract reviewable in a diff.
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
	/**
	 * Superseded revisions kept per artifact, oldest dropped first. Zero turns
	 * history off: writes stop keeping what they replace, and the browser shows
	 * no history controls at all.
	 */
	maxVersionsPerArtifact: z.number().default(DEFAULT_MAX_VERSIONS),
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
			config.maxVersionsPerArtifact,
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

	/**
	 * @Remote listArtifacts — every artifact in the store, newest first; with a
	 * `sessionId`, only those that session wrote (the conversation's own tab).
	 */
	async listArtifacts(request) {
		const result = await this.store.list(request?.sessionId);
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

	/**
	 * @Remote writeArtifact — create or replace one artifact's full HTML. The
	 * tool passes the writing session's id so the artifact shows up in that
	 * conversation's tab; the browser passes none when the reader saves a deck.
	 *
	 * A deck is read as a deck before it is kept. One with no slide at all is
	 * refused — there is nothing to show — and anything the slide subset
	 * dropped is reported back beside the success, by slide and line, because
	 * the writer cannot see the page to find out.
	 */
	async writeArtifact(request) {
		const path = request?.path;
		const content = request?.content;
		const kind = request?.kind ?? (await this.kindOf(path));
		let dropped;
		if (kind === "slides" && typeof content === "string") {
			const read = readDeck(content);
			if (read.deck.slides.length === 0) {
				return rejected("empty-deck", "a deck needs at least one slide: a <section> in its <body>");
			}
			dropped = describeDeckDiagnostics(read.diagnostics);
		}
		const result = await this.store.write(path, content, request?.sessionId, request?.kind, {
			keepVersion: request?.keepVersion !== false,
		});
		if (!result.ok || dropped === undefined || dropped.length === 0) return result;
		return Object.freeze({ ok: true, value: Object.freeze({ ...result.value, dropped }) });
	}

	/** What an artifact already is, for a write that does not say; nothing there yet is a page. */
	async kindOf(path) {
		const absolute = typeof path === "string" ? this.store.resolvePath(path) : undefined;
		return absolute === undefined ? "html" : await this.store.kindOf(absolute);
	}

	/**
	 * @Remote uploadArtifactAsset — keep a picture or font the reader put in a
	 * deck, and answer with the `assets/<file>` name the deck gives it.
	 */
	async uploadArtifactAsset(request) {
		return await this.store.writeAsset(request?.path, request?.type, request?.base64);
	}

	/** @Remote readArtifactAsset — one of a deck's files, by the name the deck gives it. */
	async readArtifactAsset(request) {
		return await this.store.readAsset(request?.path, request?.src);
	}

	/** @Remote deleteArtifact — delete one artifact. */
	async deleteArtifact(request) {
		return await this.store.delete(request?.path);
	}

	/**
	 * @Remote listArtifactVersions — every kept revision of one artifact.
	 *
	 * History is reachable from the browser and not from the tool. The model
	 * has no use for it: it wrote the thing and knows what it wrote. Someone
	 * looking at the document a day later is the one who needs to ask what
	 * changed, so the surface that answers is the one they are looking at.
	 */
	async listArtifactVersions(request) {
		return await this.store.listVersions(request?.path);
	}

	/** @Remote readArtifactVersion — one kept revision's full HTML. */
	async readArtifactVersion(request) {
		return await this.store.readVersion(request?.path, request?.id);
	}

	/** @Remote restoreArtifactVersion — make a kept revision current again. */
	async restoreArtifactVersion(request) {
		return await this.store.restoreVersion(request?.path, request?.id);
	}
}
markRemote(ArtifactService, "listArtifacts");
markRemote(ArtifactService, "readArtifact");
markRemote(ArtifactService, "writeArtifact");
markRemote(ArtifactService, "deleteArtifact");
markRemote(ArtifactService, "listArtifactVersions");
markRemote(ArtifactService, "readArtifactVersion");
markRemote(ArtifactService, "restoreArtifactVersion");
markRemote(ArtifactService, "uploadArtifactAsset");
markRemote(ArtifactService, "readArtifactAsset");

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
						"Required for `write`. For a page, the complete HTML document with all CSS, JavaScript, and assets inlined; for a deck, the deck in the slide subset.",
				},
				kind: {
					type: "string",
					enum: ["html", "slides"],
					description:
						"For `write`: `html` for a page, `slides` for a presentation the user can edit, present, and export. Left out, a new artifact is a page and a rewrite keeps what the artifact was.",
				},
			},
			output: {
				schema: { type: "string" },
				render: (_args, value) => [{ type: "text", text: value }],
			},
			async execute(args, exec) {
				// `exec.agent` is the calling session (DSH 0.1.7); older hosts pass
				// none, and their artifacts simply stay out of every session tab.
				const request = {
					path: args.path,
					content: args.content,
					kind: args.kind,
					sessionId: exec?.agent?.id,
				};
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
// The four text builders are re-exported for `scripts/test.mjs`: the test asserts
// on what they say, and `./text.js` is where their definitions live.
export { apply, inject, name, Config, ArtifactService, promptSection, renderOutcome, skillContent, toolDescription };
