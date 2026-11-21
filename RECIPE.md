# Recipe: tmux kit

## What it answers

tmux as it is now: which sessions, windows and panes exist, what runs in each pane (program, pid,
folder, how long), what a pane shows or showed recently, which pane printed a pattern, whether a
pane's program waits for input or has exited, which server is in use, and what the config sets and
where. It changes things when asked: type into a pane, create, rename, kill, select and resize
sessions, windows and panes, set options and bindings live, reload the config.

## What it needs

- `tmux` and `ps` on PATH. Every call runs with the user's rights.
- Optional setting `TMUX_SOCKET`: a socket name (`-L`) or path (`-S`); empty means the default server.

## What it reads and runs

- Runs `tmux` (no shell) through `tmux.mjs`, with `-u`, and `ps` once per question to find each
  pane's foreground process and age. Reads the tmux config files and the files they source.
- Masks secrets in every output (pane text, process command lines, option values, config lines).
- Refuses what never ends (attach, choosers, popups, prompts, wait-for, run-shell, pipe-pane),
  the clipboard buffers, an argument ending in `;`, and `#(` in a format. Every call has a timeout.

## Rebuild it from an empty folder

Write `ask-kit.toml` with one `module` source named `tmux`, a `TMUX_SOCKET` setting with an empty
default, `requires = ["tmux"]`, and `acts` written as prose: the module holds the changing calls
back (the host cannot tell `display-message -p` from `display-message`, or `capture-pane -p` from
`capture-pane`). The module exports `make({settings, push, cwd, act})` returning a client with
`run(...args)` and `text(...args)` (each call resolved to tmux's canonical command name through
`tmux list-commands`, then classified as reading, changing or never allowed), `at(socket)`,
`server()`, `sessions()`, `panes(o)` (list-panes with one format string, joined with the `ps`
table by tty), `capture`, `search`, `settle`, `state`, `config` and the acting calls `send`, `keys`,
`newSession`, `newWindow`, `split`, `kill`, `rename`, `select`, `resize`, `reload`. Describe it
exactly in `api.d.ts`.

Scripts: `overview`, `panes`, `capture`, `find`, `status`, `config`. Skills: `run-in-pane`,
`layout`, `config-change`. Roles: `finder`, `operator`. `instructions.md`: start from a script,
name panes by id, treat masked text as masked, check a pane's state before typing into it.

## Bench

`bench/questions.json`: six questions of the kinds agents answer by hand with tmux, put to the
server that `bench/make-fixture.sh` starts on the socket `askkit-fixture`, and two script runs.
