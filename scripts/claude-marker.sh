#!/usr/bin/env bash
# Print a tmux-format marker if Claude is running at the target.
#   - orange ✳    when Claude is present
#   - two spaces  otherwise
#
# Usage:
#   claude-marker.sh pane   <pane_id>
#   claude-marker.sh window <session:window_index>
GAP='  '
MARK='#[fg=#d97757]✳#[default] '

is_claude_cmd() {
  case "$1" in
    claude|[0-9]*.[0-9]*.[0-9]*) return 0 ;;
    *) return 1 ;;
  esac
}

case "$1" in
  pane)
    cmd=$(tmux display-message -p -t "$2" '#{pane_current_command}' 2>/dev/null)
    is_claude_cmd "$cmd" && printf '%s' "$MARK" || printf '%s' "$GAP"
    ;;
  window)
    if tmux list-panes -t "$2" -F '#{pane_current_command}' 2>/dev/null \
        | grep -qE '^([0-9]+\.[0-9]+\.[0-9]+|claude)$'; then
      printf '%s' "$MARK"
    else
      printf '%s' "$GAP"
    fi
    ;;
esac
