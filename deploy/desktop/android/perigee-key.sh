#!/usr/bin/env bash
# The only thing the desktop emulator's SSH key may run on perigee (#533): its line in ~/.ssh/authorized_keys
# names this script as its command, so whatever the desktop asks for arrives here as SSH_ORIGINAL_COMMAND.
# (The tunnel itself runs no command; the same line limits it to four loopback ports.)
#   facts     what the emulator must share with perigee: the adb key perigee's adb server signs in with (the
#             emulator lets in the key it finds in its own home, and wants the private half to do it), and
#             the console token `sms` and `down` send from here. Both go only to the emulator's own distro,
#             and the adb key opens nothing but emulators started with it.
#   takeover  end a tunnel left from before the desktop restarted: its sshd here can sit on the ports for up
#             to two hours, and a new tunnel can't take them meanwhile. Only an sshd holding the emulator's
#             adb port is ended, never an emulator running here.
set -uo pipefail
port=$((${CITADEL_ANDROID_PORT:-5554} + 1))

case "${SSH_ORIGINAL_COMMAND:-}" in
  facts)
    printf 'adbkey %s\n' "$(base64 -w0 "$HOME/.android/adbkey" 2>/dev/null)"
    printf 'token %s\n' "$(cat "$HOME/.emulator_console_auth_token" 2>/dev/null)"
    ;;
  takeover)
    for pid in $(ss -Hltnp "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do
      case "$(cat "/proc/$pid/comm" 2>/dev/null)" in
        sshd*) kill "$pid" 2>/dev/null && echo "ended an old tunnel (pid $pid)" ;;
      esac
    done
    ;;
  *)
    echo 'Usage: facts | takeover'
    exit 2
    ;;
esac
