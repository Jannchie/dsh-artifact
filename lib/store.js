import { mkdir, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * The artifact store: every filesystem operation this plugin performs.
 *
 * Deliberately free of harness imports. The store is what the plugin DOES; the
 * Remote service and the tool in `index.js` are how it plugs into dsh. Keeping
 * the two apart means this half can be exercised against a real directory
 * without a running harness — which matters because the harness packages this
 * plugin declares as peers are not all installable from npm.
 *
 * WHY node:fs AND NOT ctx.fs — the store is harness user data under
 * `$DSH_HOME`, a sibling of `sessions/` and `storages/`, not workspace content.
 * Three facts make the filesystem service the wrong tool: it exposes no delete
 * and no mkdir at all, so half of these operations have no counterpart there;
 * and its sandbox exists to confine writes to the session workspace, which the
 * store sits outside of, so every artifact write under the default
 * `workspace-write` policy would be denied until the user approved an
 * escalation. Confinement is enforced by `resolvePath` instead.
 */

export const ARTIFACT_EXTENSION = ".html";
/** Bytes scanned from the head of each artifact when listing, to find its title. */
export const TITLE_SCAN_BYTES = 8192;
export const DEFAULT_MAX_ARTIFACT_CHARS = 400_000;

/** Frozen business-failure branch shared with the client Remote union. */
export function rejected(code, message, details = {}) {
	return Object.freeze({ ok: false, error: Object.freeze({ code, message, ...details }) });
}
/** Frozen business-success branch shared with the client Remote union. */
export function success(value) {
	return Object.freeze({ ok: true, value });
}

/**
 * Pull a display title out of artifact markup: `<title>` first, then the first
 * heading, then nothing. Cheap string scanning on purpose — listing artifacts
 * must not pay for an HTML parser, and a missing title degrades to the filename
 * rather than to an error.
 * @param html - artifact markup, or its head when listing.
 * @returns the trimmed title, or undefined when the markup carries none.
 */
export function extractTitle(html) {
	if (typeof html !== "string") return undefined;
	const head = html.slice(0, TITLE_SCAN_BYTES);
	const match =
		/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head) ?? /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(head);
	if (match === null) return undefined;
	const text = match[1].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
	return text.length === 0 ? undefined : text.slice(0, 200);
}

/** Every artifact operation, against one directory. */
export class ArtifactStore {
	/**
	 * @param root - absolute directory owning the artifacts.
	 * @param maxArtifactChars - largest write accepted.
	 */
	constructor(root, maxArtifactChars = DEFAULT_MAX_ARTIFACT_CHARS) {
		this.root = resolve(root);
		this.maxArtifactChars =
			Number.isSafeInteger(maxArtifactChars) && maxArtifactChars > 0
				? maxArtifactChars
				: DEFAULT_MAX_ARTIFACT_CHARS;
	}

	/**
	 * Resolve a caller-supplied path to an absolute one inside the store, or
	 * undefined when it escapes.
	 *
	 * Confinement is a property of this resolver rather than a check bolted on
	 * afterwards: `..` segments, a sibling-directory prefix, and an absolute
	 * path pointing anywhere else all fail the same way, and an artifact that
	 * cannot be located again is exactly the failure this prevents.
	 * @param path - artifact path, absolute or relative to the store.
	 * @returns the absolute path, or undefined when it lands outside the store.
	 */
	resolvePath(path) {
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

	/** Validate a path and reject uniformly; returns the absolute path or a failure. */
	target(path) {
		if (typeof path !== "string" || path.trim().length === 0) {
			return { error: rejected("invalid-path", "path must be a non-empty string") };
		}
		const absolute = this.resolvePath(path);
		if (absolute === undefined) {
			return { error: rejected("outside-store", "path must stay inside the artifact store " + this.root) };
		}
		return { absolute };
	}

	/**
	 * Every artifact in the store, newest first.
	 *
	 * A store that does not exist yet is empty state, not a failure: it is
	 * created by the first write, and a fresh install must show an empty browser
	 * rather than an error.
	 */
	async list() {
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

	/** One artifact's full HTML. */
	async read(path) {
		const { absolute, error } = this.target(path);
		if (error !== undefined) return error;
		try {
			const content = await readFile(absolute, "utf8");
			return success({ path: absolute, content, title: extractTitle(content) });
		} catch (failure) {
			if (failure?.code === "ENOENT") return rejected("not-found", "no artifact at " + absolute);
			return rejected("read-failed", failure instanceof Error ? failure.message : String(failure));
		}
	}

	/** Create or replace one artifact. */
	async write(path, content) {
		if (typeof content !== "string") return rejected("invalid-content", "content must be a string");
		if (content.length > this.maxArtifactChars) {
			return rejected("too-large", "artifact exceeds " + this.maxArtifactChars + " characters", {
				maxChars: this.maxArtifactChars,
				actualChars: content.length,
			});
		}
		const { absolute, error } = this.target(path);
		if (error !== undefined) return error;
		try {
			// Nothing else creates the store: no install step writes it, and the
			// filesystem service has no mkdir. Without this the very first
			// artifact of a fresh install fails to write and never appears.
			await mkdir(dirname(absolute), { recursive: true });
			await writeFile(absolute, content, "utf8");
			return success({ path: absolute, title: extractTitle(content) });
		} catch (failure) {
			return rejected("write-failed", failure instanceof Error ? failure.message : String(failure));
		}
	}

	/** Delete one artifact. */
	async delete(path) {
		const { absolute, error } = this.target(path);
		if (error !== undefined) return error;
		try {
			const info = await stat(absolute);
			if (!info.isFile()) return rejected("not-found", "no artifact at " + absolute);
			await rm(absolute);
			return success({ path: absolute, removed: true });
		} catch (failure) {
			if (failure?.code === "ENOENT") return rejected("not-found", "no artifact at " + absolute);
			return rejected("delete-failed", failure instanceof Error ? failure.message : String(failure));
		}
	}
}
