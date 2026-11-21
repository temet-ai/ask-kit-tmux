Run a command in a pane and report what it printed

1. Pick the pane. `await scripts.run("status")` lists every pane with its state. A pane that is
   `idle-at-prompt` is safe to type into. A `running` or `waiting-for-input` pane holds a program:
   do not type into it unless the request says to; make a new window instead:
   `const w = await tmux.newWindow("<session>", { name: "task", cwd: "<folder>" })` and use its pane.
2. Type the command: `await tmux.send("%3", "npm test")`. It is typed literally and Enter is pressed.
   Use `{ enter: false }` to leave it unsent. For a keystroke use `tmux.keys("%3", "C-c")`.
3. Wait for the output: `const r = await tmux.settle("%3", { quietMs: 2000, timeoutMs: 30000, lines: 80 })`.
   `r.settled` false means the command was still printing when the time ended. Do not wait longer than
   60 seconds in one call; call `settle` again if the command is expected to finish.
4. Read the result in `r.text`. If a program stopped at a prompt, `await tmux.state("%3")` says so.
5. A command that never ends (a dev server, a watcher) is started, checked once with `settle`, and
   left running in its pane. Say which pane it runs in. Stop it with `tmux.keys("%3", "C-c")` only
   when the request asks.
6. Answer with the pane id, what was typed, and the last lines printed. Say when lines were masked.
