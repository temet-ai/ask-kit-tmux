#!/bin/sh
# Starts the tmux server the bench questions are about: socket "askkit-fixture", config and folders in
# bench/fixtures/ (ignored by git). Its sessions, programs and printed lines are fixed, so the answers do
# not change. Run it once before the bench; `make-fixture.sh stop` ends the server.
set -e
here=$(cd "$(dirname "$0")" && pwd)
fx="$here/fixtures"
T="tmux -L askkit-fixture"
$T kill-server 2>/dev/null || true
if [ "$1" = stop ]; then exit 0; fi
rm -rf "$fx"
mkdir -p "$fx/yard" "$fx/guild"
cat > "$fx/tmux.conf" <<'CONF'
set -g prefix C-a
unbind C-b
bind C-a send-prefix
set -g mouse on
set -g base-index 1
set -g remain-on-exit on
bind | split-window -h
bind - split-window -v
CONF
$T -f "$fx/tmux.conf" new-session -d -s watch -n dev -x 120 -y 30 -c "$fx/yard" \
  'sh -c "echo Pseudopolis Yard server listening on port 8080; echo ERROR: night shift roster missing; sleep 3600"'
$T new-window -d -t watch: -n build -c "$fx/yard" \
  'sh -c "echo compiling the watch; echo error[E0432]: unresolved import watch::patrol; exit 3"'
$T new-window -d -t watch: -n prompt -c "$fx/yard" \
  'sh -c "printf \"Delete the old roster? [y/N] \"; read answer; sleep 3600"'
$T new-session -d -s guild -n ledger -x 120 -y 30 -c "$fx/guild" \
  'sh -c "echo ledger balance 42 coins; echo DB_PASSWORD=ankh-morpork-1; echo Authorization: Bearer 0123456789abcdef0123; sleep 3600"'
sleep 1
$T list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} #{pane_current_command} dead=#{pane_dead}'
