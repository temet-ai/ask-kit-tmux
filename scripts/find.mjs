export const meta = {
  purpose:
    "Search the text of every pane (scrollback included) for a pattern: 'which pane has the error', 'where did that stack trace appear', 'which pane printed Listening on'. Identical lines in one pane count once. Secrets are masked before the search, so a masked value cannot be searched for.",
  params: { pattern: "regex, case-insensitive", lines: "how many lines of each pane to search, default 500, most 2000", session: "limit to one session, optional", context: "lines of context around each match, default 0, most 5", caseSensitive: "true for an exact-case search", socket: "another tmux server, optional" },
  returns: "{pattern, searched, panesWithMatches, matches:[{target, id, command, lines, count, text, before?, after?}], more, maskedLines}",
  example: 'await scripts.run("find", { pattern: "error|failed", context: 1 })',
};

export default async function ({ tmux }, { pattern, lines = 500, session, context = 0, caseSensitive = false, socket } = {}) {
  if (!pattern) throw new Error("give pattern, a regular expression");
  const t = socket ? tmux.at(String(socket)) : tmux;
  const r = await t.search(pattern, { lines, session, context, caseSensitive });
  return { ...r, ...(r.maskedLines ? { note: `${r.maskedLines} lines had secrets masked before the search` } : {}) };
}
