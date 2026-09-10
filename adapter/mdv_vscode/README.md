# MDV for VS Code

Local preview extension for `.mdv`: edit Reference and Document as native Markdown documents, preview them with your existing Markdown renderer, and keep explicitly committed, traceable versions.

This is an independent adapter of [`@owariband/mdv`](../../README.md). It does not implement another Markdown renderer, ZIP writer, Agent runtime or server. `mdv-local` is an unpublished local extension identifier, not a claimed Marketplace publisher. This project is licensed under [Apache-2.0](LICENSE); public Marketplace distribution still requires the owner's publisher decision.

## Install the local VSIX

In VS Code, run **Extensions: Install from VSIX…** and select `dist/mdv-vscode-0.1.0-preview.7.vsix`. Alternatively:

```sh
code --install-extension adapter/mdv_vscode/dist/mdv-vscode-0.1.0-preview.7.vsix
```

Installing does not require a global Node installation or a separately installed Core package. The VSIX contains a bundled, fixed Core build; `dist/core-build.json` records its source commit and npm tarball integrity. Nothing is automatically published or installed by the build.

## First document

1. Create an empty `example.mdv` using Explorer's normal **New File**, then open it. It opens directly in the native Document Markdown editor; no initialization command or confirmation is required. Opening leaves the file empty on disk; the first save writes its MDV archive.
2. Existing archives also open directly in Doc, without switching or revealing your sidebar. There is no overview page. Open **MDV / Versions** from the activity bar when you want it. Use its small **Show Ref** button or **MDV: Show / Hide Ref** to place Ref on the left and Doc on the right. Both are native `markdown` editors, without diff highlighting. **MDV: New Document…** remains an optional shortcut.
3. Save with the usual shortcut. This updates the selected working copy inside the `.mdv`; it does **not** create a history version.
4. Run **MDV: Open Markdown Preview**, or use the normal Markdown preview button/shortcut.
5. When ready, run **MDV: Commit Reference…** or **MDV: Commit Document…**. Document commit asks for a precise committed Ref version or **Unbound**. It never silently commits a draft Ref or binds to a later Ref.
6. Select versions in the sidebar graph. **Open version** (or double-click) opens immutable Markdown; **Open bound pair** opens the exact historical Doc/Ref sources. **MDV: Preview Bound Reference / Document…** opens that pair in two built-in Markdown previews, not a diff against current Ref.

Two distinct states are shown: editor text not saved to the package, and package working-copy changes not committed to history. Saved text can still be uncommitted. Restoring a version explicitly confirms which edits will be discarded; restoring Doc does not move Ref HEAD.

Only genuinely empty files get the new-document behavior. Nonempty invalid archives or Markdown files renamed to `.mdv` are never silently converted or overwritten. Before the first save, a placeholder's identity is stable for the same unchanged local file, including window reload; save before moving/copying it if you need portable identity and imported image references. Verify reports that an empty new file has no saved archive yet.

## Version graph and paired writing

The activity-bar **MDV** view uses the project's cat-head icon. It has two history columns: **Ref** on the left, **Doc** on the right. Solid lines show each version's parent, including branches outside HEAD ancestry. Dashed lines point from a Doc to its exact Ref; alignment in a row does not imply a binding. Each tree has its own HEAD marker.

The view follows the sidebar's available width and height. Both columns and their branch rails reflow as you resize it; long summaries are truncated with their full text in hover tooltips. History scrolls vertically in the remaining space. Opening an `.mdv` does not change your selected sidebar or reveal a hidden one; **MDV: Show Version Graph** is an explicit action.

- Select Ref to highlight **all Doc versions using it**, including other branches. Select Doc to highlight and locate its precise Ref. Unbound Doc versions have no invented Ref link.
- The first selection is Ref HEAD, or Doc HEAD when no Ref exists. The footer separately identifies the Ref bound by Doc HEAD, which may differ from Ref HEAD.
- Working-copy labels distinguish **Unsaved edits**, **Uncommitted**, and **at HEAD**. A Ref draft is not a bindable version. Use the small **＋** buttons to explicitly commit; saving alone creates no version.
- Selecting a graph node never saves, commits or restores a version. Opening history is read-only; restoring still requires the existing explicit confirmation.
- Use **Show / Hide Ref** or **Show / Hide Doc** to collapse either source, with at least one working copy remaining. Hiding parks the native tab behind the other source; it does not close/discard it or copy its text elsewhere. Text, undo, selection and the original save baseline survive. Your own VS Code auto-save settings still apply normally.
- Sources are ordinary editor groups, not a single composite/diff tab. Unrelated files are not closed or globally rearranged. Reopen the sidebar with **MDV: Show Version Graph**; it follows the active MDV source and keeps the last MDV when you work in an unrelated file.

The graph uses metadata only; it is not a Markdown renderer and does not add persisted reverse binds to Ref. This preview draws the complete graph without virtualization; very large histories still need separate UI performance validation.

## Reuse existing Markdown extensions

MDV virtual documents have `.md` paths and `languageId: markdown`. The default preview is VS Code's **existing** `markdown.showPreviewToSide`, with its normal settings and contributed Markdown syntax, CSS and scripts. Built-in static previews are used for exact historical bindings.

| Extension mechanism | Integration |
| --- | --- |
| Native Markdown editing, syntax highlighting, undo/redo | Uses the existing VS Code text editor |
| Built-in Markdown preview | Reused directly, not copied or reimplemented |
| `markdown.markdownItPlugins`, `markdown.previewStyles`, `markdown.previewScripts` contributions | Stay in the built-in renderer's extension pipeline |
| Markdown All in One | Targeted Extension Host regression covers bold editing and save on `mdv:` documents |
| A separate third-party preview command | Can be selected through `mdv.previewCommand`; the command must accept an `mdv:` URI or use the active Markdown editor |
| Plugins restricted to `file:` or Node `fs.readFile(document.fileName)` | Not transparently compatible with virtual sources; no writable temporary `.md` mirror is maintained |

For a custom renderer, set `mdv.previewCommand` to its actual registered preview command. MDV passes the source URI and activates its text editor. This is an integration point, not a promise that every preview plugin works. Markdown Preview Enhanced has not been validated. Native shortcuts that directly invoke the built-in preview remain native; this setting changes only the MDV preview command.

Rendering settings and security remain those of the selected Markdown renderer. MDV does not replace the user's Markdown settings, enable unsafe scripts, or disable preview CSP. The built-in renderer's normal remote-image policy applies; this adapter does not impose a separate remote-download policy. Third-party syntax and raw HTML are supported to the extent the selected renderer supports them, not by a second MDV parser.

## Images and links

**MDV: Insert Image File…** imports PNG/JPEG/GIF/WebP through Core and inserts its hash-based relative path. Image paste/drop providers offer **Insert MDV hash image**; where clipboard formats are unsupported, use the explicit file command. Import changes the sidecar only; Markdown insertion remains an unsaved editor edit until normal save. Cancelled or undone insertion may leave an unused, reusable image; there is no automatic deletion.

All current and historical Markdown resolve relative paths against the real `.mdv` directory. The virtual Markdown URI retains that same parent. A small Markdown renderer extension redirects image reads through the MDV filesystem provider, without rewriting the saved Markdown. Managed images are read and hash-verified by Core.

Ordinary local resources are read-only through the virtual filesystem. The default allowed root is the `.mdv` directory; parent paths, absolute paths and symlink targets outside it require explicit permission:

```json
{
  "mdv.additionalResourceRoots": ["../shared-images", "/absolute/path/to/images"]
}
```

These are trusted-user settings. Roots are checked using real paths, not string prefixes. Images/resources are bounded to 32 MiB per read. Use Markdown image syntax for the adapter's remapping of absolute and explicitly allowed external images; raw HTML resource URLs remain subject to the native preview's resource roots. Resource query strings are not sent to a server by the local resource provider.

Do not move only the `.mdv` and expect external pictures to travel with it: retain its `.mdv-assets/` sidecar and any ordinary relative assets. `mdv:` is a virtual URI, not an OS path for shell tools or Agents.

## Saving and external changes

Saving calls Core with the editor's document identity and current safe generation baseline. Writes to one package are serialized. Each Ref/Doc baseline also records that working copy's byte length and SHA-256, so saving Ref does not falsely mark an unchanged Doc file as externally modified; the package generation and the virtual file's modification time serve different purposes.

An external writer's changes reload clean editors. A dirty editor keeps its text: if that exact Ref or Doc working copy is unchanged on disk, its baseline advances to the package's latest generation and it remains saveable; if the same working copy changed, saving stays blocked. Copy/export your edits using normal editor commands before **MDV: Reload Working Copy from Disk…** if you need to reconcile a real same-side conflict. MDV does not force-merge, forcibly remove locks, or take a fresh generation just to overwrite somebody else's work.

Native editor backups hold unsaved text; the extension persists only save-baseline metadata in extension storage. A restored buffer without a reliable baseline must not overwrite the package. A failed write can already have reached the Core commit point; inspect/reload the package before retrying. Save and commit, and Save All across Ref/Doc, remain separate transactions.

In Restricted Mode, source and history can be read but writes, imports, commits and restores are denied at their implementation entry points. Desktop local files are the current target. Remote SSH/WSL/containers, browser VS Code, Windows/Linux GUI behavior and arbitrary third-party renderers require their own acceptance tests.

VS Code may normalize mixed line endings or standalone CR when editing. Merely reading a package does not modify it; the editor's text-save behavior is not Core's raw-byte round-trip guarantee.

## Build and test independently

From the repository root, install/build Core first. Its root package does not install or build adapters:

```sh
npm ci
cd adapter/mdv_vscode
npm run prepare:core
npm install
npm run build
npm test -- --installed
npm run package
```

`prepare:core` builds a real `npm pack` artifact in the ignored `vendor/` directory, checks that it excludes `adapter/**`, and records provenance. Install consumes that artifact as an ordinary package, not a source symlink. The Core tarball includes its documentation, so editing Core docs also changes its integrity. After regenerating it, run `npm install --save-dev @owariband/mdv@file:vendor/owariband-mdv-0.0.0-development.tgz` to refresh the adapter lockfile; use `npm ci` once the generated artifact matches the lock. Build output is bundled CommonJS for the Extension Host; source remains strict TypeScript with ESM imports.

Open this adapter folder in VS Code, build, then use the included **Run MDV Extension** debug configuration. No root workspace conversion is required.

The test runner uses temporary workspace, user-data, extensions and shared-data directories. By default it downloads VS Code 1.100.0; an installed desktop binary can be supplied explicitly:

```sh
npm test -- --vscode "/path/to/VS Code executable" --installed --markdown-extension "/path/to/markdown-all-in-one"
npm test -- --vscode "/path/to/VS Code executable" --restricted
npm test -- --vscode "/path/to/VS Code executable" --recovery
npm test -- --vscode "/path/to/VS Code executable" --empty-recovery
```

`--installed`, `--restricted`, `--recovery` and `--empty-recovery` freshly package and install the VSIX in that isolated profile; they do not use a source-linked development extension. Use `--installed` for the full suite: VS Code's standard development test runner disables the modal dialogs exercised by commit/restore checks. Both recovery modes reload the real window with unsaved Doc and a hidden Ref from a new empty file: `--empty-recovery` verifies successful saves after recovery, while `--recovery` verifies that an externally changed Doc cannot be overwritten and that the unchanged recovered Ref remains saveable. For example, the macOS executable is `/Applications/Visual Studio Code.app/Contents/MacOS/Code`.

Test profiles, JSON results and screenshots are retained under the printed temporary path for diagnosis. The test runner enables a loopback-only debugging port to inspect actual preview DOM, loaded images and contributed CSS. It never uses your normal VS Code profile. See the [maintainer plan and acceptance record](../../docs/design/vscode_plugin.md) for completed and still-pending checks.

On 2026-09-08, all **19 `preview.3` installed-extension integration checks** passed on macOS arm64, VS Code 1.136.1 / Extension Host Node 24.18.1, including Markdown All in One 3.6.3. This includes the actual sidebar graph, branches/reverse binds, source hide/restore with dirty text/selection/undo intact, hidden-buffer external conflicts, and the existing editing/rendering/version checks. Separate installed-extension Restricted Mode and both real window-reload checks passed, now covering a hidden dirty Ref together with Doc. VS Code 1.100 API types compile, but its runtime download failed; minimum-version runtime, Windows/Linux GUI, large-graph performance and the real clipboard-source matrix are not yet verified. This is a local preview, not a universal Markdown-extension compatibility claim.

On 2026-09-09, **19 `preview.4` installed-extension checks** passed on the same runtime, including actual 200/280/460 px sidebar resizing and preserving Explorer or a hidden sidebar when opening MDV. This update only changes sidebar layout and opening behavior; the previous minimum-version and platform limitations still apply.

`preview.5` fixes the package entry lifecycle: initialization returns before redirecting, and a message from the loaded entry confirms the Webview has mounted before it is replaced by native Doc. The entry has no overview UI, external resources or Markdown renderer. Reopening an already-visible Doc from another editor group reproduced `OverlayWebview has been disposed` on `preview.4`; the same regression now passes, preserving dirty text, selection and undo. On 2026-09-09, **21 installed-extension checks** passed on the runtime above, including repeated/concurrent opens and inactive background tabs. Separate Restricted Mode and both real window-reload checks also passed. The installed test runner checks renderer logs and fails if a disposed-Webview error occurs; none occurred in these checks.

For actual Agent interoperability, pass `--agent-cli /absolute/path/to/installed/cli.cjs` to the installed test runner. It launches the independent Agent tool, checks paired reads, Doc-only saves, clean-editor refresh and dirty-buffer conflict protection. On 2026-09-09 that new check passed, but the complete rerun was **20/21**: an existing native undo assertion still failed after explicit focus/state waits. A separate graph-width assertion was corrected to account for native vertical scrollbars. This is not a full-suite pass; see [O006](../../docs/design/open-questions.md#o006原生撤销回归在-agent-联合检查中失败). No production plugin or Core code changed for this interoperability check.
