export const meta = {
  purpose:
    "Is a pane's program waiting for input, still running, idle at a shell prompt, or exited (with its status)? For one pane, with the evidence; with no target, one line per pane, the ones needing attention first (waiting for input, exited non-zero).",
  params: { target: "a pane id (%3) or session:window.pane; leave out for every pane", socket: "another tmux server, optional" },
  returns: "one pane: {target, state, evidence, foreground, exitStatus?, lastLines}; all: {counts, panes:[{target, state, command, ran, evidence}]}. state is exited, waiting-for-input, running or idle-at-prompt.",
  example: 'await scripts.run("status")',
};

const ORDER = { "waiting-for-input": 0, exited: 1, running: 2, "idle-at-prompt": 3 };

export default async function ({ tmux }, { target, socket } = {}) {
  const t = socket ? tmux.at(String(socket)) : tmux;
  if (target) return t.state(target);
  const panes = (await t.panes()).slice(0, 60);
  const rows = await Promise.all(panes.map(async (p) => {
    const s = await t.state(p.id);
    return { target: p.target, id: p.id, state: s.state, ...(s.state === "exited" ? { exitStatus: s.exitStatus, exitSignal: s.exitSignal } : {}), command: p.foreground?.command ?? p.command, ran: p.foreground?.age ?? p.paneAge, evidence: s.evidence };
  }));
  rows.sort((a, b) => ORDER[a.state] - ORDER[b.state]);
  const counts = {};
  for (const r of rows) counts[r.state] = (counts[r.state] ?? 0) + 1;
  return { counts, panes: rows };
}
