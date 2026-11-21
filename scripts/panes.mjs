export const meta = {
  purpose:
    "Find the panes that run a program or sit in a folder: 'where is the dev server running', 'which pane has vim open', 'what runs in /path/to/project'. Matches a regex against each pane's command line, folder, title, window and session name; returns the pane, its program, process id, folder and age.",
  params: { match: "regex (case-insensitive) over command line, folder, title, window name and session name; leave out for every pane", session: "limit to one session, optional", limit: "most panes to return, default 30", socket: "another tmux server, optional" },
  returns: "{match, found, panes:[{target, id, window, command, pid, cwd, ran, title, state, matched}], cut?}",
  example: 'await scripts.run("panes", { match: "vite|webpack|npm run dev" })',
};

export default async function ({ tmux }, { match, session, limit = 30, socket } = {}) {
  const t = socket ? tmux.at(String(socket)) : tmux;
  let re = null;
  if (match) {
    try { re = new RegExp(String(match), "i"); } catch (e) { throw new Error(`match is not a regular expression: ${e.message}`); }
  }
  const all = await t.panes(session ? { session } : {});
  const rows = [];
  for (const p of all) {
    const fields = { command: p.foreground?.command ?? p.command, cwd: p.cwd, title: p.title, window: p.window.name, session: p.session, started: p.startedWith ?? "" };
    const hit = re ? Object.entries(fields).find(([, v]) => v && re.test(v))?.[0] : "all";
    if (!hit) continue;
    rows.push({
      target: p.target, id: p.id, window: p.window.name, command: p.foreground?.command ?? p.command, pid: p.foreground?.pid ?? p.pid, cwd: p.cwd,
      ran: p.foreground?.age ?? p.paneAge, title: p.title, state: p.dead ? `exited (status ${p.exitStatus ?? "?"})` : p.foreground?.idleShell ? "shell, idle at prompt" : "running", matched: hit,
    });
  }
  return { match: match ?? null, found: rows.length, panes: rows.slice(0, limit), ...(rows.length > limit ? { cut: rows.length - limit } : {}), searched: all.length };
}
