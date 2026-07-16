#!/usr/bin/env bash
# claude-tmux-state.sh — reflect Claude Code activity on the tmux window tabs,
# the way iTerm shows an activity indicator on a tab.
#
# Driven by Claude Code hooks (see ~/.claude/settings.json). Each pane running
# Claude gets a per-pane state; the window tab shows an icon that aggregates all
# its panes (most-urgent wins):
#   busy → ● orange   Claude is working
#   wait → ▲ red      Claude needs input / permission
#   (completed / idle → nothing; the tab is clean)
#
# Usage:  claude-tmux-state.sh <busy|wait|clear|done> [norefresh]
#   done  is an alias for clear (kept so the Stop hook reads naturally).
#   norefresh  skips the status redraw — used by the reconciler, which redraws
#              once at the end of a batch.
#
# Relies on $TMUX / $TMUX_PANE, which Claude inherits from the pane it runs in
# (and hooks inherit from Claude). It is event-driven only — nothing here runs
# on status redraw, so it never reintroduces status-bar lag.

state="$1"
norefresh="$2"

# Only act when invoked from inside a tmux pane.
[ -n "$TMUX" ] && [ -n "$TMUX_PANE" ] || exit 0
command -v tmux >/dev/null 2>&1 || exit 0

pane="$TMUX_PANE"

# ── Glyph + colour per state (fg only — no bg, so it sits inside the tab). ──
ICON_BUSY='#[fg=#d97757]● '
ICON_WAIT='#[fg=#e06c75,bold]▲#[nobold] '

# 1) Record this pane's state (done/clear unset it).
case "$state" in
  busy|wait)      tmux set-option -p -t "$pane" @claude_state "$state" 2>/dev/null ;;
  done|clear|"")  tmux set-option -pu -t "$pane" @claude_state 2>/dev/null ;;
  *) exit 0 ;;
esac

# 2) Find this pane's window.
win=$(tmux display-message -p -t "$pane" '#{window_id}' 2>/dev/null)
[ -n "$win" ] || exit 0

# 3) Aggregate across the window's panes: wait > busy > none.
rank() { case "$1" in wait) echo 2;; busy) echo 1;; *) echo 0;; esac; }
best=0; agg=""
while IFS= read -r s; do
  r=$(rank "$s")
  [ "$r" -gt "$best" ] && { best=$r; agg=$s; }
done < <(tmux list-panes -t "$win" -F '#{@claude_state}' 2>/dev/null)

# 4) Stash the styled icon (+ raw state) as window options the status bar reads.
case "$agg" in
  busy) icon="$ICON_BUSY" ;;
  wait) icon="$ICON_WAIT" ;;
  *)    icon='' ;;
esac
tmux set-option -w -t "$win" @claude_icon "$icon" 2>/dev/null
tmux set-option -w -t "$win" @claude_win_state "${agg:-none}" 2>/dev/null

# 5) Force an immediate status redraw on every attached client (skipped in batch).
if [ "$norefresh" != norefresh ]; then
  tmux list-clients -F '#{client_name}' 2>/dev/null | while IFS= read -r c; do
    tmux refresh-client -S -t "$c" 2>/dev/null
  done
fi

exit 0
