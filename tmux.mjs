// A client for a running tmux server through the `tmux` command: sessions, windows and panes, what
// runs in each, what a pane shows, and (when the caller asked for a change) keys, new and killed
// sessions, windows and panes, resizing, and reloading the config.
//
// Four checks. A call that changes tmux needs `act` (the caller asked for a change); what a pane
// shows goes to a cloud model, so captured text and every other output is masked for secrets and
// the number of masked lines is counted; commands that never end here (attach, choosers, popups,
// prompts, wait-for) are refused in every ask; and every tmux call has a timeout.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const deny = (why) => {
  throw new Error(`not allowed: ${why}`);
};
const notInThisAsk = (what) => {
  throw new Error(`not in this ask: ${what} changes things, and the caller did not ask for a change (act: true), so nothing was done. Answer what you can, and say that this needs \`ask\` with act: true. Do not look for another way to do it.`);
};

// ---------------------------------------------------------------------------------------------
// Masking. Pane text can hold anything a person typed or a program printed.
// ---------------------------------------------------------------------------------------------
const NAME_WORDS = "password|passwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credentials?|auth[_-]?key|session[_-]?key|client[_-]?secret|cookie";
const NAMED_VALUE = new RegExp(`\\b([A-Za-z0-9_.-]*(?:${NAME_WORDS})[A-Za-z0-9_.-]*|pass|pwd)(["']?\\s*[=:]\\s*)(["']?)([^\\s"',;]{2,})`, "gi");
const FLAG_VALUE = /(--?(?:password|passwd|passphrase|pass|token|secret|api-?key|auth|access-?key|client-secret)[= ]+)(["']?)([^\s"']+)/gi;
const ENV_LINE = /^(\s*(?:export\s+)?)([A-Z][A-Z0-9_]*)=(.*)$/;
const ENV_SECRET_NAME = /KEY|TOKEN|SECRET|PASS|AUTH|CRED|PRIVATE|COOKIE|SALT|SIGN|DSN|BEARER/;
const AUTH_HEADER = /\b((?:proxy-)?authorization|set-cookie|cookie|x-api-key|x-auth-token)(\s*:\s*)(.+)$/i;
const BEARER = /\b(bearer|basic|token)(\s+)([A-Za-z0-9._~+/=-]{8,})/gi;
const URL_USER = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi;
const TOKENS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, /\bAIza[A-Za-z0-9_-]{30,}\b/g,
  /\bey[A-Za-z0-9_-]{8,}\.ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, /\bnpm_[A-Za-z0-9]{30,}\b/g, /\bhf_[A-Za-z0-9]{30,}\b/g,
];
const PEM_BEGIN = /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE|ENCRYPTED)[A-Z ]*-----/;
const PEM_END = /-----END [A-Z ]*-----/;
const looksRandom = (v) => v.length >= 24 && /[A-Za-z]/.test(v) && /\d/.test(v) && /^[A-Za-z0-9+/=_-]+$/.test(v);

/** Mask what looks like a secret. Returns {text, masked}: the text and how many lines changed. */
export function maskText(text) {
  const out = [];
  let masked = 0;
  let inPem = false;
  for (const line of String(text ?? "").split("\n")) {
    let l = line;
    if (inPem) {
      if (PEM_END.test(l)) inPem = false;
      out.push("***");
      masked++;
      continue;
    }
    if (PEM_BEGIN.test(l)) {
      inPem = !PEM_END.test(l.slice(l.search(PEM_BEGIN) + 10));
      out.push("*** private key or certificate block ***");
      masked++;
      continue;
    }
    const env = l.match(ENV_LINE);
    if (env && (ENV_SECRET_NAME.test(env[2]) || looksRandom(env[3].replace(/^["']|["']$/g, "")))) l = `${env[1]}${env[2]}=***`;
    else {
      l = l.replace(AUTH_HEADER, "$1$2***");
      l = l.replace(NAMED_VALUE, "$1$2$3***");
      l = l.replace(FLAG_VALUE, "$1$2***");
      l = l.replace(BEARER, "$1$2***");
      l = l.replace(URL_USER, "$1***@");
      for (const re of TOKENS) l = l.replace(re, "***");
    }
    if (l !== line) masked++;
    out.push(l);
  }
  return { text: out.join("\n"), masked };
}

// ---------------------------------------------------------------------------------------------
// Which tmux commands read, which change, which never end.
// ---------------------------------------------------------------------------------------------
// Option letters that take a value, per command (only for commands that can read).
const VALUE_FLAGS = {
  "capture-pane": "bEFSt", "display-message": "cdFt", "list-sessions": "Ff", "list-windows": "Fft", "list-panes": "Fft", "list-clients": "Fft",
  "list-keys": "FNPT", "show-options": "t", "show-window-options": "t", "show-environment": "t", "show-hooks": "t", "has-session": "t", "list-commands": "F", "show-messages": "t",
};
const READS = new Set([
  "list-sessions", "list-windows", "list-panes", "list-clients", "list-commands", "list-keys", "show-options", "show-window-options", "show-hooks",
  "show-environment", "show-messages", "has-session", "server-info",
]);
// Commands that wait for a person, hold a client, or never end: refused in every ask.
const NEVER = {
  "attach-session": "attaching never ends here", "switch-client": "it needs an attached client", "choose-buffer": "it waits for a person", "choose-client": "it waits for a person",
  "choose-tree": "it waits for a person", "customize-mode": "it waits for a person", "copy-mode": "it leaves the pane in a mode that waits for a person", "command-prompt": "it waits for a person",
  "confirm-before": "it waits for a person", "display-menu": "it waits for a person", "display-popup": "it waits for a person", "display-panes": "it waits for a person",
  "clock-mode": "it leaves the pane in a mode that never ends", "wait-for": "it waits until another command signals", "kill-server": "it ends every session; kill the session instead",
  "pipe-pane": "it keeps a command running on the pane's output", "lock-server": "it locks the screen", "lock-session": "it locks the screen", "lock-client": "it locks the screen",
  "suspend-client": "it suspends a client", "run-shell": "run a command in a pane (send-keys) instead", "if-shell": "run a command in a pane (send-keys) instead",
  "show-buffer": "a tmux buffer can hold what the person copied, a password included", "list-buffers": "a tmux buffer can hold what the person copied, a password included",
  "save-buffer": "a tmux buffer can hold what the person copied", "load-buffer": "it reads a file into the clipboard buffer", "paste-buffer": "it pastes the clipboard buffer into a pane",
  "set-buffer": "it writes the clipboard buffer", "delete-buffer": "it changes the clipboard buffer", "show-prompt-history": "it can hold what the person typed at the tmux prompt",
  "clear-prompt-history": "it changes the prompt history", "start-server": "a question never starts a server", "server-access": "it changes who may use the server", "choose-window": "it waits for a person", "choose-session": "it waits for a person",
};

function getopt(rest, valueLetters = "") {
  const flags = new Set();
  const values = {};
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    const x = rest[i];
    if (x === "--") { pos.push(...rest.slice(i + 1)); break; }
    if (/^-[A-Za-z]/.test(x)) {
      for (let j = 1; j < x.length; j++) {
        const c = x[j];
        flags.add(c);
        if (valueLetters.includes(c)) {
          values[c] = x.length > j + 1 ? x.slice(j + 1) : rest[++i];
          break;
        }
      }
    } else pos.push(x);
  }
  return { flags, values, pos };
}

/** Split a tmux config line into words: quotes group, # starts a comment. */
function tokenize(line) {
  const out = [];
  let cur = "";
  let q = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === q) q = null;
      else if (c === "\\" && q === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
    } else if (c === '"' || c === "'") { q = c; has = true; }
    else if (c === "#" && !has && !cur) break;
    else if (/\s/.test(c)) { if (cur || has) out.push(cur); cur = ""; has = false; }
    else if (c === "\\" && i + 1 < line.length) cur += line[++i];
    else cur += c;
  }
  if (cur || has) out.push(cur);
  return out;
}

let COMMANDS = null; // {name, alias}[] from `tmux list-commands`, cached per process

/** Resolve a command name, alias or unique prefix to tmux's canonical name. */
function canonical(word) {
  const list = COMMANDS ?? [];
  const exact = list.find((c) => c.name === word || c.alias === word);
  if (exact) return exact.name;
  const prefix = list.filter((c) => c.name.startsWith(word));
  if (prefix.length === 1) return prefix[0].name;
  if (prefix.length > 1) deny(`'${word}' is ambiguous (${prefix.map((c) => c.name).join(", ")})`);
  deny(`unknown tmux command '${word}'`);
}

function check(args, act) {
  const a = args.map(String);
  if (!a.length) deny("no tmux command");
  if (a[0].startsWith("-")) deny("pass a tmux command first; the server is chosen by the TMUX_SOCKET setting, not by flags");
  for (const x of a) {
    if (x === ";" || (x.endsWith(";") && !x.endsWith("\\;"))) deny("an argument ending in ';' would start a second tmux command; use tmux.send(...) for text, which escapes it");
    if (x.includes("\0")) deny("a NUL character in an argument");
  }
  const cmd = canonical(a[0]);
  const rest = a.slice(1);
  if (NEVER[cmd]) deny(`tmux ${cmd}: ${NEVER[cmd]}`);
  if (cmd === "new-session" && !getopt(rest, "ceEfFnstxy").flags.has("d")) deny("tmux new-session without -d attaches, which never ends here; add -d");
  let changing = true;
  if (READS.has(cmd)) changing = false;
  else if (cmd === "display-message") changing = !getopt(rest, VALUE_FLAGS[cmd]).flags.has("p");
  else if (cmd === "capture-pane") {
    const o = getopt(rest, VALUE_FLAGS[cmd]);
    changing = !o.flags.has("p") || o.flags.has("b");
  }
  if (!act) {
    if (changing) notInThisAsk(`tmux ${[cmd, ...rest].join(" ").slice(0, 80)}`);
    if (rest.some((x) => x.includes("#("))) notInThisAsk("a tmux format with #( (it runs a shell command)");
  }
  return { a: [cmd, ...rest], cmd, changing };
}

// ---------------------------------------------------------------------------------------------
// Running tmux and ps
// ---------------------------------------------------------------------------------------------
const home = (p) => String(p).replace(/^~(?=\/|$)/, process.env.HOME ?? os.homedir());

function socketArgs(socket) {
  const s = String(socket ?? "").trim();
  if (!s) return [];
  return s.includes("/") || s.startsWith("~") ? ["-S", home(s)] : ["-L", s];
}

function execProgram(file, args, { timeoutMs, env }) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 32 << 20, encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] }, (err, stdout, stderr) => {
      if (err?.code === "ENOENT") resolve({ code: 127, out: "", err: `${file} is not installed`, timedOut: false });
      else resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: stdout ?? "", err: stderr ?? "", timedOut: !!err?.killed });
    });
  });
}

const SEP = "\x1f";
const clip = (s, n) => (s == null ? s : String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

/** "1-02:03:04", "03:04", "04" -> seconds. */
function etimeSeconds(t) {
  if (!t) return null;
  const m = String(t).trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  return (+(m[1] ?? 0)) * 86400 + (+(m[2] ?? 0)) * 3600 + (+m[3]) * 60 + +m[4];
}
export function human(sec) {
  if (sec == null) return null;
  sec = Math.max(0, Math.round(sec));
  if (sec < 90) return `${sec}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  if (sec < 172800) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}

/** A date as ISO text in the machine's own time zone, with its offset. */
export function localIso(d) {
  const x = new Date(d);
  const off = -x.getTimezoneOffset();
  const pad = (n) => String(Math.trunc(Math.abs(n))).padStart(2, "0");
  const local = new Date(x.getTime() + off * 60000).toISOString().slice(0, 19);
  return `${local}${off >= 0 ? "+" : "-"}${pad(off / 60)}:${pad(off % 60)}`;
}

const SHELL = /^-?(?:ba|z|fi|da|a|k|tc|c|mk)?sh$|^-?(?:nu|nushell|xonsh|elvish|pwsh|login)$/;
const PROMPTS = [
  /\[(?:y\/n|yes\/no|Y\/n|y\/N)\]\s*[?:]?\s*$/i, /\((?:y\/n|yes\/no|Y\/n|y\/N)\)\s*[?:]?\s*$/i, /\b(?:password|passphrase|passcode)[^:\n]{0,40}:\s*$/i,
  /\b(?:press|hit) (?:enter|return|any key|a key)\b/i, /\bcontinue\?\s*(?:\[[^\]]*\])?\s*$/i, /\bproceed\?\s*(?:\[[^\]]*\])?\s*$/i, /\benter (?:a |the |your )?\w[\w ]{0,30}:\s*$/i,
  /\boverwrite\b.*\?\s*$/i, /\bare you sure\b.*\?\s*$/i, /\bselect\b.*:\s*$/i, /^\s*\?\s+.+›?\s*$/, /^\s*(?:\(Use arrow keys\)|❯|>)\s*$/,
];

export function make({ settings, push, cwd, act }) {
  return makeTmux({ socket: settings?.TMUX_SOCKET ?? process.env.TMUX_SOCKET ?? "", push, act: !!act });
}

export function makeTmux({ socket = "", push = () => {}, act = false, timeoutMs = 10_000 } = {}) {
  const sock = socketArgs(socket);
  const sockLabel = String(socket).trim() || "default";

  const ensureCommands = async () => {
    if (COMMANDS) return;
    const r = await execProgram("tmux", ["list-commands", "-F", `#{command_list_name}${SEP}#{command_list_alias}`], { timeoutMs, env: {} });
    COMMANDS = r.out.split("\n").filter(Boolean).map((l) => {
      const [name, alias] = l.split(SEP);
      return { name, alias: alias || null };
    });
    if (!COMMANDS.length && r.code === 127) COMMANDS = null;
  };

  const run = async (...args) => {
    await ensureCommands();
    if (!COMMANDS) return { code: 127, out: "", err: "tmux is not installed", masked: 0 };
    const { a } = check(args, act);
    const started = Date.now();
    const r = await execProgram("tmux", ["-u", ...sock, ...a], { timeoutMs, env: { LC_ALL: process.env.LC_ALL || "C.UTF-8" } });
    const o = maskText(r.out);
    const e = maskText(r.err.slice(0, 4000));
    push({ kind: "tmux", detail: `tmux ${a.join(" ")}`.slice(0, 200), ms: Date.now() - started, code: r.code, size: r.out.length });
    return { code: r.code, out: o.text, err: e.text, masked: o.masked + e.masked, ...(r.timedOut ? { timedOut: true } : {}) };
  };
  const text = async (...args) => {
    const r = await run(...args);
    if (r.code !== 0) throw new Error(`tmux ${args.slice(0, 3).join(" ")}: ${(r.err || r.out).trim().slice(0, 500)}`);
    return r.out.replace(/\n+$/, "");
  };
  const noServer = (r) => /no server running|error connecting|No such file or directory|no sessions/i.test(r.err + r.out);
  const lines = (s) => (s ? s.split("\n").filter(Boolean) : []);
  const target = (t) => {
    const s = String(t ?? "");
    if (!s || s.startsWith("-") || /[\n\0]/.test(s)) deny(`not a pane, window or session target: ${JSON.stringify(s).slice(0, 60)}`);
    return s;
  };

  // A pane id ("%3") for any target: "%3", "session", "session:2", "session:2.1".
  const resolve = async (t) => {
    const r = await run("display-message", "-p", "-t", target(t), "#{pane_id}");
    const id = r.out.trim();
    if (r.code !== 0 || !/^%\d+$/.test(id)) throw new Error(`no such pane: ${t}${r.err ? ` (${r.err.trim().slice(0, 120)})` : ""}`);
    return id;
  };

  // ps: one call, every process with its tty. Used for "what runs in the pane, since when".
  const psRows = async () => {
    const r = await execProgram("ps", ["-axo", "pid=,ppid=,pgid=,tpgid=,stat=,etime=,tty=,args="], { timeoutMs, env: { LC_ALL: "C" } });
    if (r.code !== 0) return [];
    return lines(r.out).map((l) => {
      const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
      return m ? { pid: +m[1], ppid: +m[2], pgid: +m[3], tpgid: +m[4], stat: m[5], seconds: etimeSeconds(m[6]), tty: m[7], args: m[8] } : null;
    }).filter(Boolean);
  };

  const FIELDS = [
    "pane_id", "session_name", "window_index", "window_name", "window_id", "pane_index", "pane_active", "window_active", "pane_current_command", "pane_pid", "pane_current_path",
    "pane_title", "pane_dead", "pane_dead_status", "pane_dead_signal", "pane_width", "pane_height", "pane_in_mode", "pane_tty", "window_activity", "session_attached", "pane_start_command", "pane_last_activity",
  ];
  const FORMAT = FIELDS.map((f) => `#{${f}}`).join(SEP);

  const parsePane = (l) => {
    const v = l.split(SEP);
    const f = Object.fromEntries(FIELDS.map((k, i) => [k, v[i]]));
    return f;
  };

  const api = {
    /** The tmux server this client talks to: "default" or the TMUX_SOCKET setting. */
    socket: sockLabel,
    /** True when this ask may change things. */
    act,
    run,
    text,
    /** The same client for another tmux server: tmux.at("name") is `-L name`, tmux.at("/path/to/socket") is `-S path`. */
    at(other) {
      return makeTmux({ socket: other, push, act, timeoutMs });
    },

    async server() {
      const r = await run("display-message", "-p", `#{pid}${SEP}#{socket_path}${SEP}#{version}${SEP}#{start_time}${SEP}#{session_name}`);
      const ps = await run("list-clients", "-F", "#{client_tty}");
      if (r.code !== 0) {
        return { socket: sockLabel, running: false, reason: (r.err || r.out).trim().slice(0, 200), tmuxVersion: (await execProgram("tmux", ["-V"], { timeoutMs, env: {} })).out.trim(), insideTmux: !!process.env.TMUX };
      }
      const [pid, socketPath, version, start] = r.out.trim().split(SEP);
      const up = start ? Math.round(Date.now() / 1000 - +start) : null;
      return { socket: sockLabel, running: true, pid: +pid, socketPath, version, started: start ? localIso(+start * 1000) : null, upSeconds: up, up: human(up), clients: ps.code === 0 ? lines(ps.out).length : null, insideTmux: !!process.env.TMUX };
    },

    /** Every pane (o.session: one session's; o.window: one window's), with the program in the foreground, its process id and age. */
    async panes(o = {}) {
      const scope = o.session ? ["-s", "-t", target(o.session)] : o.window ? ["-t", target(o.window)] : ["-a"];
      const r = await run("list-panes", ...scope, "-F", FORMAT);
      if (r.code !== 0) {
        if (noServer(r)) return [];
        throw new Error(`tmux list-panes: ${(r.err || r.out).trim().slice(0, 300)}`);
      }
      const rows = lines(r.out).map(parsePane);
      const ps = await psRows();
      const now = Date.now() / 1000;
      return rows.map((f) => {
        const tty = String(f.pane_tty).replace(/^\/dev\//, "");
        const onTty = ps.filter((p) => p.tty === tty);
        const fg = onTty.find((p) => p.pid === p.tpgid && p.tpgid > 0) ?? onTty.find((p) => p.stat.includes("+") && p.pgid === p.pid) ?? null;
        const shellPid = +f.pane_pid;
        const shell = ps.find((p) => p.pid === shellPid);
        const dead = f.pane_dead === "1";
        const idleShell = !dead && fg && SHELL.test(path.basename(fg.args.split(/\s+/)[0] ?? "")) && fg.pid === shellPid && !/\s-\w*c\b/.test(fg.args);
        return {
          id: f.pane_id,
          target: `${f.session_name}:${f.window_index}.${f.pane_index}`,
          session: f.session_name,
          window: { index: +f.window_index, name: f.window_name, id: f.window_id },
          pane: +f.pane_index,
          active: f.pane_active === "1" && f.window_active === "1",
          command: f.pane_current_command,
          pid: shellPid,
          cwd: f.pane_current_path,
          title: f.pane_title,
          size: `${f.pane_width}x${f.pane_height}`,
          dead,
          ...(dead ? { exitStatus: f.pane_dead_status === "" ? null : +f.pane_dead_status, exitSignal: f.pane_dead_signal === "" ? null : +f.pane_dead_signal } : {}),
          inMode: f.pane_in_mode === "1",
          tty,
          startedWith: clip(String(f.pane_start_command).replace(/^"|"$/g, ""), 120) || null,
          paneAge: shell?.seconds != null ? human(shell.seconds) : null,
          paneAgeSeconds: shell?.seconds ?? null,
          foreground: fg ? { pid: fg.pid, command: maskText(clip(fg.args, 200)).text, age: human(fg.seconds), ageSeconds: fg.seconds, idleShell: !!idleShell } : null,
          windowIdleSeconds: f.window_activity ? Math.max(0, Math.round(now - +f.window_activity)) : null,
          sessionAttached: +f.session_attached || 0,
        };
      });
    },

    /** Sessions with their windows: {name, id, windows, attached, created, windowList:[{index, name, panes, active, layout}]}. */
    async sessions() {
      const s = await run("list-sessions", "-F", ["#{session_name}", "#{session_id}", "#{session_windows}", "#{session_attached}", "#{session_created}", "#{session_group}"].join(SEP));
      if (s.code !== 0) {
        if (noServer(s)) return [];
        throw new Error(`tmux list-sessions: ${(s.err || s.out).trim().slice(0, 300)}`);
      }
      const w = await run("list-windows", "-a", "-F", ["#{session_name}", "#{window_index}", "#{window_name}", "#{window_panes}", "#{window_active}", "#{window_flags}", "#{window_activity}", "#{window_zoomed_flag}"].join(SEP));
      const wins = lines(w.out).map((l) => l.split(SEP));
      const now = Date.now() / 1000;
      return lines(s.out).map((l) => {
        const [name, id, windows, attached, created, group] = l.split(SEP);
        return {
          name, id, windows: +windows, attached: +attached, created: localIso(+created * 1000), age: human(now - +created), ...(group ? { group } : {}),
          windowList: wins.filter((x) => x[0] === name).map((x) => ({ index: +x[1], name: x[2], panes: +x[3], active: x[4] === "1", flags: x[5], idle: human(now - +x[6]), zoomed: x[7] === "1" })),
        };
      });
    },

    /** The last `lines` lines of a pane (scrollback included), masked. {target, text, lines, masked, cut}. */
    async capture(t, o = {}) {
      const n = Math.max(1, Math.min(2000, Math.floor(o.lines ?? 100)));
      const args = ["capture-pane", "-p", "-J", "-t", target(t), "-S", `-${n}`];
      if (o.alternate) args.push("-a");
      const r = await run(...args);
      if (r.code !== 0) throw new Error(`tmux capture-pane ${t}: ${(r.err || r.out).trim().slice(0, 300)}`);
      let all = r.out.replace(/\s+$/, "").replace(/^(?:[ \t]*\n)+/, "").split("\n");
      if (all.length === 1 && all[0] === "") all = [];
      all = all.filter((l, i) => l.trim() || (i > 0 && all[i - 1].trim())); // runs of blank lines (screen padding) become one
      const cut = Math.max(0, all.length - n);
      const kept = all.slice(cut);
      while (kept.length && !kept[0].trim()) kept.shift();
      return { target: String(t), text: kept.join("\n"), lines: kept.length, masked: r.masked, ...(cut ? { cut } : {}) };
    },

    /** Search every pane's last `lines` lines for a regex. Identical lines in one pane are one match with a count. {matches:[{target, command, lines, count, text, before, after}], panes, searched, masked, more}. */
    async search(pattern, o = {}) {
      let re;
      try { re = new RegExp(String(pattern), o.caseSensitive ? "" : "i"); } catch (e) { throw new Error(`not a regular expression: ${e.message}`); }
      const ps = (await api.panes(o.session ? { session: o.session } : {})).filter((p) => !p.dead || o.dead !== false);
      const maxPanes = o.maxPanes ?? 60;
      const matches = [];
      let maskedLines = 0;
      let panesWith = 0;
      const ctx = Math.max(0, Math.min(5, o.context ?? 0));
      const maxMatches = o.max ?? 40;
      let more = 0;
      for (const p of ps.slice(0, maxPanes)) {
        const c = await api.capture(p.id, { lines: o.lines ?? 500 });
        maskedLines += c.masked;
        const ls = c.text.split("\n");
        const byText = new Map();
        ls.forEach((text, i) => {
          if (!re.test(text)) return;
          const key = text.trim();
          const hit = byText.get(key);
          if (hit) { hit.count++; if (hit.lines.length < 5) hit.lines.push(i + 1 + (c.cut ?? 0)); return; }
          byText.set(key, { target: p.target, id: p.id, command: p.command, lines: [i + 1 + (c.cut ?? 0)], count: 1, text: clip(text, 240), ...(ctx ? { before: ls.slice(Math.max(0, i - ctx), i).map((x) => clip(x, 200)), after: ls.slice(i + 1, i + 1 + ctx).map((x) => clip(x, 200)) } : {}) });
        });
        if (byText.size) panesWith++;
        let shown = 0;
        for (const m of byText.values()) {
          if (matches.length >= maxMatches || shown >= (o.perPane ?? 8)) { more++; continue; }
          matches.push(m);
          shown++;
        }
      }
      return { pattern: String(pattern), searched: Math.min(ps.length, maxPanes), panesTotal: ps.length, panesWithMatches: panesWith, matches, more, maskedLines };
    },

    /** Poll a pane until its text stops changing for `quietMs` (default 1500) or `timeoutMs` (default 15000, max 60000). */
    async settle(t, o = {}) {
      const quiet = o.quietMs ?? 1500;
      const limit = Math.min(60_000, o.timeoutMs ?? 15_000);
      const start = Date.now();
      let last = null;
      let since = Date.now();
      let cur;
      for (;;) {
        cur = await api.capture(t, { lines: o.lines ?? 60 });
        if (cur.text !== last) { last = cur.text; since = Date.now(); }
        if (Date.now() - since >= quiet) return { ...cur, settled: true, waitedMs: Date.now() - start };
        if (Date.now() - start >= limit) return { ...cur, settled: false, waitedMs: Date.now() - start };
        await new Promise((r) => setTimeout(r, 250));
      }
    },

    /** Is the pane's program waiting for input, running, idle at a shell prompt or exited? */
    async state(t) {
      const id = await resolve(t);
      const p = (await api.panes({ window: id })).find((x) => x.id === id);
      if (!p) throw new Error(`no such pane: ${t}`);
      const cap = await api.capture(p.id, { lines: 12 });
      const tail = cap.text.split("\n").filter((x) => x.trim()).slice(-6);
      const base = { target: p.target, id: p.id, command: p.command, foreground: p.foreground, cwd: p.cwd, idleSeconds: p.windowIdleSeconds, lastLines: tail, masked: cap.masked };
      if (p.dead) return { ...base, state: "exited", exitStatus: p.exitStatus, exitSignal: p.exitSignal, evidence: "tmux marks the pane dead (remain-on-exit keeps its text)" };
      if (p.foreground?.idleShell) return { ...base, state: "idle-at-prompt", evidence: `the foreground process is the pane's shell (${p.command}, pid ${p.pid}); nothing else runs in it` };
      const prompt = tail.slice(-3).find((l) => PROMPTS.some((re) => re.test(l)));
      let wchan = null;
      if (p.foreground && process.platform === "linux") {
        try { wchan = fs.readFileSync(`/proc/${p.foreground.pid}/wchan`, "utf8").trim(); } catch { /* not readable */ }
      }
      const readsTty = wchan && /n_tty_read|wait_woken|tty_read/.test(wchan);
      if (prompt) return { ...base, state: "waiting-for-input", evidence: `the last lines look like a prompt: ${JSON.stringify(clip(prompt, 120))}`, wchan };
      if (readsTty) return { ...base, state: "waiting-for-input", evidence: `${p.foreground.command} is blocked reading the terminal (kernel wait: ${wchan})`, wchan };
      return { ...base, state: "running", evidence: p.foreground ? `${clip(p.foreground.command, 80)} (pid ${p.foreground.pid}) has run for ${p.foreground.age}` : `${p.command} has no foreground process group`, wchan };
    },

    /** The config files tmux loaded and the settings and bindings in them: see scripts/config.mjs. */
    async configFiles() {
      const r = await run("display-message", "-p", "#{config_files}");
      const loaded = r.code === 0 ? r.out.trim().split(",").map((x) => x.trim()).filter(Boolean) : [];
      const candidates = [home("~/.tmux.conf"), home("~/.config/tmux/tmux.conf"), "/etc/tmux.conf", ...(process.env.XDG_CONFIG_HOME ? [path.join(process.env.XDG_CONFIG_HOME, "tmux/tmux.conf")] : [])];
      const seen = new Set();
      const files = [];
      for (const f of [...loaded, ...candidates]) {
        if (seen.has(f)) continue;
        seen.add(f);
        files.push({ path: f, exists: fs.existsSync(f), loaded: loaded.includes(f) });
      }
      return files;
    },

    /**
     * What the tmux config sets and where. {socket, files, prefix, prefix2, set:[{option, scope, value, file, line, text}],
     * bindings:[{table, key, command, file, line}], unbound, sourced, runtime}. o.key keeps only what mentions it; o.all lists every binding tmux has loaded.
     */
    async config(o = {}) {
      await ensureCommands();
      const files = await api.configFiles();
      const loaded = files.filter((f) => f.loaded);
      const start = loaded.length ? loaded : files.filter((f) => f.exists).slice(0, 1);
      const directives = [];
      const seen = new Set();
      const scan = (file, depth) => {
        if (depth > 4 || seen.has(file)) return;
        seen.add(file);
        let raw;
        try { raw = fs.readFileSync(file, "utf8"); } catch { return; }
        const src = raw.split("\n");
        for (let i = 0; i < src.length; i++) {
          let line = src[i];
          const first = i + 1;
          while (/\\\s*$/.test(line) && i + 1 < src.length) line = line.replace(/\\\s*$/, " ") + src[++i];
          const toks = tokenize(line);
          if (!toks.length) continue;
          let cmd;
          try { cmd = canonical(toks[0]); } catch { continue; }
          const rest = toks.slice(1);
          const text = clip(maskText(line.trim()).text, 200);
          if (cmd === "set-option" || cmd === "set-window-option") {
            const g = getopt(rest, "t");
            const name = g.pos[0];
            if (!name) continue;
            const scope = cmd === "set-window-option" || g.flags.has("w") ? "window" : g.flags.has("s") ? "server" : g.flags.has("p") ? "pane" : "session";
            directives.push({ kind: "set", option: name, scope: g.flags.has("g") ? `${scope} (global)` : scope, unset: g.flags.has("u"), value: g.pos.slice(1).join(" "), file, line: first, text });
          } else if (cmd === "bind-key") {
            const g = getopt(rest, "NT");
            if (!g.pos.length) continue;
            directives.push({ kind: "bind", table: g.values.T ?? (g.flags.has("n") ? "root" : "prefix"), key: g.pos[0], command: g.pos.slice(1).join(" "), file, line: first, text });
          } else if (cmd === "unbind-key") {
            const g = getopt(rest, "T");
            if (g.flags.has("a")) directives.push({ kind: "unbind", table: g.values.T ?? "prefix", key: "(all)", file, line: first, text });
            else if (g.pos.length) directives.push({ kind: "unbind", table: g.values.T ?? (g.flags.has("n") ? "root" : "prefix"), key: g.pos[0], file, line: first, text });
          } else if (cmd === "source-file") {
            const g = getopt(rest, "t");
            for (const f of g.pos) {
              const abs = path.resolve(path.dirname(file), home(f));
              directives.push({ kind: "source", target: abs, exists: fs.existsSync(abs), file, line: first, text });
              if (fs.existsSync(abs)) scan(abs, depth + 1);
            }
          } else if (cmd === "set-hook" || cmd === "set-environment" || cmd === "run-shell") {
            directives.push({ kind: cmd === "run-shell" ? "run" : cmd.replace("set-", ""), file, line: first, text });
          }
        }
      };
      for (const f of start) scan(f.path, 0);

      const sc = async (...a) => { const r = await run(...a); return r.code === 0 ? r.out : ""; };
      const running = (await run("display-message", "-p", "#{pid}")).code === 0;
      const map = {};
      if (running) {
        for (const out of [await sc("show-options", "-g"), await sc("show-options", "-gw"), await sc("show-options", "-s")])
          for (const l of lines(out)) { const m = l.match(/^(\S+)\s?(.*)$/); if (m && !(m[1] in map)) map[m[1]] = m[2]; }
      }
      const keysOut = running ? await sc("list-keys") : "";
      const bound = lines(keysOut).map((l) => {
        const toks = tokenize(l);
        const g = getopt(toks.slice(1), "T");
        return { table: g.values.T, key: g.pos[0], command: g.pos.slice(1).join(" ") };
      });

      const want = o.key ? new RegExp(String(o.key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : null;
      const lastSet = new Map();
      for (const d of directives.filter((x) => x.kind === "set")) lastSet.set(d.option.replace(/^-/, ""), d);
      const set = [...lastSet.values()].map((d) => ({ option: d.option, scope: d.scope, ...(d.unset ? { unset: true } : { value: d.value }), runtime: map[d.option] ?? null, file: d.file, line: d.line }));
      const lastBind = new Map();
      for (const d of directives.filter((x) => x.kind === "bind")) lastBind.set(`${d.table}\0${d.key}`, d);
      const unbound = directives.filter((x) => x.kind === "unbind").map((d) => ({ table: d.table, key: d.key, file: d.file, line: d.line }));
      let bindings = [...lastBind.values()].map((d) => {
        const live = bound.find((b) => b.table === d.table && b.key === d.key);
        return { table: d.table, key: d.key, command: live?.command ?? d.command, live: !!live, file: d.file, line: d.line };
      });
      let all = [];
      if (o.all) all = bound.map((b) => ({ ...b, ...(lastBind.has(`${b.table}\0${b.key}`) ? { file: lastBind.get(`${b.table}\0${b.key}`).file, line: lastBind.get(`${b.table}\0${b.key}`).line } : {}) }));
      const keep = (x) => !want || want.test(`${x.option ?? ""} ${x.value ?? ""} ${x.key ?? ""} ${x.command ?? ""} ${x.text ?? ""}`);
      const cap = 80;
      const filteredSet = set.filter(keep), filteredBind = bindings.filter(keep), filteredAll = all.filter(keep);
      const live = want ? Object.entries(map).filter(([k, v]) => want.test(`${k} ${v}`)).slice(0, 40).map(([option, value]) => ({ option, value: maskText(value).text })) : undefined;
      return {
        socket: sockLabel,
        running,
        files: files.filter((f) => f.exists || f.loaded),
        sourced: directives.filter((d) => d.kind === "source").map((d) => ({ target: d.target, exists: d.exists, from: `${d.file}:${d.line}` })),
        prefix: map.prefix ?? null,
        prefix2: map.prefix2 ?? null,
        set: filteredSet.slice(0, cap),
        bindings: filteredBind.slice(0, cap),
        unbound: unbound.filter(keep).slice(0, cap),
        hooksAndEnvironment: directives.filter((d) => ["hook", "environment", "run"].includes(d.kind)).filter(keep).slice(0, 20).map((d) => ({ kind: d.kind, file: d.file, line: d.line, text: d.text })),
        ...(o.all ? { allBindings: filteredAll.slice(0, 100).map((b) => `${b.table} ${b.key}: ${b.command}${b.file ? ` (${b.file}:${b.line})` : ""}`), allBindingsTotal: filteredAll.length } : {}),
        ...(live ? { runtimeOptions: live } : {}),
        cut: { set: Math.max(0, filteredSet.length - cap), bindings: Math.max(0, filteredBind.length - cap) },
        note: !files.some((f) => f.exists) ? "no tmux config file exists: tmux runs with its defaults" : !running ? "no tmux server is running: the files are read, the live values are not" : undefined,
      };
    },

    // ------------------------------------------------------------------ changing calls (act only)
    /** Type text into a pane and press Enter (enter: false to leave it unsent). Text is sent literally, so it is never read as key names. */
    async send(t, textToSend, o = {}) {
      if (!act) notInThisAsk("tmux send-keys");
      const id = await resolve(t);
      const p = (await api.panes({ window: id })).find((x) => x.id === id);
      if (!p) throw new Error(`no such pane: ${t}`);
      if (p.dead) throw new Error(`pane ${p.target} has exited (status ${p.exitStatus}); respawn it or open a new one`);
      if (p.inMode) await run("send-keys", "-t", p.id, "-X", "cancel");
      let s = String(textToSend);
      if (s.endsWith(";")) s = `${s.slice(0, -1)}\\;`;
      if (s.length) await text("send-keys", "-t", p.id, "-l", "--", s);
      if (o.enter !== false) await text("send-keys", "-t", p.id, "Enter");
      return { sent: true, target: p.target, id: p.id, text: maskText(String(textToSend)).text, enter: o.enter !== false };
    },
    /** Send named keys: tmux.keys("%3", "C-c"), tmux.keys("%3", "q"), tmux.keys("%3", "Up", "Enter"). */
    async keys(t, ...names) {
      if (!act) notInThisAsk("tmux send-keys");
      const tt = target(t);
      for (const k of names) if (/;$/.test(String(k)) && !/\\;$/.test(String(k))) deny("use tmux.send to type a ';'");
      await text("send-keys", "-t", tt, ...names.map(String));
      return { sent: true, target: tt, keys: names };
    },
    async newSession(name, o = {}) {
      if (!act) notInThisAsk("tmux new-session");
      const args = ["new-session", "-d", "-P", "-F", "#{session_name}", "-s", target(name)];
      if (o.cwd) args.push("-c", home(o.cwd));
      if (o.window) args.push("-n", String(o.window));
      if (o.command) args.push(String(o.command));
      return { created: await text(...args) };
    },
    async newWindow(session, o = {}) {
      if (!act) notInThisAsk("tmux new-window");
      const args = ["new-window", "-d", "-P", "-F", "#{session_name}:#{window_index}", "-t", `${target(session)}:`];
      if (o.name) args.push("-n", String(o.name));
      if (o.cwd) args.push("-c", home(o.cwd));
      if (o.command) args.push(String(o.command));
      return { created: await text(...args) };
    },
    async split(t, o = {}) {
      if (!act) notInThisAsk("tmux split-window");
      const args = ["split-window", "-d", "-P", "-F", "#{pane_id} #{session_name}:#{window_index}.#{pane_index}", o.horizontal === false ? "-v" : "-h", "-t", target(t)];
      if (o.cwd) args.push("-c", home(o.cwd));
      if (o.size) args.push("-l", String(o.size));
      if (o.command) args.push(String(o.command));
      return { created: await text(...args) };
    },
    /** kind: "session" | "window" | "pane". */
    async kill(kind, t) {
      if (!act) notInThisAsk(`tmux kill-${kind}`);
      const cmd = { session: "kill-session", window: "kill-window", pane: "kill-pane" }[kind];
      if (!cmd) throw new Error('kind is "session", "window" or "pane"');
      await text(cmd, "-t", target(t));
      return { killed: kind, target: String(t) };
    },
    /** kind: "session" | "window". */
    async rename(kind, t, name) {
      if (!act) notInThisAsk(`tmux rename-${kind}`);
      const cmd = { session: "rename-session", window: "rename-window" }[kind];
      if (!cmd) throw new Error('kind is "session" or "window"');
      await text(cmd, "-t", target(t), String(name));
      return { renamed: String(t), to: String(name) };
    },
    /** Select a pane or window. */
    async select(t) {
      if (!act) notInThisAsk("tmux select-pane");
      const tt = target(t);
      await text(/^%\d+$|\.\d+$/.test(tt) ? "select-pane" : "select-window", "-t", tt);
      return { selected: tt };
    },
    /** Resize a pane: {width, height} in cells, or {zoom: true}. */
    async resize(t, o = {}) {
      if (!act) notInThisAsk("tmux resize-pane");
      const args = ["resize-pane", "-t", target(t)];
      if (o.zoom) args.push("-Z");
      if (o.width) args.push("-x", String(Math.floor(o.width)));
      if (o.height) args.push("-y", String(Math.floor(o.height)));
      await text(...args);
      return { resized: String(t), ...o };
    },
    /** Re-read the config file(s): `source-file` on the files tmux loaded, or the first default one that exists. */
    async reload(file) {
      if (!act) notInThisAsk("tmux source-file");
      let f = file ? home(file) : null;
      if (!f) {
        const files = await api.configFiles();
        f = (files.find((x) => x.loaded) ?? files.find((x) => x.exists))?.path;
      }
      if (!f || !fs.existsSync(f)) throw new Error("no tmux config file found; name one: tmux.reload('~/.config/tmux/tmux.conf')");
      const r = await run("source-file", f);
      return { file: f, ok: r.code === 0, error: r.code === 0 ? null : (r.err || r.out).trim().slice(0, 500) };
    },
  };
  return api;
}
