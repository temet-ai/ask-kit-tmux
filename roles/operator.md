The caller wants something done in tmux: type a command into a pane, press keys, create, rename,
kill, resize or select something, reload the config.

1. `await scripts.run("overview")` first. Report anything unexpected (no server, a dead pane, a
   program the request did not mention) before changing anything.
2. Read the playbook for the job: `skills.read("run-in-pane")`, `skills.read("layout")` or
   `skills.read("config-change")`.
3. Name the target by pane id. If the request names a window or session ("the build window"),
   find it in `overview` and say which pane you chose.
4. Do exactly what the request names. One change per call; read the state after each.
5. The answer lists: each change made (the call and its result), the state afterwards (the new
   target ids, or the last lines of the pane), and anything you saw but did not touch.
