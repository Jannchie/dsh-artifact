import { mkdir, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
/**
 * Directory holding per-artifact snapshots.
 *
 * Dotted and nested one level down, which is what keeps it invisible for free:
 * `list()` admits only files directly inside the root, so history costs the
 * artifact list nothing and needs no filter of its own.
 */
export const VERSIONS_DIR = ".versions";
export const DEFAULT_MAX_VERSIONS = 20;
/**
 * Directory recording which sessions wrote each artifact: one small JSON array
 * per artifact, named like its versions directory.
 *
 * Per artifact rather than one index, for the reason history has no manifest:
 * a file deleted or copied by hand takes its own record with it instead of
 * leaving a shared index out of step. Dotted, so `list()` never sees it.
 */
export const SESSIONS_DIR = ".sessions";
/** A snapshot filename is the millisecond timestamp of the content it holds. */
const VERSION_ID = /^\d+$/;

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
	 * @param maxVersions - snapshots kept per artifact before the oldest go.
	 */
	constructor(root, maxArtifactChars = DEFAULT_MAX_ARTIFACT_CHARS, maxVersions = DEFAULT_MAX_VERSIONS) {
		this.root = resolve(root);
		this.maxArtifactChars =
			Number.isSafeInteger(maxArtifactChars) && maxArtifactChars > 0
				? maxArtifactChars
				: DEFAULT_MAX_ARTIFACT_CHARS;
		this.maxVersions =
			Number.isSafeInteger(maxVersions) && maxVersions >= 0 ? maxVersions : DEFAULT_MAX_VERSIONS;
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
		// The store is a flat shelf, not a filesystem. A nested path used to
		// write a file `list()` never walks into: the write reported success
		// while the artifact never appeared in the browser and could not be
		// found again. Refusing nesting here also reserves `.versions/` for
		// snapshots rather than leaving it reachable as an artifact name.
		if (within.includes(sep) || within.includes("/")) return undefined;
		// Nothing dotted is an artifact. `list()` shows every `.html` file in
		// the root, so without this a `.versions` artifact would sit in the
		// browser beside real ones, and each dotted directory added later would
		// need its own guard. One rule keeps the resolver and the listing
		// agreeing about what an artifact is.
		if (within.startsWith(".")) return undefined;
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
			return { error: rejected("outside-store", "path must name one artifact directly inside " + this.root) };
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
	async list(sessionId) {
		try {
			let entries;
			try {
				entries = await readdir(this.root, { withFileTypes: true });
			} catch (error) {
				if (error?.code === "ENOENT") return success({ artifacts: [], root: this.root });
				throw error;
			}
			const artifacts = [];
			const scoped = typeof sessionId === "string" && sessionId.length > 0;
			for (const entry of entries) {
				if (!entry.isFile() || !entry.name.endsWith(ARTIFACT_EXTENSION)) continue;
				const path = join(this.root, entry.name);
				// Scoped to a session, an artifact counts when that session wrote
				// it at least once — including one written before and rewritten
				// here, which is the document the conversation is about.
				if (scoped && !(await this.sessionsOf(path)).includes(sessionId)) continue;
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
	async write(path, content, sessionId) {
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
			await this.snapshot(absolute, content);
			await writeFile(absolute, content, "utf8");
			if (typeof sessionId === "string" && sessionId.length > 0) await this.recordSession(absolute, sessionId);
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
			// History outlives nothing: a snapshot directory left behind would be
			// adopted by the next artifact written under the same name.
			await rm(this.versionsDir(absolute), { recursive: true, force: true });
			await rm(this.sessionsFile(absolute), { force: true });
			return success({ path: absolute, removed: true });
		} catch (failure) {
			if (failure?.code === "ENOENT") return rejected("not-found", "no artifact at " + absolute);
			return rejected("delete-failed", failure instanceof Error ? failure.message : String(failure));
		}
	}

	/**
	 * Where the snapshots of one artifact live: a directory per artifact, named
	 * by its basename.
	 *
	 * No manifest rides alongside them. The filename IS the timestamp, so there
	 * is no second source of truth to fall out of step with the files on disk,
	 * and a history directory someone deleted by hand degrades to empty history
	 * rather than to a corrupt index.
	 */
	versionsDir(absolute) {
		return join(this.root, VERSIONS_DIR, basename(absolute, ARTIFACT_EXTENSION));
	}

	/** Where the record of which sessions wrote one artifact lives. */
	sessionsFile(absolute) {
		return join(this.root, SESSIONS_DIR, basename(absolute, ARTIFACT_EXTENSION) + ".json");
	}

	/**
	 * The sessions that wrote one artifact. A missing or unreadable record is
	 * no sessions: artifacts written before sessions were recorded belong to
	 * the library only, not to whichever conversation happens to be open.
	 */
	async sessionsOf(absolute) {
		try {
			const value = JSON.parse(await readFile(this.sessionsFile(absolute), "utf8"));
			return Array.isArray(value) ? value.filter((id) => typeof id === "string") : [];
		} catch (_) {
			return [];
		}
	}

	/** Add one session to an artifact's record; a failure only costs the scoping. */
	async recordSession(absolute, sessionId) {
		try {
			const sessions = await this.sessionsOf(absolute);
			if (sessions.includes(sessionId)) return;
			const file = this.sessionsFile(absolute);
			await mkdir(dirname(file), { recursive: true });
			await writeFile(file, JSON.stringify([...sessions, sessionId]), "utf8");
		} catch (_) {
			/* the artifact is written; it just will not show under this session */
		}
	}

	/**
	 * Keep the content about to be overwritten, unless there is nothing worth
	 * keeping.
	 *
	 * Two decisions worth stating. The snapshot is stamped with the OLD file's
	 * mtime rather than the current clock, so a version is named by when its
	 * content was WRITTEN and not by when it was replaced — the first is what
	 * someone reading a history wants, the second is an artefact of how we
	 * store it. And a rewrite that changed nothing produces no version at all:
	 * agents re-issue byte-identical writes often, and a history of duplicates
	 * is a history nobody scrolls.
	 * @param absolute - the artifact about to be replaced.
	 * @param next - the content replacing it.
	 */
	async snapshot(absolute, next) {
		if (this.maxVersions === 0) return;
		let previous;
		let written;
		try {
			previous = await readFile(absolute, "utf8");
			written = (await stat(absolute)).mtimeMs;
		} catch {
			// A first write has no previous content. Anything else that cannot
			// be read cannot be preserved either, and losing the snapshot must
			// not lose the write.
			return;
		}
		if (previous === next) return;
		const dir = this.versionsDir(absolute);
		await mkdir(dir, { recursive: true });
		// `wx` settles the one collision that matters: two writes inside the
		// same millisecond would otherwise have the second silently overwrite
		// the first snapshot. Walking the stamp forward keeps both, in order.
		for (let stamp = Math.round(written); ; stamp++) {
			try {
				const name = stamp + ARTIFACT_EXTENSION;
				await writeFile(join(dir, name), previous, { encoding: "utf8", flag: "wx" });
				break;
			} catch (error) {
				if (error?.code !== "EEXIST") throw error;
			}
		}
		await this.prune(dir);
	}

	/**
	 * Drop the oldest snapshots past the retention limit.
	 *
	 * Sorted numerically rather than by name: lexical order happens to agree
	 * with millisecond timestamps today only because they are all the same
	 * length, which is not a property to depend on.
	 */
	async prune(dir) {
		const stamps = (await readdir(dir))
			.filter((name) => name.endsWith(ARTIFACT_EXTENSION))
			.map((name) => Number(name.slice(0, -ARTIFACT_EXTENSION.length)))
			.filter((stamp) => Number.isFinite(stamp))
			.sort((a, b) => a - b);
		const excess = stamps.length - this.maxVersions;
		for (let i = 0; i < excess; i++) {
			await rm(join(dir, stamps[i] + ARTIFACT_EXTENSION), { force: true });
		}
	}

	/**
	 * Every kept version of one artifact, newest first.
	 *
	 * Sizes are bytes off `stat`, not characters: the number exists to show how
	 * much a revision added or removed, and reading every snapshot in full to
	 * count characters would be the worse trade at any store size.
	 */
	async listVersions(path) {
		const { absolute, error } = this.target(path);
		if (error !== undefined) return error;
		const dir = this.versionsDir(absolute);
		try {
			let entries;
			try {
				entries = await readdir(dir, { withFileTypes: true });
			} catch (failure) {
				// No directory is an artifact written exactly once: empty
				// history, which the browser must render as no history at all
				// rather than as an error.
				if (failure?.code === "ENOENT") return success({ path: absolute, versions: [] });
				throw failure;
			}
			const versions = [];
			for (const entry of entries) {
				if (!entry.isFile() || !entry.name.endsWith(ARTIFACT_EXTENSION)) continue;
				const id = entry.name.slice(0, -ARTIFACT_EXTENSION.length);
				if (!VERSION_ID.test(id)) continue;
				const file = join(dir, entry.name);
				let title;
				let bytes = 0;
				try {
					title = extractTitle(await this.readHead(file));
					bytes = (await stat(file)).size;
				} catch (_) {
					/* an unreadable snapshot still belongs in the history */
				}
				versions.push({ id, written: Number(id), bytes, title });
			}
			versions.sort((a, b) => b.written - a.written);
			return success({ path: absolute, versions });
		} catch (failure) {
			return rejected(
				"list-versions-failed",
				failure instanceof Error ? failure.message : String(failure),
			);
		}
	}

	/** One kept version's full HTML. */
	async readVersion(path, id) {
		const { absolute, error } = this.target(path);
		if (error !== undefined) return error;
		// Digits only. The id names a file inside the history directory, so
		// every other shape is a way out of it.
		if (typeof id !== "string" || !VERSION_ID.test(id)) {
			return rejected("invalid-version", "version id must be a timestamp");
		}
		const file = join(this.versionsDir(absolute), id + ARTIFACT_EXTENSION);
		try {
			const content = await readFile(file, "utf8");
			return success({ path: absolute, id, content, title: extractTitle(content) });
		} catch (failure) {
			if (failure?.code === "ENOENT") {
				return rejected("not-found", "no version " + id + " of " + absolute);
			}
			return rejected("read-failed", failure instanceof Error ? failure.message : String(failure));
		}
	}

	/**
	 * Put a kept version back as the artifact's current content.
	 *
	 * Restoring goes through `write`, so the content being displaced is
	 * snapshotted on the way out like any other overwrite: a restore is itself
	 * undone by restoring, and no path through this class loses content.
	 */
	async restoreVersion(path, id) {
		const version = await this.readVersion(path, id);
		if (!version.ok) return version;
		const result = await this.write(path, version.value.content);
		if (!result.ok) return result;
		return success({ ...result.value, restored: id });
	}
}
