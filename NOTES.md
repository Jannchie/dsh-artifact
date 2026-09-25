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

## Bundled skills

`ctx.skills.register()` takes a runtime skill, which is how the `writing-artifacts` skill ships inside this package. The filesystem provider is the wrong route for a plugin: a bundle plugin is an npm package, so a skill directory resolves inside `node_modules`, where no catalog scanning project and user roots will ever find it.
