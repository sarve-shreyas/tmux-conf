#!/usr/bin/env bash
# Claude subscription usage as colored bars, for a tmux popup. Mirrors the nvim
# <leader>au view: parses `claude -p /usage` and turns each "N% used" line into a
# threshold-coloured bar; keeps the rest (reset times + breakdown) as text.
# Keys in the popup: r = refresh, any other key = quit.
set -u
BAR_W=28

bar() { # $1 = percent
  local pct=$1 i filled
  filled=$(( (pct * BAR_W + 50) / 100 ))
  ((filled < 0)) && filled=0
  ((filled > BAR_W)) && filled=$BAR_W
  local reset=$'\033[0m' dim=$'\033[90m' color
  if   ((pct >= 80)); then color=$'\033[31m'   # red
  elif ((pct >= 50)); then color=$'\033[33m'   # yellow
  else                     color=$'\033[32m'   # green
  fi
  printf '%s' "$color"
  for ((i = 0; i < filled; i++)); do printf '█'; done
  printf '%s' "$dim"
  for ((i = filled; i < BAR_W; i++)); do printf '░'; done
  printf '%s' "$reset"
}

# Renders just the "N% used" limit lines as spaced bars (skips the long
# breakdown so the popup stays small). Falls back to raw output on error.
render() {
  local out line label pct rest reset r any=0
  out="$(claude -p '/usage' 2>&1)"
  local re='^(.+): ([0-9]+)% used(.*)$'
  local re2='resets[^(]*'
  while IFS= read -r line; do
    if [[ "$line" =~ $re ]]; then
      any=1
      label="${BASH_REMATCH[1]}"; pct="${BASH_REMATCH[2]}"; rest="${BASH_REMATCH[3]}"
      reset=""
      if [[ "$rest" =~ $re2 ]]; then
        r="${BASH_REMATCH[0]%% }"; r="${r#resets }"; r="${r/ at / }"
        reset="  · ${r}"
      fi
      printf '\n  %-26s [' "$label"   # leading blank line = spacing between bars
      bar "$pct"
      printf '] %3d%%%s\n' "$pct" "$reset"
    fi
  done <<< "$out"
  [[ $any -eq 0 ]] && printf '\n  %s\n' "$out"
}

# Testing hook: render once and exit.
if [[ "${1:-}" == "--once" ]]; then render; exit 0; fi

while :; do
  clear
  printf '  \033[1mClaude usage\033[0m\n\n  Loading…'
  body="$(render)"
  clear
  printf '  \033[1mClaude usage\033[0m%s' "$body"
  printf '\n  \033[90m[r] refresh · [q] quit\033[0m\n'
  IFS= read -rsn1 key
  [[ "$key" == "r" ]] && continue
  break
done
