window.__ModuleLoader__.load({
	id: "dsh-artifact",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");
		// The app's own component library, for its `ic_ds_*` icon set rather than
		// hand-drawn SVG paths. Its `Button` is deliberately unused: that is a
		// text button whose `toolbar` variant paints a visible fill, while every
		// icon control in this app is a bare circle until hover.
		//
		// NOT listed in package.json's `dsh.client.inject`: that field names
		// loader ENTRIES, and this package is not one — the frontend exposes it
		// through the module loader's shared registry, so requiring it works
		// while injecting it would wait forever for an entry that never arrives.
		var primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		//#region client half
		/**
		 * dsh-artifact, browser half: an artifact browser registered as a
		 * conversation view.
		 *
		 * Mounts a hand-written `src-json` Typert Remote contribution for the
		 * host `artifact` service, then registers one entry into
		 * `conversation.view` — the shell's tabbed view slot, which turns every
		 * registration into a tab beside the shipped chat and trajectory views
		 * and hands it the whole conversation area while selected.
		 *
		 * A tab rather than an overlay because artifacts are mostly documents to
		 * READ. A modal's affordance is "transient, dismiss me", which fights a
		 * report someone scrolls through; a view persists, and the shell already
		 * owns its tab bar, selection state, and label translation.
		 *
		 * Inside the tab it is a LIST page that opens a DETAIL page, not a
		 * master-detail split: a split spends a permanent column on navigation
		 * the reader is done with, while a document wants the full width.
		 */

		const NS = "artifact";

		/** A strict-typed codec that passes values through without re-validation. */
		function passthroughCodec(typeSymbol) {
			return { mode: "strict", typeSymbol, schema: { parse: (value) => value } };
		}

		/** One direct request/response descriptor on the `artifact` namespace. */
		function descriptor(method) {
			return {
				id: "dsh-artifact#artifact/" + method,
				service: "artifact",
				namespace: "artifact",
				method: method,
				invocation: { kind: "direct" },
				parameters: [
					{ name: "request", wire: "request", source: "json", codec: passthroughCodec("object") },
				],
				result: passthroughCodec("object"),
			};
		}

		/**
		 * Hand-written Remote contribution. The Client gateway requires strict
		 * codecs (it rejects `src-json`), so each parameter and result carries a
		 * pass-through strict schema; the Host serves these endpoints through its
		 * source-launch (`remoteMethods`) fallback.
		 *
		 * Every method carries the `Artifact` suffix. The gateway builds one
		 * `RemoteNamespaceService` per namespace and rejects any method name
		 * colliding with that class — it owns `remove`, `has`, `install`,
		 * `name`, `empty` among others — so a bare verb is one gateway release
		 * away from breaking, while a suffixed name cannot land on that list.
		 */
		const ARTIFACT_REMOTE = {
			package: "dsh-artifact",
			descriptors: [
				descriptor("listArtifacts"),
				descriptor("readArtifact"),
				descriptor("writeArtifact"),
				descriptor("deleteArtifact"),
				descriptor("listArtifactVersions"),
				descriptor("readArtifactVersion"),
				descriptor("restoreArtifactVersion"),
			],
		};

		/** Chinese dictionary — the source of truth for this namespace. */
		const zh = {
			"view.artifacts": "产物",
			"list.aria": "产物列表",
			"list.count": "{count} 个产物",
			"empty.none": "还没有产物",
			"empty.hint": "让智能体写一份报告或文档，它们会出现在这里",
			"empty.root": "存放于 {root}",
			"action.back": "返回列表",
			"action.source": "源码",
			"action.preview": "预览",
			"action.delete": "删除",
			"action.deleteConfirm": "确认删除",
			"action.refresh": "刷新",
			"status.opening": "正在打开…",
			"status.deleting": "正在删除…",
			"status.deleted": "已删除 {name}",
			"status.confirmDelete": "再点一次「确认删除」以删除 {name}",
			"action.history": "历史",
			"action.historyCount": "历史 {n}",
			"action.closeHistory": "关闭历史",
			"action.restore": "恢复这一版",
			"action.hold": "按住看这一版",
			"history.aria": "版本历史",
			"history.current": "当前",
			"history.pill": "{time} · {size}",
			"compare.hint": "按住「按住看这一版」在原位切换，改动会自己跳出来",
			"compare.source": "左侧为这一版，右侧为当前版本",
			"diff.identical": "两版源码相同",
			"diff.tooLarge": "改动太大，无法逐行对比；用预览切换查看",
			"diff.folded": "{n} 行未改动",
			"status.loadingVersion": "正在打开该版本…",
			"status.restoring": "正在恢复…",
			"status.restored": "已恢复 {time} 的版本，被替换的内容已存入历史",
			"error.detail": "{code}：{message}",
			"time.now": "刚刚",
			"time.minutes": "{n} 分钟前",
			"time.hours": "{n} 小时前",
			"time.days": "{n} 天前",
		};

		/** English dictionary, key-identical to the Chinese source of truth. */
		const en = {
			"view.artifacts": "Artifacts",
			"list.aria": "Artifact list",
			"list.count": "{count} artifacts",
			"empty.none": "No artifacts yet",
			"empty.hint": "Ask the agent for a report or document and it will appear here",
			"empty.root": "Stored in {root}",
			"action.back": "Back to list",
			"action.source": "Source",
			"action.preview": "Preview",
			"action.delete": "Delete",
			"action.deleteConfirm": "Confirm delete",
			"action.refresh": "Refresh",
			"status.opening": "Opening…",
			"status.deleting": "Deleting…",
			"status.deleted": "Deleted {name}",
			"status.confirmDelete": "Press Confirm delete again to remove {name}",
			"action.history": "History",
			"action.historyCount": "History {n}",
			"action.closeHistory": "Close history",
			"action.restore": "Restore this one",
			"action.hold": "Hold to see this one",
			"history.aria": "Revision history",
			"history.current": "Current",
			"history.pill": "{time} · {size}",
			"compare.hint": "Hold the button to swap in place — what changed jumps out",
			"compare.source": "This revision on the left, current on the right",
			"diff.identical": "Both revisions have identical source",
			"diff.tooLarge": "Too much changed to line up; use the preview swap instead",
			"diff.folded": "{n} unchanged lines",
			"status.loadingVersion": "Opening that revision…",
			"status.restoring": "Restoring…",
			"status.restored": "Restored the revision from {time}; what it replaced went into the history",
			"error.detail": "{code}: {message}",
			"time.now": "just now",
			"time.minutes": "{n} min ago",
			"time.hours": "{n} h ago",
			"time.days": "{n} d ago",
		};

		/**
		 * Call one Remote method and flatten the reply to a single business union.
		 *
		 * There are TWO envelopes on this wire. The gateway wraps every reply in
		 * its own transport `{ ok, value }`, and the host's business
		 * `{ ok, value } | { ok:false, error }` then rides inside that `value`.
		 * Reading `reply.value.artifacts` therefore finds `undefined` on a
		 * perfectly successful call, because `reply.value` is the business
		 * envelope, not its payload — an empty page with no error at all, which
		 * is exactly what an unflattened reply looks like from the UI.
		 *
		 * Transport failures are normalized into the same `{ code, message }`
		 * error shape as business failures so callers render one thing.
		 * @param remote - the mounted `artifact` namespace.
		 * @param method - wire method name.
		 * @param request - the single JSON request argument.
		 * @returns the host's business union.
		 */
		async function call(remote, method, request) {
			let reply;
			try {
				reply = await remote[method](request);
			} catch (error) {
				const message = error && error.message ? error.message : String(error);
				return { ok: false, error: { code: "transport-failed", message } };
			}
			if (!isEnvelope(reply)) {
				return { ok: false, error: { code: "transport-invalid", message: method } };
			}
			if (reply.ok !== true) {
				const error = reply.error;
				return {
					ok: false,
					error: {
						code: (error && error.code) || "transport-failed",
						message: (error && error.message) || method,
					},
				};
			}
			// Unwrap only when the payload is unmistakably the business envelope,
			// so a gateway that stops double-wrapping keeps working.
			return isEnvelope(reply.value) ? reply.value : reply;
		}

		/** Whether a value has the `{ ok: boolean }` shape both envelopes share. */
		function isEnvelope(value) {
			return typeof value === "object" && value !== null && typeof value.ok === "boolean";
		}

		/** Coarse relative time; a list only needs to answer "how recent". */
		function relativeTime(t, modified) {
			if (!Number.isFinite(modified) || modified <= 0) return "";
			const minutes = Math.floor((Date.now() - modified) / 60000);
			if (minutes < 1) return t("time.now");
			if (minutes < 60) return t("time.minutes", { n: minutes });
			const hours = Math.floor(minutes / 60);
			if (hours < 24) return t("time.hours", { n: hours });
			return t("time.days", { n: Math.floor(hours / 24) });
		}

		/** The file name without its extension, used when a document carries no title. */
		function baseName(path) {
			return path.split(/[\\/]/).pop();
		}

		/**
		 * The palette handed to a previewed artifact.
		 *
		 * An iframe is a separate document, so the app's custom properties do not
		 * inherit into it — an artifact referencing `--dsw-*` would resolve
		 * nothing without this. The values are read LIVE from the app's own root
		 * rather than hardcoded, so a plugin that overrides the theme (or a user
		 * who switches it) reaches the artifact too.
		 */
		const PALETTE = [
			"--dsw-alias-bg-base",
			"--dsw-alias-bg-layer-1",
			"--dsw-alias-bg-layer-2",
			"--dsw-alias-label-primary",
			"--dsw-alias-label-secondary",
			"--dsw-alias-label-tertiary",
			"--dsw-alias-border-l1",
			"--dsw-alias-border-l2",
			"--dsw-alias-state-business-primary",
			"--dsw-alias-state-error-primary",
			"--dsw-alias-markdown-code-block",
		];

		/**
		 * Read the app's current palette as a `:root` block, or "" when unavailable.
		 *
		 * The live theme is the default and `overrides` — the plugin's `palette`
		 * config — wins, so a deployment can hand artifacts its own colors without
		 * restyling the app itself.
		 * @param overrides - custom property → value, from the host config.
		 */
		function paletteBlock(overrides) {
			if (typeof document === "undefined" || typeof getComputedStyle !== "function") return "";
			const declarations = new Map();
			const computed = getComputedStyle(document.documentElement);
			for (const token of PALETTE) {
				const value = computed.getPropertyValue(token).trim();
				// A token the deployment does not define is skipped, so the
				// artifact's own fallback keeps working instead of resolving empty.
				if (value !== "") declarations.set(token, value);
			}
			for (const [property, value] of Object.entries(overrides ?? {})) {
				if (typeof value === "string" && value.trim() !== "") declarations.set(property, value.trim());
			}
			if (declarations.size === 0) return "";
			const body = [...declarations].map(([property, value]) => property + ":" + value).join(";");
			return ":root{" + body + "}";
		}

		/**
		 * Whether the document declares its own color scheme.
		 *
		 * Only stylesheets and the meta tag count — the two places a declaration
		 * can actually live. Scanning the raw markup would find the words in the
		 * prose of any artifact that happens to be ABOUT css, a cheat sheet say,
		 * and skip the repair that document actually needs.
		 */
		function declaresColorScheme(html) {
			if (/<meta[^>]+name\s*=\s*["']?color-scheme/i.test(html)) return true;
			for (const style of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
				if (/color-scheme\s*:/i.test(style[1])) return true;
			}
			return false;
		}

		/**
		 * Give the previewed document a `color-scheme` when it declares none.
		 *
		 * Scrollbars, form controls, and the canvas behind the page are painted by
		 * the user agent, and it paints them light unless the document opts in.
		 * The app's own `scrollbar-color` rule cannot reach here: an iframe is a
		 * separate document, so a dark artifact otherwise scrolls with a bright
		 * scrollbar down its side.
		 *
		 * `light dark` rather than the app's current theme, deliberately: the
		 * document's own palette almost always keys off `prefers-color-scheme`,
		 * and forcing the opposite scheme would pair a dark scrollbar with a light
		 * page. Announcing both keeps the chrome and the content agreeing.
		 * @param html - the artifact's markup.
		 * @returns markup that declares a color scheme.
		 */
		/**
		 * A scroll bridge for the two frames of a comparison.
		 *
		 * Swapping revisions in place is only worth anything if both are looking
		 * at the SAME part of the document — otherwise holding the button reads
		 * as "everything changed" when the older frame is merely still at the
		 * top. The frames cannot read each other and this page cannot read
		 * either of them: `allow-scripts` without `allow-same-origin` is what
		 * keeps model-written markup away from the host origin, and that is not
		 * being relaxed for a scroll offset.
		 *
		 * `postMessage` needs no such access. Each frame reports where it is,
		 * and the browser hands the position to the other frame at the moment of
		 * a swap — one message per swap, no polling, no loop. The timestamp
		 * guard drops the echo a programmatic scroll would otherwise report back.
		 */
		const previewBridge =
			"<script>(function(){var q=0;" +
			"addEventListener('scroll',function(){if(Date.now()-q<150)return;" +
			"parent.postMessage({__dshArtifactScroll:(document.scrollingElement||document.documentElement).scrollTop},'*')" +
			"},{passive:true});" +
			"addEventListener('message',function(e){var y=e.data&&e.data.__dshArtifactScrollTo;" +
			"if(typeof y!=='number')return;q=Date.now();scrollTo(0,y)})})()<\/script>";

		function withPreviewShell(html, overrides) {
			const scheme = declaresColorScheme(html) ? "" : ":root{color-scheme:light dark}";
			const block = paletteBlock(overrides) + scheme;
			// First in the head, so the artifact's own rules still win: these are
			// variable definitions and a scheme default, not a restyling.
			const declaration = (block === "" ? "" : "<style>" + block + "</style>") + previewBridge;
			const head = /<head[^>]*>/i.exec(html);
			if (head !== null) {
				const at = head.index + head[0].length;
				return html.slice(0, at) + declaration + html.slice(at);
			}
			// No head to extend: a fragment or a hand-trimmed document still gets
			// the declaration, and the parser hoists it into the head it implies.
			return declaration + html;
		}

		/** Bytes as the browser would say them, for a revision's weight. */
		function formatBytes(bytes) {
			if (!Number.isFinite(bytes) || bytes < 0) return "";
			if (bytes < 1024) return bytes + " B";
			if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
			return (bytes / (1024 * 1024)).toFixed(1) + " MB";
		}

		/** Longest run of unchanged lines shown in full before it folds. */
		const DIFF_CONTEXT = 6;
		/** Cells of the LCS table this will build before giving up on a line diff. */
		const DIFF_CELL_BUDGET = 4_000_000;

		/**
		 * Break markup into diffable lines.
		 *
		 * Models write HTML with very few newlines in it — whole sections arrive
		 * on a single line — and a line diff over that is useless: every change
		 * reads as "this one enormous line was replaced". Splitting between
		 * adjacent tags gives the diff something to align on. It is a view of
		 * the source, never what gets stored.
		 */
		function splitForDiff(html) {
			return html.replace(/>\s*</g, ">\n<").split("\n");
		}

		/**
		 * A line diff of two revisions.
		 *
		 * The common head and tail come off first, which is what makes this
		 * affordable: edits to a document are nearly always local, so the part
		 * that actually needs aligning is a fraction of the file. Only what
		 * survives that trim goes through the LCS table, and a pair too far
		 * apart to align within the budget reports `tooLarge` rather than
		 * hanging the panel — the preview swap still answers the question.
		 * @returns rows of `{ kind, text }`, or a reason there are none.
		 */
		function diffRevisions(before, after) {
			const a = splitForDiff(before);
			const b = splitForDiff(after);
			let head = 0;
			while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
			let tail = 0;
			while (
				tail < a.length - head &&
				tail < b.length - head &&
				a[a.length - 1 - tail] === b[b.length - 1 - tail]
			) {
				tail += 1;
			}
			const left = a.slice(head, a.length - tail);
			const right = b.slice(head, b.length - tail);
			if (left.length === 0 && right.length === 0) return { identical: true, rows: [] };
			if (left.length * right.length > DIFF_CELL_BUDGET) return { tooLarge: true, rows: [] };

			// Suffix-length LCS table, walked forwards so rows come out in order.
			const width = right.length + 1;
			const table = new Int32Array((left.length + 1) * width);
			for (let i = left.length - 1; i >= 0; i -= 1) {
				for (let j = right.length - 1; j >= 0; j -= 1) {
					table[i * width + j] =
						left[i] === right[j]
							? table[(i + 1) * width + j + 1] + 1
							: Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
				}
			}
			const rows = [];
			let i = 0;
			let j = 0;
			while (i < left.length && j < right.length) {
				if (left[i] === right[j]) {
					rows.push({ kind: "same", text: left[i] });
					i += 1;
					j += 1;
				} else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
					rows.push({ kind: "remove", text: left[i] });
					i += 1;
				} else {
					rows.push({ kind: "add", text: right[j] });
					j += 1;
				}
			}
			while (i < left.length) rows.push({ kind: "remove", text: left[i++] });
			while (j < right.length) rows.push({ kind: "add", text: right[j++] });
			return { rows };
		}

		/**
		 * Collapse long stretches of unchanged lines into one foldable row, so a
		 * two-line edit does not arrive buried in a hundred lines of context.
		 */
		function foldUnchanged(rows) {
			const folded = [];
			let run = [];
			const edge = DIFF_CONTEXT / 2;
			const flush = () => {
				if (run.length === 0) return;
				if (run.length <= DIFF_CONTEXT) folded.push(...run);
				else {
					folded.push(...run.slice(0, edge));
					folded.push({ kind: "fold", count: run.length - DIFF_CONTEXT });
					folded.push(...run.slice(run.length - edge));
				}
				run = [];
			};
			for (const row of rows) {
				if (row.kind === "same") run.push(row);
				else {
					flush();
					folded.push(row);
				}
			}
			flush();
			return folded;
		}

		/**
		 * Every rule below mirrors a shipped dsh component rather than inventing a
		 * look, so the page reads as part of the app:
		 *
		 * - rows copy ui-workspace's search-result row — `min-height:48px`,
		 *   `border-radius:8px`, `padding:4px 8px`, borderless, hover
		 *   `interactive-bg-hover`, 14px/20px title;
		 * - buttons copy ui-conversation's breadcrumb — ghost, `border-radius:12px`,
		 *   `padding:4px 8px`, 14px/20px, `label-tertiary` until hover;
		 * - the header copies ui-conversation's own (32px title row, 8px action
		 *   gap) and the surface sits on `bg-base` like ConversationRoot.
		 *
		 * Sizes are raw px because the shipped components state them that way; the
		 * colors are tokens because those are the theme's contract. There are no
		 * hex fallbacks — a fallback is what silently pins a panel to light mode
		 * when a token name is wrong.
		 */
		const css =
			".dsh-artifact{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}" +
			// ── shared header ───────────────────────────────────────────────
			".dsh-artifact__bar{display:flex;align-items:center;gap:8px;padding:12px 20px;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none;min-height:32px;box-sizing:content-box}" +
			".dsh-artifact__heading{font-size:14px;font-weight:500;line-height:20px;margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
			".dsh-artifact__count{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin-right:auto}" +
			".dsh-artifact__spacer{margin-right:auto}" +
			// ui-sidebar's icon button, verbatim: a 28px circle with no fill until
			// hover. `place-items:center` on a fixed square is what keeps it a
			// true circle — padding would make it an oval the moment a glyph's
			// drawn width differs.
			".dsh-artifact__icon{width:28px;height:28px;padding:0;border:none;background:0 0;border-radius:50%;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none;display:inline-flex;justify-content:center;align-items:center}" +
			".dsh-artifact__icon:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}" +
			".dsh-artifact__icon[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}" +
			".dsh-artifact__icon:disabled{opacity:.4;cursor:default}" +
			".dsh-artifact__icon:focus-visible,.dsh-artifact__text:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}" +
			// ui-conversation's breadcrumb recipe, for the one button that carries words.
			".dsh-artifact__text{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:none;background:0 0;border-radius:14px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;cursor:pointer;flex:none}" +
			".dsh-artifact__text:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}" +
			".dsh-artifact__text:disabled{opacity:.4;cursor:default}" +
			// Only the destructive hover is invented: no shipped recipe carries it.
			".dsh-artifact__danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}" +
			// ── list page ───────────────────────────────────────────────────
			".dsh-artifact__list{flex:1;min-height:0;overflow-y:auto;padding:8px 16px 24px;margin:0;list-style:none;scrollbar-gutter:stable}" +
			".dsh-artifact__row{box-sizing:border-box;display:flex;align-items:center;gap:12px;width:100%;min-height:48px;border:none;background:0 0;border-radius:8px;padding:4px 8px;text-align:left;cursor:pointer;user-select:none;color:var(--dsw-alias-label-primary)}" +
			".dsh-artifact__row:hover{background:var(--dsw-alias-interactive-bg-hover)}" +
			".dsh-artifact__row:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}" +
			".dsh-artifact__rowmain{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}" +
			".dsh-artifact__rowtitle{font-size:14px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
			".dsh-artifact__rowmeta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
			".dsh-artifact__rowtime{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);flex:none;font-variant-numeric:tabular-nums}" +
			// ── detail page ─────────────────────────────────────────────────
			".dsh-artifact__stage{flex:1;min-height:0;position:relative;background:var(--dsw-alias-bg-base)}" +
			// The artifact paints its own background; white behind the frame keeps
			// a document that forgot to set one legible instead of transparent.
			".dsh-artifact__frame{width:100%;height:100%;border:0;background:#fff;display:block}" +
			".dsh-artifact__source{width:100%;height:100%;border:0;resize:none;padding:16px 20px;box-sizing:border-box;background:var(--dsw-alias-markdown-code-block);font-family:var(--ds-font-family-code);color:var(--dsw-alias-label-primary);font-size:13px;line-height:22px;white-space:pre;overflow:auto}" +
			// ── empty state ─────────────────────────────────────────────────
			".dsh-artifact__empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:24px;text-align:center}" +
			".dsh-artifact__emptytitle{font-size:14px;line-height:20px;color:var(--dsw-alias-label-secondary)}" +
			".dsh-artifact__emptyhint{font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary);max-width:44ch}" +
			".dsh-artifact__emptyroot{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);word-break:break-all;max-width:60ch}" +
			// ── revision history ────────────────────────────────────────────
			// A horizontal timeline rather than a dropdown: the panel is narrow,
			// the revisions are few, and comparing means going back and forth
			// between them — which a menu that closes on every pick makes worse.
			".dsh-artifact__timeline{display:flex;align-items:center;gap:6px;padding:8px 20px;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none;overflow-x:auto;scrollbar-width:thin}" +
			".dsh-artifact__pill{flex:none;border:1px solid var(--dsw-alias-border-l2);background:0 0;border-radius:14px;height:28px;padding:0 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;font-variant-numeric:tabular-nums}" +
			".dsh-artifact__pill:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}" +
			".dsh-artifact__pill[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-state-business-primary)}" +
			".dsh-artifact__pill:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}" +
			// Both frames stay mounted and stacked; only visibility changes, so a
			// swap keeps each document's scroll position and paint instead of
			// reloading it. `display:none` would throw both away on every press.
			".dsh-artifact__layer{position:absolute;inset:0}" +
			".dsh-artifact__layer--hidden{visibility:hidden}" +
			// ── source diff ─────────────────────────────────────────────────
			// Marked by a border and a sign rather than by a wash of red and
			// green: only two state colors are confirmed tokens in this theme,
			// and a diff that reads without color reads for everyone.
			".dsh-artifact__diff{width:100%;height:100%;overflow:auto;padding:16px 0;box-sizing:border-box;background:var(--dsw-alias-markdown-code-block);font-family:var(--ds-font-family-code);font-size:13px;line-height:22px}" +
			".dsh-artifact__diffrow{display:flex;gap:8px;padding:0 20px 0 12px;white-space:pre-wrap;word-break:break-word;border-left:2px solid transparent}" +
			".dsh-artifact__diffrow--same{color:var(--dsw-alias-label-tertiary)}" +
			".dsh-artifact__diffrow--remove{border-left-color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}" +
			".dsh-artifact__diffrow--add{border-left-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}" +
			".dsh-artifact__diffsign{flex:none;width:1ch;color:var(--dsw-alias-label-tertiary);user-select:none}" +
			".dsh-artifact__difffold{padding:4px 20px 4px 22px;font-size:12px;color:var(--dsw-alias-label-tertiary)}" +
			".dsh-artifact__diffnote{padding:16px 20px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}" +
			// ── status line ─────────────────────────────────────────────────
			".dsh-artifact__status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);padding:8px 20px;border-top:1px solid var(--dsw-alias-border-l2);flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}";

		/** Install the artifact stylesheet once. */
		function ensureStyle() {
			const tagId = "dsh-artifact/style";
			if (
				typeof document !== "undefined" &&
				document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null
			) {
				const tag = document.createElement("style");
				tag.dataset.plugin = "dsh-artifact";
				tag.dataset.pluginCss = tagId;
				tag.textContent = css;
				document.head.appendChild(tag);
			}
		}

		/**
		 * Glyphs from the app's `ic_ds_*` set. They render `fill="currentColor"`
		 * and take `{ size, className }`, so they inherit each button's state
		 * color and sit on the same drawing grid as every other icon on screen.
		 */
		const Icon = {
			back: primitives.IconChevronLeftOutline14,
			refresh: primitives.IconRefreshOutline16,
			source: primitives.IconCodeOutline16,
			preview: primitives.IconBrowseOutline16,
			remove: primitives.IconTrashOutline16,
		};

		/**
		 * A circular icon button, or a text button once `label` is present.
		 *
		 * Deliberately not the primitives `Button`: that component is a text
		 * button with an optional leading icon, and its `toolbar` variant paints
		 * a visible `rgba(84, 85, 87, .5)` fill. The app's own icon buttons — the
		 * ones in the sidebar — are a hand-rolled 28px circle with no background
		 * until hover, which is the look every other control here has.
		 * @param props - native button attributes.
		 * @param glyph - an `ic_ds_*` component, or null for a button of pure text.
		 * @param label - text that turns the circle into a pill; omit for icon-only.
		 */
		function iconButton(props, glyph, label) {
			const base = label == null ? "dsh-artifact__icon" : "dsh-artifact__text";
			const merged = Object.assign({ type: "button" }, props, {
				className: props.className == null ? base : base + " " + props.className,
			});
			return react.createElement(
				"button",
				merged,
				glyph == null ? null : react.createElement(glyph, { key: "icon", size: 16 }),
				label == null ? null : react.createElement("span", { key: "label" }, label),
			);
		}

		/**
		 * The source view of a comparison: what the older revision would have to
		 * become to be the current one.
		 */
		function renderDiff(t, before, after) {
			const diff = diffRevisions(before, after);
			if (diff.identical === true || diff.tooLarge === true) {
				return react.createElement(
					"div",
					{ className: "dsh-artifact__diffnote" },
					t(diff.identical === true ? "diff.identical" : "diff.tooLarge"),
				);
			}
			const sign = { same: " ", remove: "-", add: "+" };
			return react.createElement(
				"div",
				{ className: "dsh-artifact__diff" },
				foldUnchanged(diff.rows).map((row, index) =>
					row.kind === "fold"
						? react.createElement(
								"div",
								{ key: index, className: "dsh-artifact__difffold" },
								t("diff.folded", { n: row.count }),
							)
						: react.createElement(
								"div",
								{ key: index, className: "dsh-artifact__diffrow dsh-artifact__diffrow--" + row.kind },
								react.createElement(
									"span",
									{ className: "dsh-artifact__diffsign", "aria-hidden": true },
									sign[row.kind],
								),
								react.createElement("span", null, row.text),
							),
				),
			);
		}

		/** The artifact browser view. `remote` is the mounted artifact namespace. */
		function createBrowser(remote) {
			return function ArtifactBrowser(props) {
				const t = props.t;
				const [artifacts, setArtifacts] = react.useState([]);
				const [root, setRoot] = react.useState("");
				const [palette, setPalette] = react.useState(null);
				// `open` is the detail page: null means the list page is showing.
				const [open, setOpen] = react.useState(null);
				const [showSource, setShowSource] = react.useState(false);
				const [status, setStatus] = react.useState(null);
				const [busy, setBusy] = react.useState(false);
				// Deleting takes two clicks rather than a confirm dialog: an
				// unrecoverable delete of a file the agent may have spent a turn
				// writing deserves a deliberate second press.
				const [confirming, setConfirming] = react.useState(false);
				// Revision history. `compare` is the older revision loaded beside
				// the current one; null means only the current one is showing.
				const [versions, setVersions] = react.useState([]);
				const [historyOpen, setHistoryOpen] = react.useState(false);
				const [compare, setCompare] = react.useState(null);
				const [peeking, setPeeking] = react.useState(false);
				const currentFrame = react.useRef(null);
				const olderFrame = react.useRef(null);
				// Where each frame last reported itself to be. A ref rather than
				// state: nothing renders from it, and a scroll must not re-render
				// the frames it is scrolling.
				const scrollAt = react.useRef({ current: 0, older: 0 });

				// Each preview frame reports its scroll offset over postMessage
				// (see `previewBridge`). Believe a message only when it comes
				// from a frame this view mounted — an artifact is allowed to run
				// scripts, so anything else is just a document talking.
				react.useEffect(() => {
					function onMessage(event) {
						const y = event.data?.__dshArtifactScroll;
						if (typeof y !== "number") return;
						if (event.source === currentFrame.current?.contentWindow) {
							scrollAt.current.current = y;
						} else if (event.source === olderFrame.current?.contentWindow) {
							scrollAt.current.older = y;
						}
					}
					window.addEventListener("message", onMessage);
					return () => window.removeEventListener("message", onMessage);
				}, []);

				/** Swap the frames in place, carrying the reading position across. */
				const peek = react.useCallback((on) => {
					setPeeking(on);
					const target = on ? olderFrame.current : currentFrame.current;
					const from = on ? scrollAt.current.current : scrollAt.current.older;
					target?.contentWindow?.postMessage({ __dshArtifactScrollTo: from }, "*");
				}, []);

				const loadVersions = react.useCallback(async (path) => {
					const result = await call(remote, "listArtifactVersions", { path });
					setVersions(result.ok ? (result.value.versions ?? []) : []);
				}, []);

				const refresh = react.useCallback(async () => {
					const result = await call(remote, "listArtifacts", {});
					if (!result.ok) {
						setStatus(t("error.detail", result.error));
						return;
					}
					setArtifacts(result.value.artifacts ?? []);
					setRoot(result.value.root ?? "");
					setPalette(result.value.palette ?? null);
					setStatus(null);
				}, [t]);

				// The view mounts when its tab is selected, and an artifact can
				// appear at any time from a tool call, so the list is fetched on
				// every mount rather than once per session.
				react.useEffect(() => {
					refresh();
				}, [refresh]);

				const openArtifact = react.useCallback(
					async (artifact) => {
						setBusy(true);
						setConfirming(false);
						setShowSource(false);
						setCompare(null);
						setPeeking(false);
						setHistoryOpen(false);
						setVersions([]);
						setStatus(t("status.opening"));
						try {
							const result = await call(remote, "readArtifact", { path: artifact.path });
							if (!result.ok) {
								setStatus(t("error.detail", result.error));
								return;
							}
							setOpen({
								path: result.value.path,
								content: result.value.content,
								title: result.value.title ?? baseName(result.value.path),
							});
							await loadVersions(result.value.path);
							setStatus(null);
						} finally {
							setBusy(false);
						}
					},
					[loadVersions, t],
				);

				const back = react.useCallback(() => {
					setOpen(null);
					setConfirming(false);
					setCompare(null);
					setPeeking(false);
					setHistoryOpen(false);
					setStatus(null);
					refresh();
				}, [refresh]);

				/** Load one older revision beside the current one, or drop it. */
				const selectVersion = react.useCallback(
					async (version) => {
						if (open === null) return;
						if (version === null || compare?.id === version.id) {
							setCompare(null);
							setPeeking(false);
							return;
						}
						setBusy(true);
						setStatus(t("status.loadingVersion"));
						try {
							const result = await call(remote, "readArtifactVersion", {
								path: open.path,
								id: version.id,
							});
							if (!result.ok) {
								setStatus(t("error.detail", result.error));
								return;
							}
							setCompare({
								id: version.id,
								written: version.written,
								content: result.value.content,
								title: result.value.title,
							});
							setPeeking(false);
							setStatus(null);
						} finally {
							setBusy(false);
						}
					},
					[open, compare, t],
				);

				const restore = react.useCallback(async () => {
					if (open === null || compare === null) return;
					const when = relativeTime(t, compare.written);
					const content = compare.content;
					const title = compare.title;
					setBusy(true);
					setStatus(t("status.restoring"));
					try {
						const result = await call(remote, "restoreArtifactVersion", {
							path: open.path,
							id: compare.id,
						});
						if (!result.ok) {
							setStatus(t("error.detail", result.error));
							return;
						}
						// No confirm step, unlike delete: the content being
						// replaced is snapshotted on its way out, so a restore
						// is undone by restoring. Confirmation is worth its
						// friction only when something cannot be taken back.
						setOpen((previous) =>
							previous === null
								? previous
								: { ...previous, content, title: title ?? baseName(previous.path) },
						);
						setCompare(null);
						setPeeking(false);
						await loadVersions(open.path);
						setStatus(t("status.restored", { time: when }));
					} finally {
						setBusy(false);
					}
				}, [open, compare, loadVersions, t]);

				const deleteOpen = react.useCallback(async () => {
					if (open === null) return;
					const name = baseName(open.path);
					if (!confirming) {
						setConfirming(true);
						setStatus(t("status.confirmDelete", { name }));
						return;
					}
					setConfirming(false);
					setBusy(true);
					setStatus(t("status.deleting"));
					try {
						const result = await call(remote, "deleteArtifact", { path: open.path });
						if (!result.ok) {
							setStatus(t("error.detail", result.error));
							return;
						}
						setOpen(null);
						setVersions([]);
						setHistoryOpen(false);
						setCompare(null);
						setStatus(t("status.deleted", { name }));
						refresh();
					} finally {
						setBusy(false);
					}
				}, [open, confirming, refresh, t]);

				const statusLine =
					status === null
						? null
						: react.createElement("div", { className: "dsh-artifact__status" }, status);

				// ── detail page ──────────────────────────────────────────────
				if (open !== null) {
					const comparing = compare !== null;
					// Both frames stay in one keyed array so a swap changes
					// nothing but a class. Rebuilding either element would
					// reload the document inside it and throw away the reading
					// position the swap exists to preserve.
					const layers = [];
					if (comparing) {
						layers.push(
							react.createElement("iframe", {
								key: "older",
								ref: olderFrame,
								className:
									"dsh-artifact__frame dsh-artifact__layer" +
									(peeking ? "" : " dsh-artifact__layer--hidden"),
								title: compare.title ?? open.title,
								sandbox: "allow-scripts",
								srcDoc: withPreviewShell(compare.content, palette),
							}),
						);
					}
					layers.push(
						react.createElement("iframe", {
							key: "current",
							ref: currentFrame,
							className:
								"dsh-artifact__frame" +
								(comparing
									? " dsh-artifact__layer" + (peeking ? " dsh-artifact__layer--hidden" : "")
									: ""),
							title: open.title,
							// No `allow-same-origin`: model-written markup must not
							// reach this page's origin, storage, or cookies.
							sandbox: "allow-scripts",
							srcDoc: withPreviewShell(open.content, palette),
						}),
					);

					return react.createElement(
						"div",
						{ className: "dsh-artifact" },
						react.createElement(
							"div",
							{ className: "dsh-artifact__bar" },
							iconButton(
								{ onClick: back, title: t("action.back"), "aria-label": t("action.back") },
								Icon.back,
								null,
							),
							react.createElement(
								"h2",
								{ className: "dsh-artifact__heading dsh-artifact__spacer" },
								open.title,
							),
							// An artifact written once has no history, and shows
							// no trace of the feature. The button appears only
							// when there is something behind it.
							versions.length === 0
								? null
								: iconButton(
										{
											"aria-pressed": historyOpen,
											onClick: () => {
												setHistoryOpen((value) => !value);
												if (historyOpen) selectVersion(null);
											},
											title: historyOpen ? t("action.closeHistory") : t("action.history"),
										},
										null,
										t("action.historyCount", { n: versions.length }),
									),
							!comparing || showSource
								? null
								: iconButton(
										{
											"aria-pressed": peeking,
											disabled: busy,
											onMouseDown: () => peek(true),
											onMouseUp: () => peek(false),
											onMouseLeave: () => peek(false),
											onTouchStart: (event) => {
												event.preventDefault();
												peek(true);
											},
											onTouchEnd: () => peek(false),
											// Space and Enter reach this button as a
											// press-and-hold too, so the comparison is
											// not mouse-only.
											onKeyDown: (event) => {
												if (event.key === " " || event.key === "Enter") peek(true);
											},
											onKeyUp: (event) => {
												if (event.key === " " || event.key === "Enter") peek(false);
											},
											title: t("action.hold"),
										},
										null,
										t("action.hold"),
									),
							!comparing
								? null
								: iconButton(
										{ disabled: busy, onClick: restore, title: t("action.restore") },
										null,
										t("action.restore"),
									),
							iconButton(
								{
									"aria-pressed": showSource,
									onClick: () => setShowSource((value) => !value),
									title: showSource ? t("action.preview") : t("action.source"),
									"aria-label": showSource ? t("action.preview") : t("action.source"),
								},
								showSource ? Icon.preview : Icon.source,
								null,
							),
							// The confirm step keeps its words: an icon alone is the
							// wrong affordance for an unrecoverable delete.
							iconButton(
								{
									className: "dsh-artifact__danger",
									disabled: busy,
									onClick: deleteOpen,
									title: t("action.delete"),
									"aria-label": confirming ? t("action.deleteConfirm") : t("action.delete"),
								},
								Icon.remove,
								confirming ? t("action.deleteConfirm") : null,
							),
						),
						!historyOpen || versions.length === 0
							? null
							: react.createElement(
									"div",
									{
										className: "dsh-artifact__timeline",
										role: "group",
										"aria-label": t("history.aria"),
									},
									react.createElement(
										"button",
										{
											type: "button",
											className: "dsh-artifact__pill",
											"aria-pressed": !comparing,
											onClick: () => selectVersion(null),
										},
										t("history.current"),
									),
									versions.map((version) =>
										react.createElement(
											"button",
											{
												key: version.id,
												type: "button",
												className: "dsh-artifact__pill",
												"aria-pressed": compare?.id === version.id,
												disabled: busy,
												onClick: () => selectVersion(version),
											},
											t("history.pill", {
												time: relativeTime(t, version.written),
												size: formatBytes(version.bytes),
											}),
										),
									),
								),
						react.createElement(
							"div",
							{ className: "dsh-artifact__stage" },
							showSource
								? comparing
									? renderDiff(t, compare.content, open.content)
									: react.createElement("textarea", {
											className: "dsh-artifact__source",
											readOnly: true,
											value: open.content,
											spellCheck: false,
										})
								: layers,
						),
						statusLine,
					);
				}

				// ── list page ────────────────────────────────────────────────
				const body =
					artifacts.length === 0
						? react.createElement(
								"div",
								{ className: "dsh-artifact__empty" },
								react.createElement(
									"div",
									{ className: "dsh-artifact__emptytitle" },
									t("empty.none"),
								),
								react.createElement("div", { className: "dsh-artifact__emptyhint" }, t("empty.hint")),
								root === ""
									? null
									: react.createElement(
											"div",
											{ className: "dsh-artifact__emptyroot" },
											t("empty.root", { root }),
										),
							)
						: react.createElement(
								"ul",
								{ className: "dsh-artifact__list", "aria-label": t("list.aria") },
								artifacts.map((artifact) =>
									react.createElement(
										"li",
										{ key: artifact.path },
										react.createElement(
										"button",
										{
											type: "button",
											className: "dsh-artifact__row",
											disabled: busy,
											onClick: () => openArtifact(artifact),
										},
										react.createElement(
											"span",
											{ className: "dsh-artifact__rowmain" },
											react.createElement(
												"span",
												{ className: "dsh-artifact__rowtitle" },
												artifact.title,
											),
											react.createElement(
												"span",
												{ className: "dsh-artifact__rowmeta" },
												artifact.name,
											),
										),
										react.createElement(
											"span",
											{ className: "dsh-artifact__rowtime" },
											relativeTime(t, artifact.modified),
										),
										),
									),
								),
							);

				return react.createElement(
					"div",
					{ className: "dsh-artifact" },
					react.createElement(
						"div",
						{ className: "dsh-artifact__bar" },
						react.createElement("h2", { className: "dsh-artifact__heading" }, t("view.artifacts")),
						react.createElement(
							"span",
							{ className: "dsh-artifact__count" },
							artifacts.length === 0 ? "" : t("list.count", { count: artifacts.length }),
						),
						iconButton(
							{
								disabled: busy,
								onClick: refresh,
								title: t("action.refresh"),
								"aria-label": t("action.refresh"),
							},
							Icon.refresh,
							null,
						),
					),
					body,
					statusLine,
				);
			};
		}

		/** Required client services: slot contribution, the gateway, and copy. */
		const inject = ["slots", "remote", "locale"];

		/**
		 * Client plugin body: register the dictionaries, mount the Remote
		 * namespace, then register the artifact view tab.
		 * @param ctx - client root context.
		 */
		async function apply(ctx) {
			ensureStyle();
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-artifact: dictionaries");
			const t = ctx.locale.bind(NS);

			const disposeRemote = await ctx.remote.$mount(ARTIFACT_REMOTE);

			// The mount registers the namespace as the Cordis service
			// `remote.artifact`. Read it with `ctx.get()`, not `ctx.remote.artifact`:
			// property access goes through the injection guard, and declaring
			// `inject: ['remote.artifact']` would deadlock — this apply() is what
			// creates the very service the injection would wait for.
			const remote = ctx.get("remote.artifact");
			if (remote === undefined) {
				await disposeRemote();
				throw new Error("dsh-artifact: remote namespace `artifact` missing after $mount");
			}

			const Browser = createBrowser(remote);

			// `conversation.view` is the shell's tabbed view slot: every entry
			// becomes a tab beside the shipped views and owns the conversation
			// area while selected. `label` is a thunk so the tab text re-resolves
			// on a language switch; `order` places this tab after the shipped two.
			ctx.slots.inject("conversation.view", () =>
				ctx.slots.register(
					{
						name: "conversation.view",
						id: "artifacts",
						order: 20,
						locale: NS,
						label: () => t("view.artifacts"),
					},
					Browser,
				),
			);

			return async () => {
				await disposeRemote();
			};
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		/**
		 * Pure helpers, reachable by `scripts/test.mjs`.
		 *
		 * The browser half has no module boundary a test could import: the
		 * loader hands this factory one `require` that resolves registered ids
		 * and nothing else. The diff is ordinary algorithmic code with real edge
		 * cases — empty revisions, a pair too far apart to align, a fold that
		 * must not eat the lines around it — and shipping it untested because of
		 * a packaging detail is the wrong trade. Nothing in the app reads this.
		 */
		exports.__internals = { diffRevisions, foldUnchanged, formatBytes, splitForDiff };
		return module.exports;
	},
});
