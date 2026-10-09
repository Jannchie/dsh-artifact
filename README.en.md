# dsh-artifact

[中文](README.md) | English

[![npm](https://img.shields.io/npm/v/dsh-artifact)](https://www.npmjs.com/package/dsh-artifact)
[![license](https://img.shields.io/npm/l/dsh-artifact)](./LICENSE)

dsh-artifact adds artifacts to [DeepSeek Harness](https://github.com/deepseek-ai): the agent writes self-contained HTML documents or slide decks through an `artifact` tool, and each one opens beside the conversation as soon as it is written.

A report that stays in the chat scrolls away with it; one written into the repository becomes an `.html` file nobody opens again. Artifacts are stored outside the workspace, listed newest first, and can be read, edited and compared with earlier revisions in place. Decks can also be presented full screen and exported to PowerPoint.

![The agent finishes a deck and the right sidebar opens it in the slide editor](https://raw.githubusercontent.com/Jannchie/dsh-artifact/main/images/auto-open.gif)

## Install

```sh
dsh plugin --profile web add dsh-artifact      # dsh web
dsh plugin --profile desktop add dsh-artifact  # desktop app
```

Plugins load at process start, so restart `dsh web` or the desktop app after installing. The right sidebar and the artifact panel require DSH 0.1.7 or later.

## Getting started

Ask the agent for something worth keeping:

> Summarize this week's benchmark results as a report.

> Make a four-slide deck reviewing the coffee shop's quarter.

The agent writes the artifact with the `artifact` tool. If the conversation is on screen when the write finishes, the artifact opens in the right sidebar. The tool row in the conversation also shows the artifact's name as a link, which reopens it later.

## Common tasks

**Reading a document.** Reports, cheat sheets and comparisons are written as self-contained HTML documents: one reading column, colors that follow the app's theme, and wide tables that scroll on their own. A document is read in the right sidebar and can be switched to its source.

![An HTML document opened beside the conversation after the agent writes it](https://raw.githubusercontent.com/Jannchie/dsh-artifact/main/images/document.png)

**Finding artifacts.** A conversation's **Artifacts** tab lists what that session wrote; the **Artifacts** panel in the left sidebar lists every artifact from every session. **Open in sidebar** moves a document from the panel to the conversation's side.

![The artifact library, newest first](https://raw.githubusercontent.com/Jannchie/dsh-artifact/main/images/library-en.png)

**Editing a deck.** Asked for a presentation, the agent writes a slide deck rather than a page. The deck opens in an editor that edits text in place, accepts dropped images, adds and removes table rows and columns, switches themes, presents full screen and exports `.pptx`. Edits are saved to the same artifact, so the agent reads them on its next `read`. The editor is [`@jannchie/slides`](https://github.com/Jannchie/slides).

![The slide editor: thumbnails, stage, format pane and speaker notes](https://raw.githubusercontent.com/Jannchie/dsh-artifact/main/images/slides.png)

**Comparing revisions.** A rewritten artifact keeps the revisions it replaced (20 per artifact by default), and a **History** button appears beside its title. In preview, **Hold to see this one** swaps the older revision into the same place on screen; in source, the two are shown as a diff with unchanged stretches folded. **Restore this one** needs no confirmation, because the content it replaces is kept as a revision too.

**What opens on its own.** Only a `write` that finishes while the conversation is live opens an artifact automatically. Calls replayed when a session is reopened, `read` and `list` open nothing, and when the right sidebar is unavailable (no session selected) the artifact panel is not opened in its place.

## The `artifact` tool

| Command | Arguments | Effect |
|---|---|---|
| `list` | — | Every artifact, newest first |
| `read` | `path` | One artifact's full content |
| `write` | `path`, `content`, `kind` | Create or replace an artifact; `kind` is `html` (default) or `slides` |
| `delete` | `path` | Remove an artifact and its revisions |

`path` is relative to the artifact directory and the `.html` suffix is optional. The agent also receives a `writing-artifacts` skill describing document structure, colors, and the subset of HTML a deck may use.

## Storage and rendering

- Artifacts live in `$DSH_HOME/artifacts` (by default `~/.dsh/artifacts`), with revisions under `.versions/` and images placed in decks under `.assets/`.
- HTML artifacts render in a sandboxed iframe that allows scripts only: no network and no same-origin access, so everything an artifact needs is inlined. The preview receives the app's current color tokens and follows its theme.

## Configuration

Override in the profile's `cordis.patch.yml`:

```yaml
- id: artifact
  config:
    root: /absolute/path/to/artifacts   # artifact directory; default $DSH_HOME/artifacts
    maxArtifactChars: 400000            # character limit for one write
    maxVersionsPerArtifact: 20          # revisions kept per artifact; 0 disables history
    promptSection: true                 # tell the model when to write an artifact
    skill: true                         # register the writing-artifacts skill
    palette:                            # colors layered over the live theme for previews
      state-business-primary: '#e0552b'
```

Implementation notes on slot contracts and the wire protocol are in [NOTES.md](NOTES.md).

## License

MIT
