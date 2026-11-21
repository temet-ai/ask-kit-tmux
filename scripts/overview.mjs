export const meta = {
  purpose:
    "What tmux holds right now: which server is in use, and every session with its windows and panes, each pane with the program in its foreground, its process id, folder and how long it has run. The first call for 'what is running in tmux', 'which sessions and windows exist'.",
  params: { session: "limit to one session, optional", socket: "another tmux server (a socket name or path), optional; the default is the TMUX_SOCKET setting" },
  returns: "{server, sessions:[{name, attached, age, windows:[{index, name, active, panes:[{target, id, active, command, pid, cwd, ran, state, size}]}]}], counts:{sessions, windows, panes, dead}, cut?}",
  example: 'await scripts.run("overview")',
};

export default async function ({ tmux }, { session, socket } = {}) {
  const t = socket ? tmux.at(String(socket)) : tmux;
  const server = await t.server();
  if (!server.running) return { server, sessions: [], counts: { sessions: 0, windows: 0, panes: 0, dead: 0 }, note: "no tmux server is running on this socket" };
  const sessions = (await t.sessions()).filter((s) => !session || s.name === session);
  const panes = await t.panes(session ? { session } : {});
  let budget = 120;
  let cut = 0;
  const out = sessions.map((s) => ({
    name: s.name,
    attached: s.attached,
    age: s.age,
    windows: s.windowList.map((w) => ({
      index: w.index,
      name: w.name,
      active: w.active,
      idle: w.idle,
      panes: panes.filter((p) => p.session === s.name && p.window.index === w.index).flatMap((p) => {
        if (budget-- <= 0) { cut++; return []; }
        return [{
          target: p.target, id: p.id, active: p.active, command: p.foreground?.command ?? p.command, pid: p.foreground?.pid ?? p.pid, cwd: p.cwd,
          ran: p.foreground?.age ?? p.paneAge, size: p.size,
          state: p.dead ? `exited (status ${p.exitStatus ?? "?"})` : p.foreground?.idleShell ? "shell, idle at prompt" : "running",
        }];
      }),
    })),
  }));
  return {
    server,
    sessions: out,
    counts: { sessions: sessions.length, windows: sessions.reduce((n, s) => n + s.windows, 0), panes: panes.length, dead: panes.filter((p) => p.dead).length },
    ...(cut ? { cut } : {}),
  };
}
