export const meta = {
  purpose:
    "What a pane shows right now or showed recently: its last lines, scrollback included, with secrets masked and the number of masked lines said. Takes a pane target (%3, session:2.0) or a regex that picks panes by program, folder or window name ('what did the build print').",
  params: { target: "a pane id (%3), session:window.pane or session:window", match: "instead of target: a regex over command, folder, title or window name; the first 4 matching panes are captured", lines: "last N lines, default 80, most 2000", socket: "another tmux server, optional" },
  returns: "{captures:[{target, command, cwd, text, lines, masked, cut?}], maskedLines, note?}",
  example: 'await scripts.run("capture", { target: "build:1.0", lines: 40 })',
};

export default async function ({ tmux }, { target, match, lines = 80, socket } = {}) {
  const t = socket ? tmux.at(String(socket)) : tmux;
  let picks;
  if (target) {
    const inWindow = await t.panes({ window: target });
    const one = inWindow.find((x) => x.id === target || x.target === target) ?? inWindow.find((x) => x.active) ?? inWindow[0];
    if (!one) throw new Error(`no such pane: ${target}`);
    picks = [one];
  } else if (match) {
    const re = new RegExp(String(match), "i");
    picks = (await t.panes()).filter((p) => [p.foreground?.command, p.command, p.cwd, p.title, p.window.name, p.session].some((v) => v && re.test(v))).slice(0, 4);
    if (!picks.length) return { captures: [], maskedLines: 0, note: `no pane matches ${match}; run the overview script to see every pane` };
  } else throw new Error("give target (a pane) or match (a regex)");
  const captures = [];
  let maskedLines = 0;
  for (const p of picks) {
    const c = await t.capture(p.id, { lines });
    maskedLines += c.masked;
    captures.push({ target: p.target, command: p.foreground?.command ?? p.command, cwd: p.cwd, text: c.text, lines: c.lines, masked: c.masked, ...(c.cut ? { cut: c.cut } : {}) });
  }
  return { captures, maskedLines, ...(maskedLines ? { note: `${maskedLines} lines had secrets masked` } : {}) };
}
