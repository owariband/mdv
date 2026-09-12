# milkdownv

A quiet Milkdown desktop editor for `.mdv` documents that also edits ordinary `.md` files without exposing MDV-only controls. `milkdownv` is currently a source-build preview. The P0 app provides a real end-to-end path through Electron Main and `@owariband/mdv`; the renderer never reads ZIP files or local paths directly.

## P0 capabilities

- Open a folder through a native dialog, browse a bounded recursive tree, and edit `.mdv` or `.md` entries without exposing paths or general filesystem access to the renderer.
- Open a standalone `.mdv` or `.md` through a native file dialog when a folder workspace is unnecessary.
- Keep MDV-only Worktree, Reference, generation, and version state out of ordinary Markdown documents.
- Use a quiet Typora-style workspace with a persistent, resizable file sidebar, a collapsible two-column Worktree, and hover-only secondary controls.
- Use the project’s Hypnos Terminal theme by default, adapted from its Typora source to the Milkdown editing surface.
- Keep independent Milkdown/Crepe editors for Reference and Document.
- Edit and save the Document working copy without creating a version.
- Edit Reference directly while requiring a Main-process native confirmation and one-shot write permit for every Reference save.
- Accept and preview Milkdown's canonical Markdown before the first edited save.
- Switch either tree between visual and whole-document source editing.
- Rebase safe cross-tree generation changes and block same-tree stale writes.
- Inspect existing Reference and Document versions, branch ancestry, HEADs, and exact Document-to-Reference binds in the resizable Worktree panel.
- Keep Electron renderer sandboxed with no Node integration or generic filesystem IPC.

P0 deliberately does not include new-document creation, Commit, Checkout, history mutation, managed image import, automatic external file watching, crash recovery, packaging, signing, or auto-update. Its version and bind graph is read-only. Folder changes are picked up by an explicit refresh. The empty workspace therefore exposes an honest Open action rather than a fake editable caret. Image paste/drop is disabled until the managed-resource bridge is implemented.

## Local development

The adapter is an independent npm package. It does not turn the repository into a workspace and does not link to Core source.

```sh
cd adapter/mdv_desktop
npm run prepare:core
npm install --registry=https://registry.npmjs.org
npm run dev
```

After dependencies are installed:

```sh
npm run typecheck
npm test
npm run test:e2e
npm run start
```

`prepare:core` builds and packs the repository's current `@owariband/mdv` into the ignored `vendor/` directory and records its source commit and package integrity. `check:core` prevents a build from silently using a stale installed package.

## Architecture

```text
Vue 3 + two CrepeBuilder instances + folder tree
                │ typed, whitelisted IPC
Sandboxed Electron preload
                │
Electron Main FolderWorkspace + MdvSession
                │ Core public API only
          @owariband/mdv
                │
        .mdv + .mdv-assets
```

The folder workspace owns the canonical root and maps stable opaque node capabilities to private path segments. It skips symlinks, hidden entries and dependency trees, enforces depth and node budgets, and revalidates every segment before opening an MDV. The document session separately owns the package path, document identity, per-tree content baselines and write queue. A renderer save contains only the opaque session ID, current Markdown and its UI revision. Before every write, Main reopens the package and checks the target tree; a change to the other tree can safely advance generation, while a change to the target tree returns a conflict and preserves editor text. The production Main build bundles Core and its ZIP dependencies instead of relying on a repository-local `node_modules` tree at runtime.

The workspace boundary is designed for accidental changes and ordinary concurrent tools. Node does not expose a portable `openat`-style directory capability, so a hostile process running as the same OS user and continuously winning rename/symlink races is outside the P0 threat model. Main repeats path validation before activation, and Core still rejects changed or symbolic write targets.

The full design is maintained in [`docs/design/milkdown_app.mdv`](../../docs/design/milkdown_app.mdv).
