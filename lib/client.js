window.__ModuleLoader__.load({
	id: "dsh-artifact",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");

		//#region client half
		/**
		 * dsh-artifact, browser half: a sidebar entry point and an artifact
		 * browser overlay.
		 *
		 * Mounts a hand-written `src-json` Typert Remote contribution for the
		 * host `artifact` service, then registers two surfaces that share one
		 * open/closed store:
		 *
		 * 1. an action in `sidebar.footer.action` beside Settings, and
		 * 2. the browser overlay in `shell.overlay` — an artifact list beside a
		 *    sandboxed iframe rendering the selected document.
		 *
		 * Both registrations declare `locale: "artifact"`, so the framework
		 * injects the `t` seat and copy follows language switches live.
		 */

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
			"nav.label": "产物",
			"nav.open": "打开产物浏览器",
			"panel.aria": "产物浏览器",
			"panel.title": "产物",
			"list.aria": "产物列表",
			"empty.none": "还没有产物",
			"empty.hint": "让智能体写一个，它们存放在 {root}",
			"empty.select": "从左侧选择一个产物",
			"action.source": "源码",
			"action.preview": "预览",
			"action.delete": "删除",
			"action.deleteConfirm": "确认删除",
			"action.refresh": "刷新",
			"action.close": "关闭",
			"status.ready": "就绪",
			"status.opening": "正在打开…",
			"status.deleting": "正在删除…",
			"status.deleted": "已删除 {name}",
			"status.confirmDelete": "再点一次以删除 {name}",
			"error.detail": "{code}：{message}",
		};

		/** English dictionary, key-identical to the Chinese source of truth. */
		const en = {
			"nav.label": "Artifacts",
			"nav.open": "Open the artifact browser",
			"panel.aria": "Artifact browser",
			"panel.title": "Artifacts",
			"list.aria": "Artifact list",
			"empty.none": "No artifacts yet",
			"empty.hint": "Ask the agent to write one; they are stored in {root}",
			"empty.select": "Select an artifact from the list",
			"action.source": "Source",
			"action.preview": "Preview",
			"action.delete": "Delete",
			"action.deleteConfirm": "Confirm delete",
			"action.refresh": "Refresh",
			"action.close": "Close",
			"status.ready": "Ready",
			"status.opening": "Opening…",
			"status.deleting": "Deleting…",
			"status.deleted": "Deleted {name}",
			"status.confirmDelete": "Press delete again to remove {name}",
			"error.detail": "{code}: {message}",
		};

		/**
		 * Call one Remote method and flatten the reply to a single business union.
		 *
		 * There are TWO envelopes on this wire. The gateway wraps every reply in
		 * its own transport `{ ok, value }`, and the host's business
		 * `{ ok, value } | { ok:false, error }` then rides inside that `value`.
		 * Reading `reply.value.artifacts` therefore finds `undefined` on a
		 * perfectly successful call, because `reply.value` is the business
		 * envelope, not its payload — an empty panel with no error at all, which
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

		/**
		 * Open/closed state shared by the sidebar action and the overlay. Two
		 * independent slot registrations cannot share React state, and the
		 * plugin owns no store service, so this is a module-local subscribable
		 * whose lifetime is the plugin's.
		 */
		function createToggleStore() {
			let open = false;
			const listeners = new Set();
			return {
				isOpen: () => open,
				set(next) {
					if (open === next) return;
					open = next;
					for (const listener of listeners) listener();
				},
				toggle() {
					this.set(!open);
				},
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
			};
		}

		/**
		 * Every color, radius, and shadow comes from a `--dsw-*` design token so
		 * the panel tracks the app's theme instead of pinning one palette. The
		 * token names are the ones the shipped stylesheet actually defines:
		 * layered backgrounds (`bg-layer-1..3`), numbered borders (`border-l1..4`),
		 * masks (`bg-mask-1`), elevations (`shadow-lv1..3`) and the `label-*` and
		 * `interactive-*` families. There are no hex fallbacks: a fallback is what
		 * silently pins a panel to light mode when a token name is wrong.
		 */
		const css =
			".dsh-artifact-nav{display:flex;align-items:center;gap:8px;width:100%;border:0;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:8px;padding:6px 8px;font:inherit;font-family:var(--dsw-font-family);font-size:13px;cursor:pointer;text-align:left}" +
			".dsh-artifact-nav:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}" +
			".dsh-artifact-nav[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}" +
			".dsh-artifact-nav--rail{justify-content:center;padding:6px}" +
			".dsh-artifact-nav__icon{flex:none;display:block}" +
			".dsh-artifact{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-mask-1)}" +
			".dsh-artifact__panel{display:flex;flex-direction:column;width:min(1080px,calc(100vw - 48px));height:min(760px,calc(100vh - 48px));background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:var(--dsw-shadow-lv3);overflow:hidden;font-family:var(--dsw-font-family)}" +
			".dsh-artifact__head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l2)}" +
			".dsh-artifact__title{font-size:13px;font-weight:600;margin-right:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
			".dsh-artifact__btn{border:1px solid var(--dsw-alias-border-l2);background:transparent;border-radius:6px;height:26px;padding:0 10px;font:inherit;font-family:var(--dsw-font-family);font-size:12px;cursor:pointer;color:var(--dsw-alias-label-secondary)}" +
			".dsh-artifact__btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}" +
			".dsh-artifact__btn:disabled{opacity:.4;cursor:default}" +
			".dsh-artifact__btn--danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}" +
			".dsh-artifact__body{display:flex;flex:1;min-height:0}" +
			".dsh-artifact__list{width:240px;flex:none;border-right:1px solid var(--dsw-alias-border-l2);overflow:auto;padding:6px;scrollbar-color:var(--dsw-alias-scrollbar-bg-l1) transparent}" +
			".dsh-artifact__item{display:block;width:100%;border:0;background:transparent;border-radius:6px;padding:7px 9px;font:inherit;font-family:var(--dsw-font-family);font-size:13px;text-align:left;cursor:pointer;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
			".dsh-artifact__item:hover{background:var(--dsw-alias-interactive-bg-hover)}" +
			".dsh-artifact__item[aria-current=true]{background:var(--dsw-alias-interactive-bg-active);font-weight:600}" +
			".dsh-artifact__item span{display:block;font-size:11px;font-weight:400;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis}" +
			".dsh-artifact__view{flex:1;min-width:0;position:relative;background:var(--dsw-alias-bg-layer-2)}" +
			// The artifact paints its own background; white behind the frame keeps
			// a document that forgot to set one legible instead of transparent.
			".dsh-artifact__frame{width:100%;height:100%;border:0;background:#fff}" +
			".dsh-artifact__source{width:100%;height:100%;border:0;resize:none;padding:12px 14px;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;line-height:1.55;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);white-space:pre;overflow:auto}" +
			".dsh-artifact__empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;font-size:13px;color:var(--dsw-alias-label-tertiary);text-align:center;padding:0 24px}" +
			".dsh-artifact__status{font-size:12px;color:var(--dsw-alias-label-tertiary);padding:6px 12px;border-top:1px solid var(--dsw-alias-border-l2);min-height:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}";

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

		/** Subscribe a component to the toggle store. */
		function useToggle(store) {
			const [open, setOpen] = react.useState(store.isOpen());
			react.useEffect(() => store.subscribe(() => setOpen(store.isOpen())), [store]);
			return open;
		}

		/** The artifact glyph, drawn from `currentColor` so it tracks the theme. */
		function icon() {
			return react.createElement(
				"svg",
				{
					className: "dsh-artifact-nav__icon",
					width: 16,
					height: 16,
					viewBox: "0 0 16 16",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.4,
					strokeLinejoin: "round",
					"aria-hidden": "true",
				},
				react.createElement("rect", { x: 2.2, y: 2.2, width: 11.6, height: 11.6, rx: 2 }),
				react.createElement("path", { d: "M2.2 6h11.6", strokeLinecap: "round" }),
			);
		}

		/** The sidebar footer action that opens the artifact browser. */
		function createNavAction(store) {
			return function ArtifactNavAction(props) {
				const t = props.t;
				const open = useToggle(store);
				// `wide` is the sidebar's fold state: the rail shows icons only.
				const wide = props.wide !== false;
				return react.createElement(
					"button",
					{
						type: "button",
						className: "dsh-artifact-nav" + (wide ? "" : " dsh-artifact-nav--rail"),
						"aria-pressed": open,
						title: t("nav.open"),
						"aria-label": t("nav.label"),
						onClick: () => store.toggle(),
					},
					icon(),
					wide ? t("nav.label") : null,
				);
			};
		}

		/** The artifact browser overlay. `remote` is the mounted artifact namespace. */
		function createBrowser(store, remote) {
			return function ArtifactBrowser(props) {
				const t = props.t;
				const open = useToggle(store);
				const [artifacts, setArtifacts] = react.useState([]);
				const [root, setRoot] = react.useState("");
				const [current, setCurrent] = react.useState(null);
				const [content, setContent] = react.useState(null);
				const [showSource, setShowSource] = react.useState(false);
				const [status, setStatus] = react.useState(null);
				const [busy, setBusy] = react.useState(false);
				// Deleting takes two clicks rather than a confirm dialog: a modal
				// dialog inside the overlay would stack two layers, and an
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

				// The list is only meaningful while the overlay is open, and an
				// artifact can appear at any time from a tool call, so refresh on
				// every open rather than once at mount.
				react.useEffect(() => {
					if (open) refresh();
				}, [open, refresh]);

				const openArtifact = react.useCallback(
					async (path) => {
						setBusy(true);
						setConfirming(false);
						setStatus(t("status.opening"));
						try {
							const result = await call(remote, "readArtifact", { path });
							if (!result.ok) {
								setStatus(t("error.detail", result.error));
								return;
							}
							setCurrent(result.value.path);
							setContent(result.value.content);
							setStatus(result.value.title ?? null);
						} finally {
							setBusy(false);
						}
					},
					[t],
				);

				const deleteCurrent = react.useCallback(async () => {
					if (current === null) return;
					const name = current.split(/[\\/]/).pop();
					if (!confirming) {
						setConfirming(true);
						setStatus(t("status.confirmDelete", { name }));
						return;
					}
					setConfirming(false);
					setBusy(true);
					setStatus(t("status.deleting"));
					try {
						const result = await call(remote, "deleteArtifact", { path: current });
						if (!result.ok) {
							setStatus(t("error.detail", result.error));
							return;
						}
						setCurrent(null);
						setContent(null);
						setStatus(t("status.deleted", { name }));
						refresh();
					} finally {
						setBusy(false);
					}
				}, [current, confirming, refresh, t]);

				// Escape closes the overlay, matching every other dismissible layer.
				react.useEffect(() => {
					if (!open) return undefined;
					const onKey = (event) => {
						if (event.key === "Escape") store.set(false);
					};
					window.addEventListener("keydown", onKey);
					return () => window.removeEventListener("keydown", onKey);
				}, [open]);

				if (!open) return null;

				const view =
					content !== null
						? showSource
							? react.createElement("textarea", {
									className: "dsh-artifact__source",
									readOnly: true,
									value: content,
									spellCheck: false,
								})
							: react.createElement("iframe", {
									className: "dsh-artifact__frame",
									title: current ?? t("panel.title"),
									// No `allow-same-origin`: model-written markup must not
									// reach this page's origin, storage, or cookies.
									sandbox: "allow-scripts",
									srcDoc: content,
								})
						: react.createElement(
								"div",
								{ className: "dsh-artifact__empty" },
								artifacts.length === 0
									? react.createElement(react.Fragment, null, t("empty.none"))
									: null,
								artifacts.length === 0 ? t("empty.hint", { root }) : t("empty.select"),
							);

				return react.createElement(
					"div",
					{
						className: "dsh-artifact",
						role: "dialog",
						"aria-modal": "true",
						"aria-label": t("panel.aria"),
						onClick: (event) => {
							if (event.target === event.currentTarget) store.set(false);
						},
					},
					react.createElement(
						"div",
						{ className: "dsh-artifact__panel" },
						react.createElement(
							"div",
							{ className: "dsh-artifact__head" },
							react.createElement(
								"span",
								{ className: "dsh-artifact__title" },
								current ? current.split(/[\\/]/).pop() : t("panel.title"),
							),
							react.createElement(
								"button",
								{
									type: "button",
									className: "dsh-artifact__btn",
									disabled: content === null,
									onClick: () => setShowSource((value) => !value),
								},
								showSource ? t("action.preview") : t("action.source"),
							),
							react.createElement(
								"button",
								{
									type: "button",
									className: "dsh-artifact__btn dsh-artifact__btn--danger",
									disabled: busy || current === null,
									onClick: deleteCurrent,
								},
								confirming ? t("action.deleteConfirm") : t("action.delete"),
							),
							react.createElement(
								"button",
								{ type: "button", className: "dsh-artifact__btn", disabled: busy, onClick: refresh },
								t("action.refresh"),
							),
							react.createElement(
								"button",
								{ type: "button", className: "dsh-artifact__btn", onClick: () => store.set(false) },
								t("action.close"),
							),
						),
						react.createElement(
							"div",
							{ className: "dsh-artifact__body" },
							react.createElement(
								"div",
								{ className: "dsh-artifact__list", role: "list", "aria-label": t("list.aria") },
								artifacts.map((artifact) =>
									react.createElement(
										"button",
										{
											key: artifact.path,
											type: "button",
											className: "dsh-artifact__item",
											"aria-current": artifact.path === current,
											disabled: busy,
											onClick: () => openArtifact(artifact.path),
										},
										artifact.title,
										react.createElement("span", null, artifact.name),
									),
								),
							),
							react.createElement("div", { className: "dsh-artifact__view" }, view),
						),
						react.createElement(
							"div",
							{ className: "dsh-artifact__status" },
							status ?? t("status.ready"),
						),
					),
				);
			};
		}

		/** Required client services: slot contribution, the gateway, and copy. */
		const inject = ["slots", "remote", "locale"];

		/**
		 * Client plugin body: register the dictionaries, mount the Remote
		 * namespace, then register the sidebar action and the browser overlay.
		 * @param ctx - client root context.
		 */
		async function apply(ctx) {
			ensureStyle();
			ctx.effect(() => ctx.locale.register("artifact", { zh, en }), "dsh-artifact: dictionaries");

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

			const store = createToggleStore();
			const NavAction = createNavAction(store);
			const Browser = createBrowser(store, remote);

			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register(
					{ name: "shell.overlay", id: "artifact-browser", order: 100, locale: "artifact" },
					Browser,
				),
			);

			// `sidebar.footer.action` is a `list` slot beside Settings; its owner
			// props carry the sidebar's `wide` fold state.
			ctx.slots.inject("sidebar.footer.action", () =>
				ctx.slots.register(
					{ name: "sidebar.footer.action", id: "artifact-nav", order: 50, locale: "artifact" },
					NavAction,
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
