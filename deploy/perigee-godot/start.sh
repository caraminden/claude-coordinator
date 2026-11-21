#!/bin/sh
# Inside the perigee-godot container: a GPU-backed headless Wayland screen, then the Godot editor on
# the Delve checkout. The editor's Godot AI plugin dials in to the godot-ai backend by itself.
# The .container runs this from the live checkout, so a change here is live at the editor's next start.
set -e
mkdir -p -m700 "$XDG_RUNTIME_DIR"

# The editor's headless window counts as focused, so it woke every 6.9 ms (140 times a second, 18% of a
# core) with nothing to draw. 50 ms is about 3% and adds at most 50 ms a frame to a call (#1353). The
# editor rewrites this file when it exits, so set it here, before it starts.
settings="$HOME/.config/godot/editor_settings-4.7.tres"
key='interface/editor/timers/low_processor_mode_sleep_usec'
if [ -f "$settings" ]; then
  if grep -q "^$key = " "$settings"; then
    sed -i "s|^$key = .*|$key = 50000|" "$settings"
  else
    echo "$key = 50000" >> "$settings"
  fi
fi

weston --backend=headless --renderer=gl --width=1920 --height=1080 --socket=wl-0 --idle-time=0 &
for i in $(seq 50); do [ -S "$XDG_RUNTIME_DIR/wl-0" ] && break; sleep 0.1; done
export WAYLAND_DISPLAY=wl-0
# Dummy audio: the container has no sound card and its ALSA default is the null device, which takes
# samples as fast as they come, so Godot's audio thread spun a full core for the editor's whole life (#1353).
exec "$GODOT" --editor --path "$DELVE_DIR/godot" --display-driver wayland --rendering-driver opengl3 --audio-driver Dummy
