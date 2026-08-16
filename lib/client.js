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
		function withPreviewShell(html, overrides) {
			const scheme = /color-scheme/i.test(html) ? "" : ":root{color-scheme:light dark}";
			const block = paletteBlock(overrides) + scheme;
			if (block === "") return html;
			// First in the head, so the artifact's own rules still win: these are
			// variable definitions and a scheme default, not a restyling.
			const declaration = "<style>" + block + "</style>";
			const head = /<head[^>]*>/i.exec(html);
			if (head !== null) {
				const at = head.index + head[0].length;
				return html.slice(0, at) + declaration + html.slice(at);
			}
			// No head to extend: a fragment or a hand-trimmed document still gets
			// the declaration, and the parser hoists it into the head it implies.
			return declaration + html;
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
			".dsh-artifact__list{flex:1;min-height:0;overflow-y:auto;padding:8px 16px 24px;scrollbar-gutter:stable}" +
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
		 * @param glyph - an `ic_ds_*` component.
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
				react.createElement(glyph, { key: "icon", size: 16 }),
				label == null ? null : react.createElement("span", { key: "label" }, label),
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
							setStatus(null);
						} finally {
							setBusy(false);
						}
					},
					[t],
				);

				const back = react.useCallback(() => {
					setOpen(null);
					setConfirming(false);
					setStatus(null);
					refresh();
				}, [refresh]);

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
						react.createElement(
							"div",
							{ className: "dsh-artifact__stage" },
							showSource
								? react.createElement("textarea", {
										className: "dsh-artifact__source",
										readOnly: true,
										value: open.content,
										spellCheck: false,
									})
								: react.createElement("iframe", {
										className: "dsh-artifact__frame",
										title: open.title,
										// No `allow-same-origin`: model-written markup must not
										// reach this page's origin, storage, or cookies.
										sandbox: "allow-scripts",
										srcDoc: withPreviewShell(open.content, palette),
									}),
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
								"div",
								{ className: "dsh-artifact__list", role: "list", "aria-label": t("list.aria") },
								artifacts.map((artifact) =>
									react.createElement(
										"button",
										{
											key: artifact.path,
											type: "button",
											role: "listitem",
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
		return module.exports;
	},
});
