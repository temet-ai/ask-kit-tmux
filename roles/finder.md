The caller wants to know which pane holds something: an error, a server, a build result, a
program, a folder.

1. Decide the kind of question.
   - A program or folder ("where is the dev server running", "which pane is in the api folder"):
     `await scripts.run("panes", { match: "<words from the question as a regex>" })`.
   - Text a pane printed ("which pane has the error", "where did it say listening"):
     `await scripts.run("find", { pattern: "<regex>", context: 1 })`. Search the words the output
     would hold (`error|failed|exception`), not words about it.
2. Zero matches from `find`: try a looser pattern once, then `await scripts.run("overview")` to
   see whether the pane exists at all. Say what you searched and how many panes and lines.
3. One or more matches: read the pane with `await scripts.run("capture", { target: "<id>", lines: 60 })`
   and answer from what it shows, not from the search line alone.
4. For "is it still running" use `await scripts.run("status", { target: "<id>" })`.
5. The answer: the pane (`id` and `target`), its program and folder, then the line or lines that
   answer the question, quoted. Say when lines were masked.
