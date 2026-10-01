# Implementation notes

Written for anyone building a dsh plugin. Everything here was learned by reading the shipped packages or by watching something fail; each item is a place the obvious approach is wrong.

## The store uses `node:fs`, not `ctx.fs`

The artifact store is harness user data under `$DSH_HOME`, a sibling of `sessions/` and `storages/`. Three facts rule out the filesystem service:

1. It exposes **no delete and no mkdir** — its twelve methods are `resolve`, `stat`, `lstat`, `readText`, `readBytes`, `streamText`, `listDir`, `writeText`, `editText`, `contains`, `processPath`, `fileUrl`. Half of this plugin's operations have no counterpart.
2. Its sandbox exists to confine writes to the session workspace, and the store sits outside it. Under the default `workspace-write` policy **every artifact write would be denied** until the user approved an escalation.
3. Confinement moves into `resolveArtifactPath` instead: a path resolves inside `root` or is rejected.

## Four traps

**`z.string().optional()` crashes at module evaluation.** Schemastery is not Zod. Fields are optional by default; the API is `.required()` and `.default()`. There is no `.optional()`, and calling it takes the whole plugin down before it registers anything.

**Remote method names collide with the gateway's own class.** The client gateway builds one `RemoteNamespaceService` per namespace and rejects any method whose name matches its members — `ctx`, `empty`, `invokeRemote`, `methods`, `name`, `namespace`, `assertMethodAvailable`, `has`, `install`, `installDirect`, `installScoped`, `remove`. A bare verb like `list` or `remove` is one gateway release away from breaking, so every wire method here carries an `Artifact` suffix.

**`ctx.remote.<namespace>` trips the injection guard.** After `ctx.remote.$mount(...)` the namespace is registered as the Cordis service `remote.<namespace>`. Read it with `ctx.get("remote.artifact")`: property access goes through the guard, and declaring `inject: ["remote.artifact"]` deadlocks, because `apply()` is what creates the service the injection would wait for.

**`dsh.client.inject` names loader entries, not packages you require.** `@deepseek-ai/dsh-client-ui-primitives` is exposed through the module loader's shared registry rather than as an entry, so requiring it works while injecting it waits forever for something that never arrives — and a plugin stuck waiting fails silently, with no error anywhere.

## There are two envelopes on the wire

The gateway wraps every reply in its own transport `{ ok, value }`, and a business `{ ok, value } | { ok: false, error }` rides inside that `value`. Reading `reply.value.artifacts` therefore finds `undefined` on a perfectly successful call — an empty page with **no error at all**, because the transport envelope reported success. The client flattens both layers in one place before anything else reads a reply.

## Slots

`conversation.view` is the shell's tabbed view slot: `kind: 'list'`, `scope: 'session'`, and the shell turns every registration into a tab beside the shipped chat and trajectory views. Register with an `id`, an `order`, and a `label` thunk so the tab text re-resolves on a language switch.

Two things it cannot do. The composer is rendered as a sibling of the view area, and `ComposerChainProps` carries only `{ interactions, session }`, so a view cannot hide the input box. And the whole centre column, `conversation`, is `kind: 'single'` and already occupied — registering there **replaces the entire conversation surface and removes every seat it declares**, so it is never the way to build a full-page view.

## Matching the app's look

The design tokens are real and worth reading off the shipped stylesheet rather than guessing: `--dsw-alias-bg-base`, `bg-layer-1..3`, `label-primary/secondary/tertiary`, `border-l1..l4`, `interactive-bg-hover`, `state-business-primary`. Invented names like `--dsw-alias-bg-primary` do not exist and silently fall back to whatever literal you wrote, which is how a panel ends up pinned to light mode.

Component recipes are worth copying verbatim too. Rows here follow ui-workspace's search-result row (`min-height:48px`, `border-radius:8px`, `padding:4px 8px`, hover `interactive-bg-hover`, 14px/20px title). Icon buttons follow ui-sidebar's: a 28px square with `padding:0`, `background:0 0`, `border-radius:50%`, and a fill only on hover — the fixed square is what keeps the circle round, and the primitives `Button` is the wrong component for this because its `toolbar` variant paints a visible fill.

Icons come from the `ic_ds_*` set in `@deepseek-ai/dsh-client-ui-primitives`; they render `fill="currentColor"` and take `{ size, className }`.

## Previewing model-written HTML

The iframe runs `allow-scripts` and deliberately **not** `allow-same-origin`, so markup the model wrote cannot reach the host page's origin, storage, or cookies.

That isolation also means the app's own CSS does not reach inside. Two consequences are handled before the document renders: its custom properties are injected, since an artifact referencing `--dsw-*` would otherwise resolve nothing; and `color-scheme: light dark` is added when the document declares none, because scrollbars and form controls are painted by the user agent, which paints them light until asked otherwise.

## Two frames cannot see each other, and neither can the page

Comparing revisions by swapping them in place needs both frames looking at the same part of the document — otherwise holding the button reads as "everything changed" when the older frame is merely still at the top.

There is no way to read an iframe's scroll offset here, and that is not a gap to work around: `allow-scripts` without `allow-same-origin` is the whole reason model-written markup cannot reach this page's origin. Relaxing it for a number would trade the isolation for a convenience.

`postMessage` needs none of that access. The preview shell injects a few lines that report the offset on scroll and accept one back, and the browser hands the position over at the moment of a swap — one message per press, no polling. Two details matter: believe a message only when `event.source` is a frame this view mounted, since an artifact is allowed to run scripts and can post anything it likes; and have the injected listener ignore scroll events for a moment after it scrolls itself, or the echo comes straight back.

## The browser half has no module boundary a test can reach

`lib/client.js` is one `__ModuleLoader__.load({ factory })` registration, and the `require` handed to that factory resolves registered ids — `react`, the primitives package — and nothing else. There is no import a test could take.

That is a packaging fact, not a reason to ship algorithmic code untested. The diff has real edge cases (empty revisions, a pair too far apart to align, a fold that must not eat the lines around it), so the pure helpers hang off `exports.__internals`, and `scripts/test.mjs` stubs `window.__ModuleLoader__`, imports the file, and calls the captured factory with a `require` that answers `{}`. Nothing in the factory touches react or the icon set until a view mounts, so the helpers come back usable.

## The host half has no module boundary a test can reach either

`lib/index.js` imports `@deepseek-ai/dsh-*`, which are peers: outside a running dsh they do not resolve, so a plain `import` of the host half fails before any code runs. The browser half's `__ModuleLoader__` trick does not transfer — ESM resolves static imports before the module body, so a stub registered by importing the file arrives too late.

That left the plugin's entire model-facing surface — the tool description, the prompt section, the bundled skill, and the one-line reply to every command — untestable, which is how `renderOutcome` went on printing the absolute store path long after that path was the thing the surrounding prose warned against. A model quoted it, built a markdown link out of it, and the link went nowhere: an artifact store is harness user data the app never serves.

The fix is the same split that made the store testable: `lib/text.js` holds every string and imports only `node:path` and `./store.js`, so `scripts/test.mjs` imports it directly and asserts on what the strings SAY. The tests are therefore about wording — no reply may contain a path, and every path in the prose must sit inside a code span, because text in backticks reads to a model as a value to pass while the same text loose in a sentence reads as an address. `renderOutcome` reports an artifact by the filename its `path` argument takes.

Two consequences worth keeping: a new string belongs in `lib/text.js`, not `index.js`, or it is untested by construction; and `lib/text.js` has to stay in package.json `files[]`, or the published plugin imports a module that is not in the tarball.

## Bundled skills

`ctx.skills.register()` takes a runtime skill, which is how the `writing-artifacts` skill ships inside this package. The filesystem provider is the wrong route for a plugin: a bundle plugin is an npm package, so a skill directory resolves inside `node_modules`, where no catalog scanning project and user roots will ever find it.

## A keyed `tool.call.toolview` hit REPLACES the shipped row

`tool.call.toolview` dispatches on the wire Tool name, and the "generic" view is **not** a registration you can delegate to — `ToolCallTree` passes it inline as `renderSlot`'s `fallback`, and the view props a registration receives carry no fallback. The tool layer exports only `apply` and `inject`, so `GenericToolCard` is unreachable.

Registering `key: "artifact"` therefore means redrawing the row, and that was the right trade here rather than a cost: the generic row is chosen by a `TOOL_VARIANTS` table keyed on tool names the product knows, an unknown name classifies as `others`, and its card models (`diff`, `read`, `terminal`, `search`, `web`, `image`) each gate on a specific call name. So an `artifact` call rendered the tool name plus the raw arguments — for a `write`, that is the entire HTML document — and offered no way to open what the call wrote. (The host's `presentCall` diff card does not reach the chat either; the client's diff model reads the call's own raw arguments, and only for the names it knows.)

Two consequences worth keeping. The row's one real decision is whether this call has an artifact behind it to link, so it lives in `artifactRowModel` — pure, exported through `__internals`, and asserted in both directions, because a link built for a `list` or for a failed call opens nothing and looks identical to a working one. And the row's CSS is copied from ui-tool's own recipes (the 2px separator dot, the 13px secondary line, the underlined dotted link its file-mutation row already draws for a file name) rather than invented: a row that displaced a shipped one has to sit on the shipped grid.

## The right Sidebar is two registrations, and neither may be required

`ctx.sidebarRightTabs.register({ id, kind, title, guide })` declares the type; `ctx.slots.register({ name: "sidebar.right.pane.tab", key: definition.id })` supplies its body. The key is the definition's `id`, not its `kind` — the seat dispatches on the id, and a kind is explicitly not unique because an extension may take a builtin's over.

The body's parameters do **not** arrive as props of their own. `useTabInfo()` is a prop synthesized from the slot's own `hooks` compartment by the package that declares the slot, and the caller's `params` reach it as `tab.navigation.params`, with a `revision` stepped on every navigation. That last part is what makes a jump link repeatable: a page type deduplicates within a pane, so following three links in a row navigates one tab rather than opening three, and the revision — not the path — is what says a new request is a new request.

The trap is the dependency. Naming `sidebarRightTabs` in this plugin's exported `inject` looks like the obvious thing to do and is wrong: a required service that never arrives leaves the whole fiber PENDING, so an older host loses the `artifact` tool, the panel and the session tab along with the tab type. `ctx.inject([...], (scoped) => …)` waits instead, and the block simply never runs. The same reasoning made the jump link fall back to the panel on a `throw` rather than surfacing it: the right Sidebar refuses to open content with no Session seat mounted, and that is a correct refusal, not an error.

## A one-shot request needs a lifetime, not just a value

The jump link's fallback holds a path for the panel to consume, and a bare `{ path }` outlives its reader: leave the panel, come back, and a fresh mount consumes the same request again and reopens an artifact the reader had navigated away from. The request carries a sequence and is cleared by the mount that acts on it, which is what lets "open this again" and "the reader went back to the list" be different things.
