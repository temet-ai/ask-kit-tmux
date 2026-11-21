# ask-kit-tmux

An [ask-kit](https://github.com/temet-ai/ask-kit) kit that lets your coding agent's `ask` tool
answer questions about tmux as it is now: which sessions, windows and panes exist, what runs in
each pane, what a pane shows, whether its program waits for input or has exited, and what the
tmux config sets. It also types into panes and creates, renames, kills and resizes things when
asked. A cheap model runs `tmux` outside your agent's context and answers with pane ids,
process ids and `path:line`.

Questions from its bench, of the kinds agents answer by hand with `tmux`:

- Which pane printed an error about the night shift roster, and in which session and window?
- Is any pane waiting for input? Which one, and what does it ask?
- Which config file and line set the tmux prefix?

## Install

You need [ask-kit](https://github.com/temet-ai/ask-kit#set-it-up) and `tmux` on PATH.

Paste this into your agent:

```
Read ~/.config/ask-kit/AGENTS.md, then add this kit: github.com/temet-ai/ask-kit-tmux
```

Or run it yourself:

```sh
ask-kit kit install temet-ai/ask-kit-tmux        # shows what it reads, changes and runs
ask-kit kit install temet-ai/ask-kit-tmux --yes  # installs and enables it
```

Restart your agents so `ask` lists `tmux`. It uses the default tmux server. To use another one,
set `TMUX_SOCKET` to a socket name (`tmux -L name`) or a socket path (`tmux -S path`), in the
environment or under `domains.tmux.settings` in the ask-kit config. A question that names a
socket is answered on that socket.

## What it carries

| | |
|---|---|
| Scripts | `overview` (the server, every session, window and pane with its program, folder and age), `panes` (which panes run a program or sit in a folder), `capture` (what a pane shows), `find` (which pane printed a pattern), `status` (waiting for input, running, idle at a prompt or exited), `config` (what the tmux config sets, with file and line) |
| Skills | `run-in-pane`, `layout`, `config-change`: playbooks the investigator loads when the job calls for one |
| Roles | `finder` for which pane has something; `operator` for requests to type, create, kill or reload |

Each script also runs with no model: `ask-kit run tmux overview`, or `ask(do: "tmux.overview")`
from an agent.

## What it can change

When the request asks for a change, it types text or keys into a pane, creates sessions, windows
and panes (detached), renames, kills, selects and resizes them, sets options and key bindings on
the running server, and reloads the config file. A question never changes anything: `tmux.mjs`
sorts every tmux command into reading or changing, resolving aliases and abbreviations first
(`killp` is `kill-pane`), and a changing command is refused unless the caller asked for a change
(`act`). The kit does not edit config files; the `dotfiles` kit does.

`tmux.mjs` also checks each command before it runs:

- Pane text goes to a cloud model, so captured text and all other tmux output is masked first:
  tokens and keys with known prefixes, `password=` and similar values, `Authorization` headers,
  cookies, private key blocks, URL passwords, and `.env`-style lines that name a secret. The
  answer carries the number of masked lines. A masked value cannot be searched for.
- Nothing attaches or waits: `attach`, `switch-client`, `copy-mode`, choosers, popups, prompts,
  `wait-for`, `run-shell` and `pipe-pane` are refused in every ask, and `new-session` must be
  detached. Every tmux call has a timeout of 10 seconds.
- The tmux clipboard buffers (`show-buffer`, `list-buffers`) are refused, because they can hold
  what the person copied.
- An argument ending in `;` (it would start a second tmux command) and a format containing `#(`
  (it runs a shell command) are refused.

Typing into a pane runs whatever is typed in whatever that pane holds. The instructions tell the
investigator to check the pane's state first, and to kill only what the request names.

## How well it works

`bench/questions.json` holds six questions and two script runs (run `bench/make-fixture.sh`
first to start the tmux server they ask about, and `bench/make-fixture.sh stop` after), each with
patterns its answer must hold. It has not been run on a model yet; `ask-kit kit test tmux` runs it.
