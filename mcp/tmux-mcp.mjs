#!/usr/bin/env node
/**
 * tmux-mcp — zero-dependency MCP (stdio) server that lets Claude drive tmux.
 *
 * Why: Claude Code's Bash tool runs in a sandboxed, non-interactive shell.
 * This server lets Claude work through your live tmux instead — inspect
 * panes, read server logs, type keystrokes, and run commands in your real
 * environment where you can watch (and interrupt) everything it does.
 *
 * Tools:
 *   whoami        — where this Claude session lives (server/session/window/pane)
 *   list_servers  — discover all tmux servers (sockets) for this user
 *   list_panes    — map sessions/windows/panes; opt-in process/port info
 *   capture_pane  — read a pane's screen + scrollback, optional grep
 *   find_in_panes — grep a regex across every pane's scrollback (all servers)
 *   tail          — incremental read: only output that's new since last call
 *   send_keys     — literal text and/or key presses (Enter, C-c, Up, ...)
 *   run_command   — run a foreground command, return output + exit code;
 *                   no target = reusable "claude-scratch" window on the
 *                   floating-scratch server (view via the scratch popup)
 *   wait_for      — poll a pane until a regex shows up
 *   wait_silence  — wait until a pane stops producing output
 *   new_window    — spawn a detached scratch window, returns its pane id
 *
 * Multi-server: tmux runs one server per socket (`tmux -L <name>`). Every
 * tool accepts an optional `server` (socket name from list_servers, or an
 * absolute socket path); omitted = the default server. Pane ids are only
 * unique within one server.
 *
 * Register with Claude Code (user scope = every project):
 *   claude mcp add -s user tmux -- node ~/.config/tmux/mcp/tmux-mcp.mjs
 * Remove:
 *   claude mcp remove -s user tmux
 *
 * Optional env: TMUX_MCP_SOCKET (tmux -L <name>) or TMUX_MCP_SOCKET_PATH (tmux -S <path>)
 * set the default server; TMUX_TMPDIR is honored for socket discovery.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const SERVER_INFO = { name: "tmux", version: "1.7.1" };
const SUPPORTED_PROTOCOLS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
const LATEST_PROTOCOL = "2025-06-18";
const MAX_CHARS = 50_000;
const SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash", "ksh", "tcsh", "ash", "nu"]);
const SCRATCH_WINDOW = "claude-scratch";
// The user's floating-scratch tmux server (opened via their display-popup
// binding). Targetless run_command puts its scratch window there, inside the
// float session named after the main session hosting this Claude — so the
// user can watch it through the popup they already have.
const SCRATCH_SERVER = process.env.TMUX_MCP_SCRATCH_SERVER || "floats";
const SCRATCH_CONF = process.env.TMUX_MCP_SCRATCH_CONF || join(homedir(), ".config/tmux/floats.conf");
// Command guard: guard.json screens everything typed through this server —
// run_command always, send_keys whenever it submits a line. `deny` patterns
// match anywhere in the command and always block; a non-empty `allow` list
// additionally restricts run_command to full-matching commands. The file is
// re-read on every call so edits apply immediately. If it is missing or
// unparseable, DEFAULT_DENY applies (keep it in sync with guard.json).
const GUARD_PATH = process.env.TMUX_MCP_GUARD || join(homedir(), ".config/tmux/mcp/guard.json");
const DEFAULT_DENY = [
  "rm -rf", "rm -fr", "rm -Rf", "rm -fR", "rm -rR", "rm -Rr", "rm -r ", "rm -R ",
  "sudo rm", "sudo su",
  "shred ", "mkfs", "wipefs", "dd if=", "dd of=", "of=/dev/",
  "diskutil eraseDisk", "diskutil eraseVolume",
  "chmod -R 777", "chmod 777 /",
  "git push --force", "git push -f", "git reset --hard", "git clean -f", "git branch -D",
  "find * -delete", "-exec rm",
  "truncate -s 0",
  "kubectl delete namespace", "kubectl delete ns ",
  "helm uninstall", "helm delete",
  "terraform destroy",
  "DROP TABLE", "DROP DATABASE", "FLUSHALL", "FLUSHDB",
];
// Pane + socket hosting the Claude Code session that spawned this server (if inside tmux).
const SELF_PANE = process.env.TMUX_PANE || null;
const SELF_SOCKET = process.env.TMUX ? process.env.TMUX.split(",")[0] : null;
const DEBUG = !!process.env.TMUX_MCP_DEBUG;

const ENV_SOCK = process.env.TMUX_MCP_SOCKET
  ? ["-L", process.env.TMUX_MCP_SOCKET]
  : process.env.TMUX_MCP_SOCKET_PATH
    ? ["-S", process.env.TMUX_MCP_SOCKET_PATH]
    : [];

// `server` param → tmux socket args: a -L socket name (see list_servers) or an
// absolute -S socket path. Omitted → the env-configured or default server.
function sockFor(server) {
  if (typeof server === "string" && server.trim()) {
    return server.includes("/") ? ["-S", server] : ["-L", server];
  }
  return ENV_SOCK;
}

const tmpDir = () => join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid()}`);

function sockPath(sock) {
  if (sock[0] === "-S") return sock[1];
  return join(tmpDir(), sock[0] === "-L" ? sock[1] : "default");
}

async function isSelfSocket(sock) {
  if (!SELF_SOCKET) return false;
  const p = sockPath(sock);
  const [a, b] = await Promise.all([
    realpath(p).catch(() => p),
    realpath(SELF_SOCKET).catch(() => SELF_SOCKET),
  ]);
  return a === b;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd}: ${(stderr || err.message).trim()}`));
      else resolve(stdout);
    });
  });
}

const tmux = (sock, ...args) =>
  run("tmux", [...sock, ...args]).catch((e) => {
    throw new Error(e.message.replace(/^tmux:/, `tmux ${args[0]}:`));
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clampInt(v, min, max, dflt) {
  const n = Number.isFinite(+v) ? Math.round(+v) : dflt;
  return Math.min(max, Math.max(min, n));
}

function requireStr(v, name) {
  if (typeof v !== "string" || !v.trim()) throw new Error(`missing required string param: ${name}`);
}

function tailChars(s, max = MAX_CHARS) {
  if (s.length <= max) return s;
  return `[... truncated, showing last ${max} of ${s.length} chars ...]\n` + s.slice(-max);
}

async function paneInfo(sock, target) {
  const out = await tmux(
    sock, "display-message", "-p", "-t", target,
    "#{pane_id}\t#{history_size}\t#{cursor_y}\t#{pane_current_command}\t#{pane_in_mode}\t#{pane_width}\t#{pane_height}"
  );
  const [id, hist, cy, cmd, inMode, w, h] = out.trim().split("\t");
  // tmux 3.6 display-message exits 0 with empty expansions for unknown pane ids
  if (!id || !id.startsWith("%")) throw new Error(`can't find pane: ${target} (see list_panes)`);
  return { id, hist: +hist, cy: +cy, cmd, inMode: inMode === "1", w: +w, h: +h };
}

// Last `lines` lines of a pane (screen + scrollback), wrapped lines joined.
async function capture(sock, target, lines) {
  const out = await tmux(sock, "capture-pane", "-p", "-J", "-t", target, "-S", `-${lines}`);
  let ls = out.split("\n").map((l) => l.replace(/\s+$/, ""));
  while (ls.length && !ls[ls.length - 1]) ls.pop();
  if (ls.length > lines) ls = ls.slice(-lines);
  return ls;
}

// Capture from an absolute history line (history_size + cursor_y at mark time) to the bottom.
async function captureSince(sock, target, startAbs) {
  const { hist } = await paneInfo(sock, target);
  const out = await tmux(sock, "capture-pane", "-p", "-J", "-t", target, "-S", String(startAbs - hist));
  return out.split("\n").map((l) => l.replace(/\s+$/, ""));
}

async function guardSelfPane(info, force, sock) {
  if (!SELF_PANE || info.id !== SELF_PANE || force) return;
  if (await isSelfSocket(sock)) {
    throw new Error(
      `pane ${info.id} is running this very Claude Code session — typing into it would feed keys back to Claude. Target another pane (see list_panes), or pass force:true if you really mean it.`
    );
  }
}

// Glob → regex: '*' matches anything, everything else is literal.
function globToRegex(pattern, anchored) {
  const esc = pattern.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === "*" ? ".*" : "\\" + c));
  return new RegExp(anchored ? `^${esc}$` : esc);
}

async function loadGuard() {
  try {
    const cfg = JSON.parse(await readFile(GUARD_PATH, "utf8"));
    return {
      deny: Array.isArray(cfg.deny) ? cfg.deny : [],
      allow: Array.isArray(cfg.allow) ? cfg.allow : [],
      source: GUARD_PATH,
    };
  } catch (e) {
    const why = e.code === "ENOENT" ? "guard.json not found" : `guard.json unreadable: ${e.message}`;
    return { deny: DEFAULT_DENY, allow: [], source: `built-in defaults (${why})` };
  }
}

async function guardCommand(command, { allowlistApplies = true } = {}) {
  const g = await loadGuard();
  for (const pat of g.deny) {
    if (globToRegex(pat, false).test(command)) {
      throw new Error(
        `blocked by the tmux-mcp guard: matches deny pattern "${pat}" (${g.source}). This is user policy, not a transient error — do not rephrase the command to evade it; ask the user to run it themselves or to adjust ${GUARD_PATH}.`
      );
    }
  }
  if (allowlistApplies && g.allow.length) {
    if (!g.allow.some((pat) => globToRegex(pat, true).test(command))) {
      throw new Error(
        `blocked by the tmux-mcp guard: allowlist mode is active and the command matches no allow pattern in ${GUARD_PATH}. This is user policy — ask the user to run it themselves or extend the allowlist.`
      );
    }
  }
}

// All live/dead tmux servers discoverable in the standard socket directory.
async function discoverServers() {
  let entries = [];
  try {
    entries = await readdir(tmpDir(), { withFileTypes: true });
  } catch {}
  const servers = [];
  for (const e of entries) {
    if (!e.isSocket()) continue;
    const socket = join(tmpDir(), e.name);
    try {
      const out = await tmux(["-L", e.name], "list-sessions", "-F", "#{session_name}\t#{session_windows}\t#{session_attached}");
      const sessions = out.trim().split("\n").filter(Boolean).map((l) => {
        const [name, windows, attached] = l.split("\t");
        return { name, windows: +windows, attached: +attached > 0 || undefined };
      });
      servers.push({ server: e.name, socket, sessions });
    } catch {
      servers.push({ server: e.name, socket, dead: true });
    }
  }
  return servers;
}

// Each server to operate on: the named one, or every live one, or the env default.
async function targetServers(server) {
  if (server) return [{ name: server, sock: sockFor(server) }];
  const live = (await discoverServers()).filter((s) => !s.dead);
  if (live.length) return live.map((s) => ({ name: s.server, sock: ["-L", s.server] }));
  return [{ name: ENV_SOCK[1] ?? "default", sock: ENV_SOCK }];
}

async function createWindow(sock, { session, name, cwd } = {}) {
  let ses = session;
  if (!ses) {
    const out = await tmux(sock, "list-sessions", "-F", "#{session_attached}\t#{session_name}");
    const rows = out.trim().split("\n").filter(Boolean).map((l) => l.split("\t"));
    if (!rows.length) throw new Error("no tmux sessions exist");
    ses = (rows.find((r) => r[0] !== "0") || rows[0])[1]; // prefer an attached session
  }
  const idxOut = await tmux(sock, "list-windows", "-t", ses, "-F", "#{window_index}");
  const next = Math.max(...idxOut.trim().split("\n").map(Number)) + 1;
  const args = [
    "new-window", "-d", "-P",
    "-F", "#{pane_id}\t#{session_name}:#{window_index}.#{pane_index}",
    "-t", `${ses}:${next}`, "-n", name || "claude",
  ];
  if (cwd) {
    requireStr(cwd, "cwd");
    args.push("-c", cwd);
  }
  const out = await tmux(sock, ...args);
  const [pid, tgt] = out.trim().split("\t");
  return { pid, tgt };
}

async function waitShellReady(sock, pid) {
  const t0 = Date.now();
  while (Date.now() - t0 < 3000) {
    try {
      if (SHELLS.has((await paneInfo(sock, pid)).cmd)) return;
    } catch {}
    await sleep(150);
  }
}

// Find an idle scratch window to reuse on this server, or create one.
async function scratchWindowOn(sock, session, cwd) {
  try {
    const args = session
      ? ["list-panes", "-s", "-t", `=${session}`, "-F", "#{window_name}\t#{pane_id}\t#{pane_current_command}"]
      : ["list-panes", "-a", "-F", "#{window_name}\t#{pane_id}\t#{pane_current_command}"];
    const out = await tmux(sock, ...args);
    for (const line of out.trim().split("\n")) {
      const [wn, id, cmd] = line.split("\t");
      if (wn === SCRATCH_WINDOW && SHELLS.has(cmd)) return id;
    }
  } catch {} // fall through — createWindow surfaces the real error
  const { pid } = await createWindow(sock, { session, name: SCRATCH_WINDOW, cwd: cwd || undefined });
  await waitShellReady(sock, pid);
  return pid;
}

// The main session this Claude lives in (matches how the user's popup names
// its float sessions), falling back to the attached session, then "scratch".
async function mainSessionName() {
  try {
    if (SELF_PANE && SELF_SOCKET) {
      const n = (await tmux(["-S", SELF_SOCKET], "display-message", "-p", "-t", SELF_PANE, "#{session_name}")).trim();
      if (n) return n;
    }
  } catch {}
  try {
    const out = await tmux(ENV_SOCK, "list-sessions", "-F", "#{session_attached}\t#{session_name}");
    const rows = out.trim().split("\n").filter(Boolean).map((l) => l.split("\t"));
    if (rows.length) return (rows.find((r) => r[0] !== "0") || rows[0])[1];
  } catch {}
  return "scratch";
}

async function selfCwd() {
  try {
    if (SELF_PANE && SELF_SOCKET) {
      return (await tmux(["-S", SELF_SOCKET], "display-message", "-p", "-t", SELF_PANE, "#{pane_current_path}")).trim() || null;
    }
  } catch {}
  return null;
}

// Scratch pane on the user's floating-scratch server: ensure the float
// session for the current main session exists (window 0 stays a plain shell,
// like the popup script creates), then reuse/create the claude-scratch
// window inside it.
async function floatScratchPane() {
  const sock = ["-L", SCRATCH_SERVER];
  const name = await mainSessionName();
  const cwd = await selfCwd();
  try {
    await tmux(sock, "has-session", "-t", `=${name}`);
  } catch {
    const pre = [];
    try {
      await access(SCRATCH_CONF);
      pre.push("-f", SCRATCH_CONF); // only read when this starts the server
    } catch {}
    const args = [...pre, "new-session", "-d", "-s", name];
    if (cwd) args.push("-c", cwd);
    await tmux(sock, ...args);
  }
  const id = await scratchWindowOn(sock, name, cwd);
  return { sock, id, session: name };
}

// pid → children / commands / listening ports, gathered once per list_panes call.
async function processInfo() {
  const children = new Map();
  const cmds = new Map();
  const ps = await run("ps", ["-axo", "pid=,ppid=,command="], { timeout: 5000 });
  for (const line of ps.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = +m[1], ppid = +m[2];
    cmds.set(pid, m[3]);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const ports = new Map();
  try {
    const lf = await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"], { timeout: 5000 });
    let cur = null;
    for (const line of lf.split("\n")) {
      if (line.startsWith("p")) cur = +line.slice(1);
      else if (line.startsWith("n") && cur != null) {
        const pm = line.match(/:(\d+)$/);
        if (pm) {
          if (!ports.has(cur)) ports.set(cur, new Set());
          ports.get(cur).add(+pm[1]);
        }
      }
    }
  } catch {} // lsof unavailable/slow — ports just omitted
  return { children, cmds, ports };
}

function descendants(children, root) {
  const out = [];
  const stack = [...(children.get(root) ?? [])];
  while (stack.length) {
    const pid = stack.pop();
    out.push(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function listServers() {
  const servers = await discoverServers();
  if (!servers.length) return `no tmux server sockets found in ${tmpDir()}`;
  for (const s of servers) {
    if (!s.dead && (await isSelfSocket(["-L", s.server]))) s.claude_session_server = true;
  }
  return JSON.stringify(servers, null, 1);
}

// Where this Claude session itself lives in tmux (from the TMUX/TMUX_PANE env
// inherited at spawn), plus where its targetless scratch commands will go.
async function whoAmI() {
  if (!SELF_PANE || !SELF_SOCKET) {
    return JSON.stringify({
      inside_tmux: false,
      note: "This Claude session was not started inside tmux (no TMUX/TMUX_PANE env). Targetless run_command falls back to the attached session's name for the float session.",
      scratch_server: SCRATCH_SERVER,
    }, null, 1);
  }
  const sock = ["-S", SELF_SOCKET];
  const out = await tmux(
    sock, "display-message", "-p", "-t", SELF_PANE,
    "#{session_name}\t#{window_index}\t#{window_name}\t#{pane_index}\t#{pane_id}\t#{pane_current_path}\t#{pane_width}\t#{pane_height}\t#{?session_attached,1,0}"
  );
  const [ses, wi, wn, pi, id, cwd, w, h, att] = out.trim().split("\t");
  let serverName = SELF_SOCKET;
  try {
    const p = await realpath(SELF_SOCKET).catch(() => SELF_SOCKET);
    const d = await realpath(tmpDir()).catch(() => tmpDir());
    if (p.startsWith(d + "/")) serverName = p.slice(d.length + 1);
  } catch {}
  return JSON.stringify({
    inside_tmux: true,
    server: serverName,
    socket: SELF_SOCKET,
    session: ses,
    window_index: +wi,
    window_name: wn,
    pane_id: id,
    target: `${ses}:${wi}.${pi}`,
    cwd,
    size: `${w}x${h}`,
    session_attached: att === "1",
    scratch_goes_to: { server: SCRATCH_SERVER, float_session: ses, window: SCRATCH_WINDOW },
    note: `pane ${id} is this Claude session's own pane (claude_session_pane) — never send keys to it`,
  }, null, 1);
}

async function panesOf(sock, serverName, procInfo) {
  const fmt = [
    "#{session_name}", "#{window_index}", "#{window_name}", "#{pane_index}",
    "#{pane_id}", "#{pane_current_command}", "#{pane_current_path}",
    "#{?session_attached,1,0}", "#{?window_active,1,0}", "#{?pane_active,1,0}",
    "#{pane_width}", "#{pane_height}", "#{pane_pid}",
  ].join("\t");
  const out = await tmux(sock, "list-panes", "-a", "-F", fmt);
  const self = await isSelfSocket(sock);
  return out.trim().split("\n").filter(Boolean).map((line) => {
    const [ses, wi, wn, pi, id, cmd, cwd, sat, wact, pact, w, h, panePid] = line.split("\t");
    const entry = {
      server: serverName,
      pane_id: id,
      target: `${ses}:${wi}.${pi}`,
      window: wn,
      running: cmd,
      cwd,
      size: `${w}x${h}`,
      is_shell: SHELLS.has(cmd) || undefined,
      focused: (sat === "1" && wact === "1" && pact === "1") || undefined,
      claude_session_pane: (self && SELF_PANE && id === SELF_PANE) || undefined,
    };
    if (procInfo) {
      const pid = +panePid;
      const desc = descendants(procInfo.children, pid);
      const procs = [...new Set(
        desc.map((d) => procInfo.cmds.get(d)).filter(Boolean)
          .map((c) => (c.length > 80 ? c.slice(0, 80) + "…" : c))
      )];
      if (procs.length) entry.processes = procs.slice(0, 6);
      const ports = new Set();
      for (const d of [pid, ...desc]) for (const pt of procInfo.ports.get(d) ?? []) ports.add(pt);
      if (ports.size) entry.listening_ports = [...ports].sort((a, b) => a - b);
    }
    return entry;
  });
}

async function listPanes({ server, processes = false } = {}) {
  const procInfo = processes ? await processInfo() : undefined;
  const servers = await targetServers(server);
  if (server) return JSON.stringify(await panesOf(servers[0].sock, server, procInfo), null, 1);
  const all = [];
  let firstErr;
  for (const s of servers) {
    try {
      all.push(...(await panesOf(s.sock, s.name, procInfo)));
    } catch (e) {
      firstErr = firstErr ?? e; // server died between discovery and listing
    }
  }
  if (!all.length && firstErr) throw firstErr;
  return JSON.stringify(all, null, 1);
}

async function capturePaneTool({ target, lines, grep, server }) {
  requireStr(target, "target");
  const sock = sockFor(server);
  const n = clampInt(lines, 1, 50000, 200);
  const info = await paneInfo(sock, target);
  let ls = await capture(sock, info.id, n);
  let header = `pane ${info.id} (running: ${info.cmd}) — last ${ls.length} lines`;
  if (grep !== undefined) {
    requireStr(grep, "grep");
    let rx;
    try { rx = new RegExp(grep); } catch (e) { throw new Error(`invalid grep regex: ${e.message}`); }
    const hits = ls.filter((l) => rx.test(l));
    header += `; ${hits.length} matching /${grep}/`;
    ls = hits.length ? hits : ["(no matches)"];
  }
  return `${header}\n---\n${tailChars(ls.join("\n"))}`;
}

async function findInPanes({ pattern, lines, server, include_self = false }) {
  requireStr(pattern, "pattern");
  let rx;
  try { rx = new RegExp(pattern); } catch (e) { throw new Error(`invalid regex: ${e.message}`); }
  const n = clampInt(lines, 10, 5000, 300);
  const results = [];
  let searched = 0;
  for (const srv of await targetServers(server)) {
    let panes;
    try {
      panes = await panesOf(srv.sock, srv.name);
    } catch {
      continue;
    }
    for (const p of panes) {
      if (p.claude_session_pane && !include_self) continue; // own conversation text would self-match
      searched++;
      try {
        const ls = await capture(srv.sock, p.pane_id, n);
        const matches = ls.filter((l) => rx.test(l)).slice(-8)
          .map((l) => (l.length > 300 ? l.slice(0, 300) + "…" : l));
        if (matches.length) {
          results.push({ server: p.server, pane_id: p.pane_id, target: p.target, running: p.running, matches });
        }
      } catch {}
    }
  }
  if (!results.length) return `no matches for /${pattern}/ in ${searched} panes searched (last ${n} lines of each)`;
  return `searched ${searched} panes (last ${n} lines of each)\n` + JSON.stringify(results, null, 1);
}

async function tailTool({ target, cursor, lines, server }) {
  requireStr(target, "target");
  const sock = sockFor(server);
  const info = await paneInfo(sock, target);
  const abs = info.hist + info.cy;
  let body;
  if (cursor === undefined || cursor === null || cursor === "") {
    const n = clampInt(lines, 1, 5000, 50);
    body = (await capture(sock, info.id, n)).join("\n");
  } else {
    const c = Math.max(0, Math.floor(+String(cursor).replace(/^@/, "")) || 0);
    if (c > abs) {
      body = "(cursor is ahead of the pane's history — it may have been cleared; showing visible tail)\n" +
        (await capture(sock, info.id, 50)).join("\n");
    } else {
      const ls = await captureSince(sock, info.id, c);
      while (ls.length && !ls[ls.length - 1]) ls.pop();
      body = ls.join("\n") || "(no new output)";
    }
  }
  return `cursor: @${abs} (pass back as \`cursor\` to get only newer output; the boundary line repeats if it was still being written)\n---\n${tailChars(body)}`;
}

async function sendKeys({ target, text, keys, enter = false, snapshot_delay_ms, force = false, server }) {
  requireStr(target, "target");
  const sock = sockFor(server);
  const hasText = typeof text === "string" && text.length > 0;
  const hasKeys = Array.isArray(keys) && keys.length > 0;
  if (!hasText && !hasKeys && !enter) throw new Error("provide text, keys, and/or enter:true");
  // Screen text that is being submitted as a line (deny patterns only — the
  // allowlist doesn't apply to interactive REPL/TUI input).
  const submits = enter || /[\r\n]/.test(text ?? "") ||
    (hasKeys && keys.some((k) => k === "Enter" || k === "C-m" || k === "C-j" || k === "KPEnter"));
  if (hasText && submits) await guardCommand(text, { allowlistApplies: false });
  const info = await paneInfo(sock, target);
  await guardSelfPane(info, force, sock);
  if (info.inMode) await tmux(sock, "send-keys", "-t", info.id, "-X", "cancel").catch(() => {});
  if (hasText) await tmux(sock, "send-keys", "-t", info.id, "-l", "--", text);
  if (hasKeys) {
    for (const k of keys) {
      if (typeof k !== "string" || !k.trim()) throw new Error("keys must be non-empty strings (e.g. \"Enter\", \"C-c\", \"Up\")");
    }
    await tmux(sock, "send-keys", "-t", info.id, "--", ...keys);
  }
  if (enter) await tmux(sock, "send-keys", "-t", info.id, "Enter");
  const delay = clampInt(snapshot_delay_ms, 0, 5000, 300);
  let snap = "";
  if (delay > 0) {
    await sleep(delay);
    const ls = await capture(sock, info.id, 25);
    snap = `\n--- pane ${info.id} after ${delay}ms ---\n${tailChars(ls.join("\n"), 8000)}`;
  }
  return `keys sent to pane ${info.id}.${snap}`;
}

async function runCommand({ target, command, timeout_ms, force = false, server, save_output = false }) {
  requireStr(command, "command");
  let cmd = command.replace(/\s+$/, "");
  const background = /&$/.test(cmd) && !/&&$/.test(cmd);
  if (!background) cmd = cmd.replace(/[;\s]+$/, "");
  await guardCommand(cmd);
  // Interactive-typing hazards: '!' (zsh history expansion — e.g. the sequence
  // !" is REMOVED from the line, unbalancing quotes into a dquote> continuation
  // prompt), real newlines, trailing & (backgrounding), and very long lines.
  // Such commands are written to a temp script and sourced, so the shell
  // parses them non-interactively and verbatim.
  const hazardous = /[!\r\n]/.test(cmd) || background || cmd.length > 200;
  const timeoutMs = clampInt(timeout_ms, 1000, 600000, 30000);
  let sock = sockFor(server);

  let scratchNote = "";
  let scratch = false;
  if (target === undefined || target === null || target === "") {
    scratch = true;
    // Scratch ALWAYS lives on the float server — `server` only applies when a
    // pane target is given. (Agents passing server:"default" with no target
    // used to scatter scratch windows across the user's main servers.)
    const fl = await floatScratchPane();
    sock = fl.sock;
    target = fl.id;
    scratchNote = `, scratch window "${SCRATCH_WINDOW}" in float session "${fl.session}" on server "${SCRATCH_SERVER}" (user: open with the scratch popup)` +
      (server ? ` — note: server:"${server}" is ignored when target is omitted` : "");
  } else {
    requireStr(target, "target");
  }

  let info = await paneInfo(sock, target);
  await guardSelfPane(info, force, sock);
  if (!force && !scratch && !SHELLS.has(info.cmd)) {
    throw new Error(
      `pane ${info.id} is running '${info.cmd}', not an idle shell. Use send_keys to interact with that program, target a shell pane (see list_panes), omit target to use a scratch window, or pass force:true (e.g. for a shell inside ssh).`
    );
  }
  if (info.inMode) await tmux(sock, "send-keys", "-t", info.id, "-X", "cancel").catch(() => {});

  if (SHELLS.has(info.cmd)) {
    // C-c aborts pending multi-line input (dquote>/heredoc>/... continuation
    // prompts) that C-u cannot clear — e.g. a previously mangled line left the
    // shell waiting for a closing quote. Harmless at an empty prompt. Skipped
    // under force on non-shell panes, where C-c could kill a program.
    await tmux(sock, "send-keys", "-t", info.id, "C-c");
    await sleep(80);
  }
  await tmux(sock, "send-keys", "-t", info.id, "C-u"); // clear any half-typed input
  await sleep(60);
  info = await paneInfo(sock, info.id); // fresh cursor position after C-u
  // A couple of lines early; the echoed-command boundary below trims the surplus.
  const startAbs = Math.max(0, info.hist + info.cy - 2);

  const marker = `__MCP_${randomBytes(4).toString("hex")}__`;
  const isFish = info.cmd === "fish";
  const dir = join(tmpdir(), "tmux-mcp");
  if (hazardous || save_output) await mkdir(dir, { recursive: true }).catch(() => {});
  let srcFile = null;
  if (hazardous) {
    srcFile = join(dir, `cmd-${marker.slice(6, 14)}.sh`);
    await writeFile(srcFile, cmd + "\n", "utf8");
  }
  const bodyCmd = srcFile ? `${isFish ? "source" : "."} ${srcFile}` : cmd;
  let outFile = null;
  let typed;
  if (save_output) {
    outFile = join(dir, `run-${marker.slice(6, 14)}.out`);
    // Pipe through tee: the pane still shows everything live, while the file
    // gets byte-exact output free of terminal line-wrapping. The exit code is
    // taken from the command, not tee, via the shell's pipestatus.
    const grp = isFish ? `begin; ${bodyCmd}; end` : `{ ${bodyCmd}; }`;
    const st = isFish ? "$pipestatus[1]"
      : info.cmd === "bash" ? "${PIPESTATUS[0]}"
      : info.cmd === "zsh" ? "${pipestatus[1]}"
      : "$?"; // plain sh has no pipestatus — reports tee's status
    typed = `${grp} 2>&1 | tee ${outFile}; printf '${marker}%s\\n' ${st}`;
  } else {
    typed = `${bodyCmd}; printf '${marker}%s\\n' ${isFish ? "$status" : "$?"}`;
  }
  await tmux(sock, "send-keys", "-t", info.id, "-l", "--", typed);
  await tmux(sock, "send-keys", "-t", info.id, "Enter");

  const doneRx = new RegExp(`^${marker}(\\d+)\\s*$`);
  const t0 = Date.now();
  const deadline = t0 + timeoutMs;
  const where = scratch ? scratchNote : "";

  while (true) {
    await sleep(Math.min(400, Math.max(100, Math.floor(timeoutMs / 50))));
    const ls = await captureSince(sock, info.id, startAbs);

    let end = -1, code = null;
    for (let i = 0; i < ls.length; i++) {
      const m = ls[i].match(doneRx);
      if (m) { end = i; code = m[1]; break; }
    }

    if (end >= 0) {
      // The shell may render the typed command twice (zle redraws the line on
      // Enter), so take the LAST marker-bearing line before the result marker
      // as the echo boundary.
      let start = 0;
      for (let i = end - 1; i >= 0; i--) {
        if (ls[i].includes(marker)) { start = i + 1; break; }
      }
      const outLines = ls.slice(start, end);
      while (outLines.length && !outLines[outLines.length - 1]) outLines.pop();
      while (outLines.length && !outLines[0]) outLines.shift();
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      let body = outLines.length ? tailChars(outLines.join("\n")) : "(no output)";
      let saved = "";
      if (outFile) {
        saved = `\nfull raw output (unwrapped, safe to parse): ${outFile}`;
        try {
          body = tailChars((await readFile(outFile, "utf8")).replace(/\n$/, "")) || "(no output)";
        } catch {} // tee produced nothing — keep the pane-extracted body
      }
      return `exit code ${code} (pane ${info.id}${where}, ${secs}s)${saved}\n---\n${body}`;
    }

    if (Date.now() >= deadline) {
      let start = 0;
      for (let i = ls.length - 1; i >= 0; i--) {
        if (ls[i].includes(marker)) { start = i + 1; break; }
      }
      let partial = ls.slice(start).join("\n").trim();
      let extra = "";
      if (outFile) {
        extra = ` Raw output keeps streaming to ${outFile} — read/grep that file for clean, unwrapped content.`;
        try {
          partial = (await readFile(outFile, "utf8")).trim() || partial;
        } catch {}
      }
      let stuckNote = "";
      const lastLine = (ls[ls.length - 1] ?? "").trim();
      if (/(quote|heredoc|cmdsubst|pipe|cmdand|cmdor|braceparam|then|do|function)\s*>$/.test(lastLine)) {
        stuckNote = ` NOTE: the pane shows a shell continuation prompt ("${lastLine}") — the command never ran; the shell is waiting for more input (likely a mangled/unbalanced line). Send send_keys keys:["C-c"] to abort it, then retry.`;
      }
      return (
        `TIMEOUT: still running after ${timeoutMs}ms (pane ${info.id}${where}). The command was left running — it may need more time or user input.` +
        `${stuckNote}${extra} Check again with tail/wait_for/wait_silence, or abort it with send_keys keys:["C-c"].\n--- output so far ---\n` +
        tailChars(partial || "(no output yet)")
      );
    }
  }
}

async function waitFor({ target, pattern, timeout_ms, server }) {
  requireStr(target, "target");
  requireStr(pattern, "pattern");
  let rx;
  try { rx = new RegExp(pattern); } catch (e) { throw new Error(`invalid regex: ${e.message}`); }
  const timeoutMs = clampInt(timeout_ms, 500, 600000, 30000);
  const sock = sockFor(server);
  const info = await paneInfo(sock, target);
  const t0 = Date.now();
  while (true) {
    const ls = await capture(sock, info.id, 500);
    const hit = ls.find((l) => rx.test(l));
    if (hit !== undefined) {
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      return `matched /${pattern}/ after ${secs}s (pane ${info.id}):\n${hit}\n--- last 15 lines ---\n${ls.slice(-15).join("\n")}`;
    }
    if (Date.now() - t0 >= timeoutMs) {
      return `TIMEOUT (not an error): pattern /${pattern}/ not seen in pane ${info.id} within ${timeoutMs}ms — reissue this call to keep waiting; it returns immediately if the pattern has landed since. Last 15 lines:\n${ls.slice(-15).join("\n")}`;
    }
    await sleep(500);
  }
}

async function waitSilence({ target, quiet_ms, timeout_ms, server }) {
  requireStr(target, "target");
  const sock = sockFor(server);
  const quietMs = clampInt(quiet_ms, 200, 60000, 2000);
  const timeoutMs = clampInt(timeout_ms, 1000, 600000, 60000);
  const first = await paneInfo(sock, target);
  const startAbs = first.hist + first.cy;
  const t0 = Date.now();
  let lastState = null;
  let quietSince = Date.now();
  while (true) {
    const info = await paneInfo(sock, target);
    // hist+cursor catches new lines; bottom content catches in-place updates
    // (progress bars, spinners) that never move the cursor to a new row.
    const bottom = (await capture(sock, info.id, 3)).join("\n");
    const state = `${info.hist}:${info.cy}:${bottom}`;
    if (state !== lastState) {
      lastState = state;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= quietMs) {
      const ls = await captureSince(sock, info.id, Math.max(0, startAbs - 1));
      while (ls.length && !ls[ls.length - 1]) ls.pop();
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      return `pane ${info.id} went quiet (no output change for ${quietMs}ms, after ${secs}s). Output since this call:\n---\n${tailChars(ls.join("\n") || "(none)")}`;
    }
    if (Date.now() - t0 >= timeoutMs) {
      return `TIMEOUT (not an error): pane ${info.id} still producing output after ${timeoutMs}ms — reissue this call to keep waiting. Last 15 lines:\n${(await capture(sock, info.id, 15)).join("\n")}`;
    }
    await sleep(250);
  }
}

async function newWindow({ session, name, cwd, server }) {
  const sock = sockFor(server);
  const { pid, tgt } = await createWindow(sock, { session, name, cwd });
  const where = server ? ` on server "${server}"` : "";
  return `created window "${name || "claude"}" → pane ${pid} (${tgt})${where}${cwd ? `, cwd=${cwd}` : ""}. A fresh shell is starting; target ${pid} with run_command/send_keys${server ? ` (keep passing server:"${server}")` : ""}.`;
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

const SERVER_PARAM = {
  type: "string",
  description: "tmux server to target — a socket name from list_servers (e.g. \"default\") or an absolute socket path. Omit for the default server. Pane ids are only unique within one server.",
};

const TOOLS = [
  {
    name: "list_servers",
    description:
      "Discover every tmux server running for this user (tmux runs one isolated server per socket, e.g. `tmux -L work`). Returns each server's socket name, path, and sessions (with window counts and attached state); stale sockets are marked dead. Pane ids are only unique within one server — pass the matching `server` value to the other tools. `claude_session_server` marks the server hosting this Claude session.",
    annotations: { title: "List tmux servers", readOnlyHint: true },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: listServers,
  },
  {
    name: "whoami",
    description:
      "Where THIS Claude session lives in tmux: its server (socket), session, window, pane id, cwd, and whether the session is attached — plus where targetless run_command scratch output will go (scratch server + float session). Call it to orient yourself before targeting panes: the returned pane_id is your own pane and must never receive keys. Reports inside_tmux:false if Claude Code was not launched inside tmux.",
    annotations: { title: "Where am I in tmux", readOnlyHint: true },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: whoAmI,
  },
  {
    name: "list_panes",
    description:
      "List tmux sessions/windows/panes with stable pane ids (%N), what's running in each, and working directories. By default aggregates across ALL running tmux servers (each pane's `server` field says which — pass it as the `server` param in follow-up calls); set `server` to limit to one. Set `processes:true` to also include each pane's child processes and listening TCP ports (answers \"which pane is serving :3000?\"). `focused` marks the pane the user is looking at; `is_shell` means likely sitting at a shell prompt; `claude_session_pane` marks the pane running this Claude session (never type into it).",
    annotations: { title: "List tmux panes", readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        server: SERVER_PARAM,
        processes: { type: "boolean", description: "Include child processes + listening TCP ports per pane (slower; uses ps/lsof). Default false." },
      },
      additionalProperties: false,
    },
    handler: listPanes,
  },
  {
    name: "capture_pane",
    description:
      "Read the current contents of a tmux pane (screen + scrollback) — e.g. to check a dev server's logs or see the effect of keys you sent. Returns the last `lines` lines (default 200). Optional `grep` (JS regex) returns only matching lines. To repeatedly watch a pane, prefer tail (incremental) or wait_for/wait_silence. Note: captures reflect the terminal grid, so very long lines may come back wrapped/fragmented — for byte-exact machine-parseable output, run the command via run_command with save_output:true instead.",
    annotations: { title: "Capture pane output", readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Pane target — pane id like %3 (preferred) or session:window.pane" },
        lines: { type: "integer", description: "How many trailing lines to return (default 200, max 50000)" },
        grep: { type: "string", description: "Optional JS regex; only matching lines are returned" },
        server: SERVER_PARAM,
      },
      required: ["target"],
      additionalProperties: false,
    },
    handler: capturePaneTool,
  },
  {
    name: "find_in_panes",
    description:
      "Search every pane's recent scrollback (across ALL tmux servers unless `server` is set) for a JS regex, returning the matching panes with their last few matching lines. Use to locate where something is running or logged — a dev server, an error message, a command — without knowing the pane. The pane running this Claude session is skipped unless include_self:true (its conversation text would self-match).",
    annotations: { title: "Search all panes", readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JS regex matched line-by-line" },
        lines: { type: "integer", description: "Scrollback depth to search per pane (default 300, max 5000)" },
        server: SERVER_PARAM,
        include_self: { type: "boolean", description: "Also search the pane running this Claude session (default false)" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    handler: findInPanes,
  },
  {
    name: "tail",
    description:
      "Incrementally read a pane: returns a cursor with each call; pass the previous cursor back to get ONLY output produced since then. Without a cursor, returns the last `lines` lines (default 50) plus the initial cursor. Ideal for watching builds, servers, or long commands without re-reading and diffing the whole scrollback. The boundary line may repeat if it was still being written at cursor time.",
    annotations: { title: "Tail pane incrementally", readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Pane target — pane id like %3 (preferred) or session:window.pane" },
        cursor: { type: "string", description: "Cursor from a previous tail call (e.g. \"@1234\"); omit on the first call" },
        lines: { type: "integer", description: "First call only: how many trailing lines to return (default 50, max 5000)" },
        server: SERVER_PARAM,
      },
      required: ["target"],
      additionalProperties: false,
    },
    handler: tailTool,
  },
  {
    name: "send_keys",
    description:
      "Send keystrokes to a tmux pane: `text` is typed literally, then each entry of `keys` is sent as a key press (tmux key names: Enter, Escape, Tab, Up, C-c, C-d, ...), then Enter if `enter` is true. Use for interactive programs (REPLs, TUIs, prompts) or to abort with C-c. When the keystrokes submit a line (enter:true, an Enter key, or a newline in text), the text is screened against the guard config's deny patterns — a block is user policy, never something to rephrase around. Returns a pane snapshot after `snapshot_delay_ms` (default 300; 0 to skip). For a plain shell command whose output you want, prefer run_command.",
    annotations: { title: "Send keys to pane" },
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Pane target — pane id like %3 (preferred) or session:window.pane" },
        text: { type: "string", description: "Literal text to type (not interpreted as key names)" },
        keys: { type: "array", items: { type: "string" }, description: "Key presses sent after text, e.g. [\"Enter\"], [\"C-c\"], [\"Up\",\"Enter\"]" },
        enter: { type: "boolean", description: "Press Enter at the end (default false)" },
        snapshot_delay_ms: { type: "integer", description: "Wait this long, then include a snapshot of the pane (default 300, 0-5000; 0 disables)" },
        force: { type: "boolean", description: "Allow typing into the pane running this Claude session (default false)" },
        server: SERVER_PARAM,
      },
      required: ["target"],
      additionalProperties: false,
    },
    handler: sendKeys,
  },
  {
    name: "run_command",
    description:
      "Run a shell command in a tmux pane and return its output and exit code (waits up to timeout_ms, default 30s). Multi-line commands, commands containing '!' (zsh history-expansion hazard), very long commands, and trailing-& backgrounding are handled automatically by sourcing a temp script instead of typing the text raw. OMIT `target` to run in a dedicated scratch window (\"claude-scratch\", created on demand and reused) — the easiest option when any shell will do; it lives on the user's floating-scratch tmux server, in the float session matching the user's current main session, so the user can watch it via their scratch popup. The scratch ALWAYS goes to the float server — `server` applies only when `target` is given. Give a target pane only when the command must run in that pane's context. This types into the user's real terminal — visible to them, using their live environment (ssh agents, VPN, kubectl contexts, venvs). Useful when the sandboxed Bash tool can't run something. Half-typed input and stuck continuation prompts (dquote> etc.) are cleared with Ctrl-C/Ctrl-U first, and `; printf '<marker>' $?` is appended to detect completion. Refuses busy (non-shell) panes — override with force:true (e.g. a shell inside ssh). Every command is screened by the user's guard config (guard.json): deny patterns always block, and when its allow list is non-empty only matching commands run — a guard block is user policy, never something to rephrase around. On timeout the command keeps running; check with tail/wait_for/wait_silence.",
    annotations: { title: "Run command in pane" },
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Pane target — pane id like %3 or session:window.pane. Omit to use the reusable scratch window (recommended when any shell will do)" },
        command: { type: "string", description: "Shell command. Multi-line is fine; a trailing & backgrounds it (returns launch status immediately — follow with tail/wait_for)" },
        timeout_ms: { type: "integer", description: "How long to wait for completion (default 30000, max 600000)" },
        force: { type: "boolean", description: "Skip the idle-shell check, e.g. for a shell inside ssh (default false)" },
        save_output: { type: "boolean", description: "Also tee the command's full raw output to a temp file and return its contents byte-exact (no terminal line-wrapping). Use whenever the output will be parsed (JSON, long lines) — pane capture wraps long lines. On timeout the file keeps filling and can be read later. Default false." },
        server: { ...SERVER_PARAM, description: SERVER_PARAM.description + " Only applies together with `target` — without a target the scratch window ALWAYS goes to the float server; do not pass server just to be explicit." },
      },
      required: ["command"],
      additionalProperties: false,
    },
    handler: runCommand,
  },
  {
    name: "wait_for",
    description:
      "Poll a tmux pane until some line matches a JS regex, then return it with context. Checks the visible screen plus recent scrollback (~500 lines), so it returns immediately if the pattern is already present. TWO PATTERN TRAPS: (1) the command you typed is echoed in the pane, so a pattern matching the command text itself (e.g. `done$` after typing `make && echo done`) fires immediately on the echo; (2) TUI programs (e.g. a Claude Code session in the pane) DECORATE every rendered line (⏺ bullets, ⎿ indents), so a strict ^-anchor never matches their output. Best of both: `^[^A-Za-z0-9]*needle\\s*$` — tolerates leading decoration while still rejecting prose/echo lines that mention the needle mid-sentence. Use after starting a server/build to wait for a 'ready' or 'error' line. Timeout returns a normal TIMEOUT result (not an error) with the pane's last lines — reissue to keep waiting. If there is no known pattern to wait for, use wait_silence instead.",
    annotations: { title: "Wait for pattern in pane", readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Pane target — pane id like %3 (preferred) or session:window.pane" },
        pattern: { type: "string", description: "JS regex matched line-by-line" },
        timeout_ms: { type: "integer", description: "Give up after this long (default 30000, max 600000)" },
        server: SERVER_PARAM,
      },
      required: ["target", "pattern"],
      additionalProperties: false,
    },
    handler: waitFor,
  },
  {
    name: "wait_silence",
    description:
      "Wait until a pane STOPS producing output — no new lines and no in-place updates (progress bars/spinners) for `quiet_ms` (default 2000ms) — then return everything printed since the call started. Use when a build/command has no known completion string to wait_for. Caveat: a command that works silently for longer than quiet_ms before printing also counts as quiet — raise quiet_ms for such commands, or prefer wait_for when a completion string is known. Timeout returns a normal TIMEOUT result (not an error) — reissue to keep waiting.",
    annotations: { title: "Wait for pane to go quiet", readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Pane target — pane id like %3 (preferred) or session:window.pane" },
        quiet_ms: { type: "integer", description: "How long output must stay unchanged to count as quiet (default 2000)" },
        timeout_ms: { type: "integer", description: "Give up after this long (default 60000, max 600000)" },
        server: SERVER_PARAM,
      },
      required: ["target"],
      additionalProperties: false,
    },
    handler: waitSilence,
  },
  {
    name: "new_window",
    description:
      "Create a new detached tmux window running a fresh shell and return its pane id. Use this to get a scratch shell without disturbing panes the user is working in (the window stays visible in their status bar). Defaults to the user's attached session. For simply running a command, prefer run_command with no target (it manages its own scratch window).",
    annotations: { title: "New tmux window" },
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session to create the window in (default: the attached session)" },
        name: { type: "string", description: "Window name (default \"claude\")" },
        cwd: { type: "string", description: "Working directory for the new shell" },
        server: SERVER_PARAM,
      },
      additionalProperties: false,
    },
    handler: newWindow,
  },
];

const INSTRUCTIONS =
  "Drive the user's local tmux: inspect panes, read output/logs, type keystrokes, and run commands in the user's real terminal environment — useful when the sandboxed Bash tool can't (interactive programs, the user's live shell env, watching long-running servers, commands blocked by permissions the user wants run here instead). Quick recipes: run_command with NO target runs in a reusable scratch window on the user's floating-scratch tmux server (viewable via their scratch popup) — the default choice for just running something; find_in_panes locates where something is running/logged; tail + wait_for/wait_silence watch long-running output incrementally; list_panes processes:true maps ports to panes. Multiple tmux servers (sockets) may run side by side: list_servers shows them, and every tool takes an optional server param (pane ids are per-server). Prefer stable pane ids like %3. Everything you type is visible to the user, live, and screened by a user-maintained guard config (deny patterns always block; optional allowlist) — treat guard blocks as user policy, not failures to work around. Use send_keys + tail for interactive programs. Never target the pane marked claude_session_pane.";

// ---------------------------------------------------------------------------
// JSON-RPC over stdio (newline-delimited)
// ---------------------------------------------------------------------------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function handleMessage(msg) {
  if (!msg || typeof msg !== "object" || msg.method === undefined) return;
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    let result;
    switch (method) {
      case "initialize": {
        const requested = params?.protocolVersion;
        result = {
          protocolVersion: SUPPORTED_PROTOCOLS.has(requested) ? requested : LATEST_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        };
        break;
      }
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = {
          tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })),
        };
        break;
      case "tools/call": {
        const tool = TOOLS.find((t) => t.name === params?.name);
        if (!tool) throw { code: -32602, message: `unknown tool: ${params?.name}` };
        let text, isError = false;
        try {
          text = await tool.handler(params?.arguments ?? {});
        } catch (e) {
          text = `Error: ${e?.message ?? e}`;
          isError = true;
        }
        result = { content: [{ type: "text", text }], isError };
        break;
      }
      default:
        if (isRequest) throw { code: -32601, message: `method not found: ${method}` };
        return; // ignore unknown notifications (notifications/initialized, etc.)
    }
    if (isRequest) send({ jsonrpc: "2.0", id, result });
  } catch (e) {
    if (isRequest) send({ jsonrpc: "2.0", id, error: { code: e.code ?? -32603, message: e.message ?? String(e) } });
    if (DEBUG) console.error("[tmux-mcp]", e);
  }
}

let stdinBuf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuf += chunk;
  let nl;
  while ((nl = stdinBuf.indexOf("\n")) >= 0) {
    const line = stdinBuf.slice(0, nl);
    stdinBuf = stdinBuf.slice(nl + 1);
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (Array.isArray(parsed)) parsed.forEach(handleMessage);
    else handleMessage(parsed);
  }
});
process.stdin.on("end", () => process.exit(0));
process.on("uncaughtException", (e) => console.error("[tmux-mcp] uncaught:", e));
process.on("unhandledRejection", (e) => console.error("[tmux-mcp] unhandled:", e));
