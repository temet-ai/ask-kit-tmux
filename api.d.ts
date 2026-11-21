interface RunResult { code: number; out: string; err: string; masked: number; timedOut?: boolean } // out and err are already masked for secrets; masked is how many lines changed
interface Foreground { pid: number; command: string; age: string; ageSeconds: number | null; idleShell: boolean } // the program holding the pane's terminal; idleShell: it is the pane's own interactive shell and nothing runs under it
interface Pane {
  id: string;            // "%3", stable while the pane lives; the safest target
  target: string;        // "session:window.pane" (the window index counts from base-index)
  session: string; window: { index: number; name: string; id: string }; pane: number;
  active: boolean;       // the active pane of the active window of its session
  command: string;       // tmux's short name of the program (15 characters)
  pid: number;           // the pane's first process (usually the shell)
  cwd: string; title: string; size: string; // size: "120x30"
  dead: boolean; exitStatus?: number | null; exitSignal?: number | null; // dead: the program exited and remain-on-exit keeps the pane
  inMode: boolean;       // in copy mode or another mode
  tty: string; startedWith: string | null; // startedWith: the command the pane was created with, null for a plain shell
  paneAge: string | null; paneAgeSeconds: number | null; // how long the pane's first process has run
  foreground: Foreground | null; // null for a dead pane. command is the full command line, masked
  windowIdleSeconds: number | null; // seconds since the window last printed anything
  sessionAttached: number;
}
interface PaneState {
  target: string; id: string; command: string; foreground: Foreground | null; cwd: string; idleSeconds: number | null; lastLines: string[]; masked: number; wchan?: string | null;
  state: "exited" | "idle-at-prompt" | "waiting-for-input" | "running"; evidence: string; exitStatus?: number | null; exitSignal?: number | null;
}

declare const tmux: {
  socket: string; // "default" or the TMUX_SOCKET setting
  act: boolean;   // true when this ask may change things

  // Any tmux command, no shell: pass each argument separately. tmux.run("list-windows", "-a", "-F", "#{window_name}").
  // Output is masked for secrets. Never throws on a non-zero exit. It throws for:
  //  - a command that changes tmux (send-keys, new-window, kill-pane, set-option, source-file ...) when tmux.act is false;
  //  - what never ends or waits for a person, in every ask: attach, switch-client, copy-mode, choose-*, display-popup, command-prompt, wait-for, run-shell, pipe-pane;
  //  - the clipboard buffers (show-buffer, list-buffers): they can hold a password;
  //  - a first argument that is a flag (the server comes from TMUX_SOCKET), an argument ending in ";" (it would start a second command), and a format with #( when not acting.
  // `capture-pane` needs -p and no -b to count as reading. Prefer tmux.capture.
  run(...args: string[]): Promise<RunResult>;
  // As run, but returns stdout (trailing newlines removed) and throws tmux's own error on a non-zero exit.
  text(...args: string[]): Promise<string>;

  // The same client for another tmux server: a socket name ("work" is tmux -L work) or a path ("/tmp/x/sock" is tmux -S).
  // A question that names a socket is answered there.
  at(socket: string): typeof tmux;

  // The server: running false (with a reason) when none answers on this socket.
  server(): Promise<{ socket: string; running: boolean; pid?: number; socketPath?: string; version?: string; started?: string | null; upSeconds?: number | null; up?: string | null; clients?: number | null; insideTmux: boolean; reason?: string; tmuxVersion?: string }>;

  // Sessions with windows: attached is the number of clients on it; windowList has idle (time since output) and zoomed.
  sessions(): Promise<{ name: string; id: string; windows: number; attached: number; created: string; age: string | null; group?: string; windowList: { index: number; name: string; panes: number; active: boolean; flags: string; idle: string | null; zoomed: boolean }[] }[]>;

  // Every pane, with the program in the foreground (its pid and age from ps). session: only that session; window: only the window a target names
  // (a pane id such as "%3" gives its window). Returns [] when no server runs.
  panes(o?: { session?: string; window?: string }): Promise<Pane[]>;

  // The last `lines` lines of a pane (default 100, most 2000), scrollback included, wrapped lines joined, trailing blanks removed, secrets masked.
  // cut: lines dropped above (when the pane had more). alternate: true reads a full-screen program's saved normal screen.
  capture(target: string, o?: { lines?: number; alternate?: boolean }): Promise<{ target: string; text: string; lines: number; masked: number; cut?: number }>;

  // A regex over the last `lines` lines (default 500) of every pane, or of one session. Masking comes first, so a masked value cannot be found.
  // Identical lines in one pane are one match with count and the first line numbers. perPane (default 8) and max (default 40) cap the list; more counts what was left out.
  search(pattern: string, o?: { lines?: number; session?: string; context?: number; caseSensitive?: boolean; max?: number; perPane?: number; maxPanes?: number; dead?: boolean }):
    Promise<{ pattern: string; searched: number; panesTotal: number; panesWithMatches: number; matches: { target: string; id: string; command: string; lines: number[]; count: number; text: string; before?: string[]; after?: string[] }[]; more: number; maskedLines: number }>;

  // Poll a pane until its text has not changed for quietMs (default 1500) or timeoutMs passes (default 15000, most 60000). settled says which. Use after tmux.send to read the result.
  settle(target: string, o?: { quietMs?: number; timeoutMs?: number; lines?: number }): Promise<{ target: string; text: string; lines: number; masked: number; settled: boolean; waitedMs: number }>;

  // exited (dead pane, with exitStatus), idle-at-prompt (the pane's own shell, nothing under it), waiting-for-input (the last lines look like a prompt,
  // or the program is blocked reading the terminal), running. evidence says which. A program that waits without printing a prompt shows as running.
  state(target: string): Promise<PaneState>;

  // The config files tmux loaded, and the usual ones that exist but are not loaded.
  configFiles(): Promise<{ path: string; exists: boolean; loaded: boolean }[]>;
  // What the config files set and where, with tmux's value now: see scripts/config.mjs. Reads the files; key narrows by text.
  config(o?: { key?: string; all?: boolean }): Promise<any>;

  // ---- changing calls: each throws "not in this ask" unless tmux.act is true ----
  // Type text into a pane literally and press Enter (enter: false leaves it unsent). Cancels copy mode first. Refuses a dead pane.
  // What is typed runs in whatever the pane holds, so name the pane by id (%3) and check tmux.state(target) first.
  send(target: string, text: string, o?: { enter?: boolean }): Promise<{ sent: boolean; target: string; id: string; text: string; enter: boolean }>;
  // Named keys: tmux.keys("%3", "C-c"), tmux.keys("%3", "Up", "Enter"), tmux.keys("%3", "q").
  keys(target: string, ...keys: string[]): Promise<{ sent: boolean; target: string; keys: string[] }>;
  newSession(name: string, o?: { cwd?: string; window?: string; command?: string }): Promise<{ created: string }>; // detached
  newWindow(session: string, o?: { name?: string; cwd?: string; command?: string }): Promise<{ created: string }>; // detached; created is "session:index"
  split(target: string, o?: { horizontal?: boolean; cwd?: string; size?: string | number; command?: string }): Promise<{ created: string }>; // detached; created is "%id session:window.pane"
  kill(kind: "session" | "window" | "pane", target: string): Promise<{ killed: string; target: string }>;
  rename(kind: "session" | "window", target: string, name: string): Promise<{ renamed: string; to: string }>;
  select(target: string): Promise<{ selected: string }>;
  resize(target: string, o: { width?: number; height?: number; zoom?: boolean }): Promise<any>;
  // source-file on the files tmux loaded (or the first config that exists), or on the one named.
  reload(file?: string): Promise<{ file: string; ok: boolean; error: string | null }>;
};
