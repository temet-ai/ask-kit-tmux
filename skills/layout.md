Create sessions, windows and splits

1. Look first: `await scripts.run("overview")`. A session name that exists is not created again
   (`new-session` fails with a duplicate); add a window to it.
2. New session: `await tmux.newSession("work", { cwd: "~/my-app", window: "editor" })`. It starts
   detached; nobody is attached to it.
3. New window in a session: `await tmux.newWindow("work", { name: "server", cwd: "~/my-app", command: "npm run dev" })`.
   `created` is `session:index`. A window with a `command` closes when that command ends, unless
   the server sets remain-on-exit.
4. Split a pane: `await tmux.split("%3", { horizontal: true, cwd: "~/my-app" })` puts the new pane
   beside it; `horizontal: false` puts it below. `created` has the new pane id.
5. Even out sizes: `await tmux.run("select-layout", "-t", "work:1", "even-horizontal")`; other layouts
   are `even-vertical`, `main-horizontal`, `main-vertical`, `tiled`.
6. Resize one pane: `await tmux.resize("%3", { width: 80 })`; `{ zoom: true }` toggles zoom.
7. Rename: `tmux.rename("window", "work:1", "api")`. Select: `tmux.select("%4")`.
8. Finish with `await scripts.run("overview", { session: "work" })` and put the result's targets
   and ids in the answer.
