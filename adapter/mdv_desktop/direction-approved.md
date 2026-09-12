# Direction approval

- Date: 2026-09-11
- Context: iteration of the existing milkdownv interface, not a new visual direction.
- User direction: “咱们 UI 的整体审美不要参考 frontend design，参考 Huashu Design 的审美……一切从简，大道至简！”
- Decision: continue the Hypnos Terminal direction with Huashu-style restraint; remove redundant chrome and keep only controls or state that can change the user's next action.
- Density iteration: “整体字号还是太大了，还要小两号。然后你的上边框栏太宽了……还要再窄一点。” Body/source/Crepe move from 13px to 11px, heading root from 15px to 13px, and the shared top bar from 58px to 44px.
- Worktree history iteration: “我没有看出来你这个 Worktree 的那个版本数体现在什么地方呀？你这个 Bind 的没体现呀……Worktree 是那个 tab 是可以上下拖动变化的，所以你拖高一点，我看一下你的 tree 到底长什么样子。” Keep the chosen two-column Ref/Doc direction, expose real version counts, immutable version nodes and exact Doc → Ref bindings, and make the lower Worktree region vertically resizable without adding permanent chrome.

## Workspace footer iteration · 2026-09-12

- Shown directions:
  - A · Swiss Status Rail: `dist/sidebar-footer-directions/screenshots/a-swiss-status-rail.png`
  - B · Typora Drawer: `dist/sidebar-footer-directions/screenshots/b-typora-drawer.png`
  - C · Workspace Doorplate: `dist/sidebar-footer-directions/screenshots/c-workspace-doorplate.png`
- User selection: “B”
- Decision: replace the expanding “Open Folder…” CTA with the Typora-like workspace footer and upward drawer. Keep the closed footer quiet and stable; group available folder actions in the temporary drawer without changing sidebar width or pushing the editor layout.
