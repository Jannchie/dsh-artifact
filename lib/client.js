window.__ModuleLoader__.load({
	id: "dsh-artifact",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");

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
		 * Type, color, radius, and spacing all come from the shipped `--dsw-*`
		 * tokens so the page is indistinguishable from the rest of the app: the
		 * `font: var(--dsw-font-*)` shorthands carry size, weight, line-height and
		 * family together, `bg-layer-*` and `border-l*` are the real background and
		 * border ramps, and 6/8/12px are the radii the shell actually uses. There
		 * are no hex fallbacks — a fallback is what silently pins a panel to light
		 * mode when a token name is wrong.
		 */
		const css =
			".dsh-artifact{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}" +
			// ── shared header ───────────────────────────────────────────────
			".dsh-artifact__bar{display:flex;align-items:center;gap:8px;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none;min-height:48px;box-sizing:border-box}" +
			".dsh-artifact__heading{font:var(--dsw-font-s-strong-14);margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
			".dsh-artifact__count{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);margin-right:auto}" +
			".dsh-artifact__spacer{margin-right:auto}" +
			".dsh-artifact__btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;border-radius:6px;height:28px;padding:0 10px;font:var(--dsw-font-xxs-12);cursor:pointer;color:var(--dsw-alias-label-secondary)}" +
			".dsh-artifact__btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}" +
			".dsh-artifact__btn:disabled{opacity:.4;cursor:default}" +
			".dsh-artifact__btn--ghost{border-color:transparent;padding:0 8px}" +
			".dsh-artifact__btn--danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);border-color:transparent}" +
			// ── list page ───────────────────────────────────────────────────
			".dsh-artifact__list{flex:1;min-height:0;overflow:auto;padding:8px 12px 16px;scrollbar-color:var(--dsw-alias-scrollbar-bg-l1) transparent}" +
			".dsh-artifact__row{display:flex;align-items:baseline;gap:12px;width:100%;border:0;background:transparent;border-radius:8px;padding:11px 12px;text-align:left;cursor:pointer;color:inherit}" +
			".dsh-artifact__row:hover{background:var(--dsw-alias-interactive-bg-hover)}" +
			".dsh-artifact__row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}" +
			".dsh-artifact__rowmain{min-width:0;flex:1}" +
			".dsh-artifact__rowtitle{font:var(--dsw-font-xs-strong-13);display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
			".dsh-artifact__rowmeta{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);display:block;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
			".dsh-artifact__rowtime{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);flex:none;font-variant-numeric:tabular-nums}" +
			// ── detail page ─────────────────────────────────────────────────
			".dsh-artifact__stage{flex:1;min-height:0;position:relative;background:var(--dsw-alias-bg-layer-2)}" +
			// The artifact paints its own background; white behind the frame keeps
			// a document that forgot to set one legible instead of transparent.
			".dsh-artifact__frame{width:100%;height:100%;border:0;background:#fff;display:block}" +
			".dsh-artifact__source{width:100%;height:100%;border:0;resize:none;padding:16px 20px;box-sizing:border-box;font:var(--dsw-font-markdown-code-block);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);white-space:pre;overflow:auto}" +
			// ── empty state ─────────────────────────────────────────────────
			".dsh-artifact__empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:24px;text-align:center}" +
			".dsh-artifact__emptytitle{font:var(--dsw-font-s-14);color:var(--dsw-alias-label-secondary)}" +
			".dsh-artifact__emptyhint{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);max-width:42ch}" +
			".dsh-artifact__emptyroot{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);opacity:.8;word-break:break-all;max-width:56ch}" +
			// ── status line ─────────────────────────────────────────────────
			".dsh-artifact__status{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);padding:6px 16px;border-top:1px solid var(--dsw-alias-border-l2);flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}";

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

		/** A stroked chevron, drawn from `currentColor` so it tracks the theme. */
		function chevronLeft() {
			return react.createElement(
				"svg",
				{
					width: 14,
					height: 14,
					viewBox: "0 0 14 14",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.5,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": "true",
				},
				react.createElement("path", { d: "M8.5 3.5 5 7l3.5 3.5" }),
			);
		}

		/** The artifact browser view. `remote` is the mounted artifact namespace. */
		function createBrowser(remote) {
			return function ArtifactBrowser(props) {
				const t = props.t;
				const [artifacts, setArtifacts] = react.useState([]);
				const [root, setRoot] = react.useState("");
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
							react.createElement(
								"button",
								{
									type: "button",
									className: "dsh-artifact__btn dsh-artifact__btn--ghost",
									onClick: back,
									title: t("action.back"),
								},
								chevronLeft(),
								t("action.back"),
							),
							react.createElement(
								"h2",
								{ className: "dsh-artifact__heading dsh-artifact__spacer" },
								open.title,
							),
							react.createElement(
								"button",
								{
									type: "button",
									className: "dsh-artifact__btn",
									onClick: () => setShowSource((value) => !value),
								},
								showSource ? t("action.preview") : t("action.source"),
							),
							react.createElement(
								"button",
								{
									type: "button",
									className: "dsh-artifact__btn dsh-artifact__btn--danger",
									disabled: busy,
									onClick: deleteOpen,
								},
								confirming ? t("action.deleteConfirm") : t("action.delete"),
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
										srcDoc: open.content,
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
						react.createElement(
							"button",
							{ type: "button", className: "dsh-artifact__btn", disabled: busy, onClick: refresh },
							t("action.refresh"),
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
