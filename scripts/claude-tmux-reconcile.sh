#!/usr/bin/env bash
# claude-tmux-reconcile.sh — correct stale Claude window-tab markers by reading
# the actual pane content. Runs on window/session switch (see tmux.conf).
#
# Why: the hooks in ~/.claude/settings.json set busy/wait/clear on real events,
# but pressing <esc> to interrupt Claude fires NO hook — so a "working" marker
# would otherwise stay orange forever. This re-derives the truth from the pane:
#   permission prompt visible      → wait  (red ▲)
#   live "working" counter visible → busy  (orange ●)
#   otherwise (idle / done / exited) → clear (nothing)
#
# It scans every pane on the server but only inspects Claude panes (or panes
# that still carry a stale state), so it stays cheap and runs off the render
# path. Tweak the two regexes below if Claude's TUI text changes.

export LC_ALL=C   # byte-wise grep; patterns below are ASCII on purpose.
[ -n "$TMUX" ] || exit 0
command -v tmux >/dev/null 2>&1 || exit 0
state_script="$HOME/.config/tmux/scripts/claude-tmux-state.sh"
[ -x "$state_script" ] || exit 0

is_claude_cmd() { case "$1" in claude|[0-9]*.[0-9]*.[0-9]*) return 0;; *) return 1;; esac; }

# "Actively working" — live timer "(2m 54s", "(54s ", or a "… tokens)" counter,
# or the literal "esc to interrupt". The completed summary "Worked for 8m 37s"
# and recap lines have none of these.
WORKING_RE='esc to interrupt|\([0-9]+m [0-9]+s|\([0-9]+s |tokens\)'
# A permission / choice prompt is on screen.
PERMISSION_RE='Do you want to |[0-9]\. Yes|No, and tell Claude'

changed=0
while IFS='|' read -r pane cmd cur; do
  [ -n "$pane" ] || continue

  if is_claude_cmd "$cmd"; then
    body=$(tmux capture-pane -p -t "$pane" 2>/dev/null | tail -n 16)
    if printf '%s\n' "$body" | grep -qE "$PERMISSION_RE"; then
      target=wait
    elif printf '%s\n' "$body" | grep -qE "$WORKING_RE"; then
      target=busy
    else
      target=clear
    fi
  else
    # Not Claude (e.g. it exited). Only act if a stale state lingers.
    [ -n "$cur" ] || continue
    target=clear
  fi

  # Normalise (empty == clear) and skip no-ops.
  curn=$cur; [ -n "$curn" ] || curn=clear
  [ "$target" = "$curn" ] && continue

  TMUX_PANE="$pane" "$state_script" "$target" norefresh
  changed=1
done < <(tmux list-panes -a -F '#{pane_id}|#{pane_current_command}|#{@claude_state}' 2>/dev/null)

# Redraw once if anything actually changed.
if [ "$changed" = 1 ]; then
  tmux list-clients -F '#{client_name}' 2>/dev/null | while IFS= read -r c; do
    tmux refresh-client -S -t "$c" 2>/dev/null
  done
fi
exit 0
