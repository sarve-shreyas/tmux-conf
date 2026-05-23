#!/usr/bin/env bash
# Saves a mapping of tmux pane slots -> Claude session IDs.
# Called by tmux-resurrect as a post-save hook.

RESURRECT_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/tmux/resurrect"
SAVE_FILE="$RESURRECT_DIR/claude-sessions"

: > "$SAVE_FILE"

declare -a session_files=()
declare -a slots=()
declare -a cwds=()

while read -r slot pane_tty cwd; do
    tty_short="${pane_tty#/dev/}"
    claude_pid=$(ps -t "$tty_short" -o pid=,comm= 2>/dev/null |
                 awk '$2 == "claude" { print $1; exit }')
    [[ -z "$claude_pid" ]] && continue

    session_file="$HOME/.claude/sessions/${claude_pid}.json"
    [[ -f "$session_file" ]] || continue

    session_files+=("$session_file")
    slots+=("$slot")
    cwds+=("$cwd")
done < <(tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} #{pane_tty} #{pane_current_path}')

[[ ${#session_files[@]} -eq 0 ]] && exit 0

/usr/bin/python3 -c "
import json, sys
files = sys.argv[1:]
for f in files:
    try:
        print(json.load(open(f))['sessionId'])
    except Exception:
        print('')
" "${session_files[@]}" | {
    i=0
    while IFS= read -r session_id; do
        if [[ -n "$session_id" ]]; then
            printf '%s\t%s\t%s\n' "${slots[$i]}" "$session_id" "${cwds[$i]}" >> "$SAVE_FILE"
        fi
        ((i++))
    done
}
