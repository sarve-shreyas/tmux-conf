#!/usr/bin/env bash
# Open/attach the floating scratch for the CURRENT main tmux session.
# Floats live on a SEPARATE tmux server ("floats") so they never clutter the
# main server. Each main session gets its own float session (named to match),
# so this only ever attaches THIS session's float — never another session's.
#
# Invoked as a display-popup -E command (runs in a popup pane on the MAIN
# server, so $TMUX still points at the main server here).
set -u

SOCK="floats"
CONF="$HOME/.config/tmux/floats.conf"

# Name the float after the current MAIN session.
NAME="$(tmux display -p '#{session_name}' 2>/dev/null)"
[ -n "$NAME" ] || NAME="scratch"

# Attach this session's float (create it on the floats server if it doesn't
# exist yet). TMUX= forces tmux to attach across servers without the nesting
# refusal. Detaching (prefix g, or prefix d) just hides it — the float server
# keeps the session (and any server you ran in it) alive.
TMUX= tmux -L "$SOCK" attach -t "$NAME" 2>/dev/null \
  || TMUX= tmux -L "$SOCK" -f "$CONF" new -s "$NAME"
