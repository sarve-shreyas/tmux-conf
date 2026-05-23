#!/usr/bin/env bash
# Restores Claude sessions into the correct tmux panes after resurrect.
# Backgrounded from the pre-restore-pane-processes hook so shells have time to init.

RESURRECT_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/tmux/resurrect"
SAVE_FILE="$RESURRECT_DIR/claude-sessions"

[[ -f "$SAVE_FILE" ]] || exit 0
[[ -s "$SAVE_FILE" ]] || exit 0

sleep 3

while IFS=$'\t' read -r slot session_id cwd; do
    session_name="${slot%%:*}"

    tmux has-session -t "$session_name" 2>/dev/null || continue

    # Verify the pane exists
    if ! tmux list-panes -t "${slot%.*}" -F '#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null |
         grep -qxF "$slot"; then
        continue
    fi

    # Skip if something is already running in the pane (not the shell)
    pane_cmd=$(tmux display-message -t "$slot" -p '#{pane_current_command}' 2>/dev/null)
    case "$pane_cmd" in
        zsh|bash|fish|sh) ;;
        *) continue ;;
    esac

    # Use set-buffer + paste to avoid send-keys wrapping at pane width
    tmux set-buffer -b claude_restore "claude --resume $session_id"
    tmux paste-buffer -b claude_restore -t "$slot" -d
    tmux send-keys -t "$slot" Enter
done < "$SAVE_FILE"
