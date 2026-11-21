export const meta = {
  purpose:
    "What the tmux config sets and where: the config files tmux loaded (and the ones that exist but are not loaded), the prefix, every option and key binding the files set with the file and line, what tmux has now for each, and files sourced from them. With key, only what mentions a word ('mouse', 'split-window', 'C-a', 'status').",
  params: { key: "keep only options, bindings and live options that mention this text, optional", all: "true to list every key binding tmux has loaded (defaults included), capped at 100", socket: "another tmux server, optional" },
  returns: "{socket, running, files:[{path, exists, loaded}], sourced, prefix, prefix2, set:[{option, scope, value, runtime, file, line}], bindings:[{table, key, command, live, file, line}], unbound, hooksAndEnvironment, runtimeOptions?, allBindings?, cut, note?}",
  example: 'await scripts.run("config", { key: "prefix" })',
};

export default async function ({ tmux }, { key, all = false, socket } = {}) {
  const t = socket ? tmux.at(String(socket)) : tmux;
  return t.config({ key, all });
}
