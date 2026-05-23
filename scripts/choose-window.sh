#!/usr/bin/env bash
# Open choose-tree windows-only, filtered to current session.
# A colored ✳ marks rows where Claude is running:
#   - on a pane row: the marker reflects that specific pane
#   - on a window row: aggregates across all panes (working beats idle)
session="$1"
mk="$HOME/.config/tmux/scripts/claude-marker.sh"

PANE_ROW="#{E:#($mk pane #{pane_id})}#{pane_index}: #{pane_current_command} \"#{pane_title}\""
WIN_ROW="#{E:#($mk window #{session_name}:#{window_index})}#{window_index}: #{window_name}#{?window_flags, #{window_flags},}"
SES_ROW='#{session_name}: #{session_windows} windows#{?session_attached, (attached),}'

FORMAT="#{?pane_format,${PANE_ROW},#{?window_format,${WIN_ROW},${SES_ROW}}}"

tmux choose-tree -Zw \
  -f "#{==:#{session_name},$session}" \
  -F "$FORMAT"
