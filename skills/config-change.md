Change a tmux setting or a key binding

1. Find what is set now and where: `await scripts.run("config", { key: "<option or key>" })`. It
   gives the file and line that sets it and the value tmux has now (`runtime`).
2. Change the running server: `await tmux.run("set-option", "-g", "mouse", "on")` for a session
   option, `-gw` for a window option, `-s` for a server option; `await tmux.run("bind-key", "-T", "prefix", "|", "split-window", "-h")`
   for a key. This lasts until the server ends.
3. This kit does not edit files. To make the change last, the config file needs the same line:
   `set -g mouse on`. Give the file and the line to add or change (from step 1) in the answer, or
   say that the `dotfiles` kit can edit it.
4. Reload after the file changed: `await tmux.reload()` runs `source-file` on the loaded config.
   Its result has `ok` and tmux's error text; a syntax error names the line.
5. Check: `await scripts.run("config", { key: "<same word>" })` again; the `runtime` value must be
   the new one. Report both values, the old and the new.
6. Reloading does not undo a binding or option that was set live and then removed from the file.
   Say so when the request is to remove one: `tmux.run("unbind-key", "<key>")` or `set-option -gu <option>` does it for the running server.
