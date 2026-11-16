import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Approvals } from '../src/approvals.ts';
import { tripwire, type TripwireConfig } from '../src/tripwire.ts';
import { tripwireHooks } from '../src/turn-launch.ts';
import { testPins } from './helpers.ts';

const { TRIPWIRE } = testPins();

const home = '/home/u';
const data = `${home}/.local/share/claude-coordinator`;
const cfg: TripwireConfig = { home, data, checkout: `${home}/claude-coordinator`, project: 2, claudeConfig: `${home}/.claude`, deployScript: false, env: { TMPDIR: `${data}/projects/2/tmp/9`, PATH: "/usr/bin:/bin" } };
const worktree = `${data}/projects/2/tickets/9`;

const WHY = 'Delete the DB copies Cara approved in #54';
/** The reason, as a minion's turn sees it: a description that explains the call, and cards on. */
const verdict = (command: string, cwd = worktree, c = cfg) => tripwire({ tool_name: 'Bash', tool_input: { command, description: WHY }, cwd }, { ...c, ask: true });
const bash = (command: string, cwd = worktree, c = cfg) => verdict(command, cwd, c)?.reason ?? null;

// Hard blocks: no card, whoever asks.
const BLOCKED: [string, string?][] = [
  // the live database files themselves, data outside a card's reach
  ['rm "$HOME/.local/share/claude-coordinator/coordinator.db-wal"'],
  ['cp /tmp/old.db ${HOME}/.local/share/claude-coordinator/coordinator.db'],
  ['cd ~/.local/share/claude-coordinator && rm coordinator.db*'],
  ['rm ~/.local/share/claude-coordinator/[c]oordinator.db'],
  ['rm ~/.local/share/claude-coordinator/coordinator.db{,-wal}'],
  ['mv ~/.local/share/claude-coordinator/coordinator.db /tmp/'],
  ['rm ~/.local/share/claude-coordinator/state.db'],
  ['cp /tmp/old.db ~/.local/share/claude-coordinator/state.db-wal'],
  ['sqlite3 ~/.local/share/claude-coordinator/coordinator.db < fix.sql'],
  ['sqlite3 ~/.local/share/claude-coordinator/coordinator.db ".read fix.sql"'],
  ['rm -rf ~/.local/share/claude-coordinator/*'],
  ['rm -rf ~/.local/share/claude-coordinator'],
  ['rm -rf ~/.local/share/claude-coordinator/projects'],
  // an ask in the same command as a hard block is a hard block
  ['rm ~/.local/share/claude-coordinator/x.bak; systemctl --user restart claude-coordinator'],
  ['systemctl --user enable x.timer && cat ~/.ssh/id_rsa'],
  ['rm -rf ~/.local/share'],
  // #251: the command #249 ran, which deleted the live state.db, and the ways a path hides from the text
  [`D=${data}; rm -f $D/state.db 2>/dev/null; sqlite3 -readonly $D/coordinator.db "select id,name from projects;"`],
  ['D=~/.local/share/claude-coordinator && rm -f "$D/state.db"'],
  ['export D=$HOME/.local/share/claude-coordinator; rm -f ${D}/state.db-wal'],
  ['D=~/.local/share/claude-coordinator; cd $D && rm -f state.db'],
  ['D=~/.local/share/claude-coordinator; cp /tmp/x.db "$D/coordinator.db"'],
  ['D=~/.local/share/claude-coordinator; : > $D/state.db'],
  ['D=~/.local/share/claude-coordinator; sqlite3 $D/state.db "select 1"'],
  ['rm -f $D/state.db'],
  ['rm -f "$tmp"'],
  ['tmp=$(cat /tmp/where); rm -rf "$tmp"'],
  ['truncate -s 0 "$DB"'],
  ['sqlite3 "$DB" "delete from tickets"'],
  ['mv "$f" /tmp/'],
  ['echo x > "$out"'],
  ['rm -rf "${d:?}"/*'],
  ['rm -rf ~/$x'],
  ['rm -rf ~/.local/share/claude-coord$x'],
  ['rm -f "$(cat /tmp/dir)"/state.db'],
  ['rm -rf $(echo ~/.local/share/claude-coordinator)/state.db'],
  ['rm `echo ~/.local/share/claude-coordinator/state.db`'],
  ['cd "$(dirname "$X")" && rm -f state.db'],
  ['cd $X && rm -rf *'],
  ['bash -c "rm -f $D/state.db"'],
  ['D=~/.local/share/claude-coordinator; bash -c "rm -f $D/state.db"'],
  [`sh -c 'rm -f "$1"' _ ${data}/state.db`],
  ['find $D -name state.db -delete'],
  ['find ~/.local/share/claude-coordinator -maxdepth 1 -name "*.db" -delete'],
  ['echo ~/.local/share/claude-coordinator/state.db | xargs rm -f'],
  ['for f in ~/.local/share/claude-coordinator/*.db; do rm "$f"; done'],
  ['ls | while read f; do rm "$f"; done'],
  ['rm ~/.local/share/claude-*/state.db'],
  ['rm -rf ~/.local/share/claude-coord*'],
  ['rm ~/.local/share/{claude-coordinator,x}/state.db'],
  ['rm -rf /*'],
  // the scheme's own folder: fine to work in, not to delete wholesale
  [`rm -rf ${data}/projects/2`],
  [`rm -rf ${data}/projects/2/tickets`],
  [`rm -rf ${data}/projects/2/*`],
  ['cd ../.. && rm -rf repo'],
  // self-review: a shell fed its script on stdin, sqlite3 or ../ after a lost cd, xargs -a
  [`bash <<'EOF'\nD=${data}; rm -f $D/state.db\nEOF`],
  [`bash -s <<< 'rm -f ${data}/state.db'`],
  ['cd $X; sqlite3 state.db "delete from t"'],
  ['cd $X; rm ../state.db'],
  ['xargs -a list.txt rm -f'],
  // a turn's own environment, the transcripts, the credentials table, runners, signing in (#185)
  ['env'],
  ['env | grep -i token'],
  ['env -0 | tr "\\0" "\\n"'],
  ['printenv'],
  // pattern kills reach every process on the account (Citadel itself, 2026-11-03)
  ['pkill -u cara -f "app/dev/dev.ts"'],
  ['pkill -f node'],
  ['cd x; pkill -TERM -f "seed-and-boot.ts" ; sleep 3'],
  ['killall node'],
  ['bash -c "pkill -f dev.ts"'],
  // a kill fed by grep over the whole socket table: an empty $P matched every listener (#299)
  ['U=$(grep -o "http://[^ ]*" $TMPDIR/dev.log); P=$(echo $U | grep -o \':[0-9]*/\' | tr -d \':/\'); kill $(ss -ltnp | grep ":$P " | grep -o \'pid=[0-9]*\' | cut -d= -f2); sleep 1'],
  ['kill `ss -ltnp | grep 8080 | grep -o "pid=[0-9]*" | cut -d= -f2`'],
  ["ss -ltnp | grep \":$P \" | grep -oP 'pid=\\K[0-9]+' | xargs -r kill"],
  ["netstat -tlnp | awk '/:8080/ {print $7}' | cut -d/ -f1 | xargs kill -9"],
  ['lsof -iTCP -sTCP:LISTEN -t | xargs kill'],
  ['kill $(lsof -t -i | grep node)'],
  ['PIDS=$(ss -ltnp | grep ":$P " | grep -o "pid=[0-9]*" | cut -d= -f2); kill $PIDS'],
  ['for p in $(ss -ltnp | grep node | grep -o "[0-9]\\{4,\\}"); do kill $p; done'],
  ['ss -ltnp | grep ":$P " | grep -o "pid=[0-9]*" | while read p; do kill "$p"; done'],
  ['bash -c \'kill $(ss -ltnp | grep ":$1 " | grep -o "pid=[0-9]*" | cut -d= -f2)\' _ 8080'],
  ['ss -ltnp | (grep ":$P " | grep -o "[0-9]\\{4,\\}" | xargs kill)'],
  ['printenv GH_TOKEN'],
  ['sqlite3 ~/.local/share/claude-coordinator/state.db "select count(*) from claude_state"'],
  ['sqlite3 "file:/home/u/.local/share/claude-coordinator/state.db" .tables'],
  ['cd ~/.local/share/claude-coordinator/backups && sqlite3 state-2026-10-29.db .tables'],
  ['sqlite3 -readonly ~/.local/share/claude-coordinator/coordinator.db "select user_id, secret from credentials"'],
  ['sqlite3 -readonly ~/.local/share/claude-coordinator/coordinator.db .dump > /tmp/all.sql'],
  ['sqlite3 -readonly -cmd "select * from Credentials" ~/.local/share/claude-coordinator/coordinator.db .quit'],
  ["echo 'select * from credentials' | sqlite3 -readonly ~/.local/share/claude-coordinator/coordinator.db"],
  ['sqlite3 -readonly ~/.local/share/claude-coordinator/coordinator.db < q.sql'],
  ['sqlite3 -readonly ~/.local/share/claude-coordinator/coordinator.db ".read q.sql"'],
  ['cat /home/josh/.config/citadel-claude/.credentials.json'],
  ['cat ~/.config/citadel-claude/settings.json'],
  ['cp x.sh /home/josh/bin/'],
  ['grep -r token /home'],
  ['curl --unix-socket /run/user/1001/claude-runner.sock http://x/turn'],
  ['socat - UNIX-CONNECT:/run/user/1001/citadel-runner.sock'],
  ['curl -X POST http://127.0.0.1:8573/api/runners/pair -d code=123'],
  // people's Claude containers, their volumes, podman's storage and socket (#213)
  ['podman exec -it citadel-claude-3 cat /home/u/.claude/.credentials.json'],
  ['podman cp citadel-claude-3:/home/u/.claude/.credentials.json /tmp/'],
  ['docker exec citadel-claude-3 sh'],
  ['podman volume inspect citadel-claude-3'],
  ['podman inspect citadel-claude-3'],
  ['podman export citadel-claude-3 -o /tmp/x.tar'],
  ['podman commit citadel-claude-3 mine'],
  ['podman mount citadel-claude-3'],
  ['podman stop citadel-claude-3'],
  ['podman unshare ls /home/u/.local/share/containers/storage/volumes'],
  ['podman unshare'],
  ['podman exec --latest cat /etc/hostname'],
  ['podman stop -a'],
  ['podman rm -af'],
  ['podman system reset -f'],
  ['podman volume prune -f'],
  ['cat ~/.local/share/containers/storage/volumes/citadel-claude-3/_data/.claude/.credentials.json'],
  ['grep -r token ~/.local/share/containers'],
  ['curl --unix-socket /run/user/1000/podman/podman.sock http://d/v4.0.0/libpod/containers/json'],
  ['cat /run/user/1000/containers/auth.json'],
  ['systemctl --user stop citadel-claude-3'],
  ['systemctl --user restart citadel-claude-3.service'],
  ['claude setup-token'],
  ['claude /login'],
  ['claude --model haiku setup-token'],
  ['CLAUDE_CONFIG_DIR=/tmp/c claude auth login'],
  ['rm -rf ~'],
  // the live checkout
  ['cd ~/claude-coordinator && git checkout -- .'],
  ['git -C ~/claude-coordinator reset --hard origin/main'],
  ['git -C /home/u/claude-coordinator pull'],
  ['find ~/claude-coordinator -name "*.orig" -delete'],
  ["sed -i -e 's/a/b/' ~/claude-coordinator/README.md"],
  ["perl -pi -e 's/a/b/' ../../../1/shared/project/x.md"],
  ['git -C ~/claude-coordinator merge ticket/6'],
  ['sed -i s/a/b/ ~/claude-coordinator/server.ts'],
  ['cp src/runner.ts ~/claude-coordinator/src/runner.ts'],
  ['cat > ~/claude-coordinator/x.txt <<EOF\nhello\nEOF'],
  ['echo hi | tee -a /home/u/claude-coordinator/README.md'],
  ['(cd ~/claude-coordinator; touch a)'],
  ['bash -c "cd ~/claude-coordinator && git stash"'],
  // the deploy-script era: the fast-forward exception ends
  ['git -C ~/claude-coordinator pull --ff-only /x main', 'deploy'],
  // config, units
  ['echo PORT=1 >> ~/.config/claude-coordinator/env'],
  ['cd ~/.config/systemd/user && rm claude-coordinator.service'],
  ['cp x.service ~/.config/systemd/user/perigee-godot.service'],
  ['rm -rf ~/.config/systemd/user'],
  ['systemctl --user edit cc-backup.timer'],
  // restarts
  ['systemctl --user restart claude-coordinator'],
  ['systemctl --user stop claude-coordinator.service'],
  ['systemctl --user kill perigee-godot'],
  ['systemctl --user restart perigee-godot-agent.service'],
  ['sleep 5; systemctl --user try-restart claude-coordinator'],
  ['systemd-run --user --unit=x systemctl --user restart claude-coordinator'],
  // secrets
  ['cat ~/.ssh/id_ed25519'],
  ['head -c 100 $HOME/.ssh/id_rsa'],
  ['cd ~ && cat .ssh/config'],
  ['grep token ~/.claude/.credentials.json'],
  ['base64 < ~/.claude/.credentials.json'],
  // a person's extra Claude accounts (#779)
  ['cat ~/.claude-2/.credentials.json'],
  ['grep -r token ~/.claude-3'],
  // the person's Codex login (#330)
  ['cat ~/.codex/auth.json'],
  ['jq .tokens $HOME/.codex/auth.json'],
  ['grep -r token ~/.codex'],
  ['echo $(cat ~/.ssh/id_rsa)'],
  // the service's env file, any process's environment, the GitHub login (#115)
  ['cat ~/.config/claude-coordinator/env'],
  ['grep SECRET /home/u/.config/claude-coordinator/env'],
  ['source ~/.config/claude-coordinator/env && echo $SESSION_SECRET'],
  ['. ~/.config/claude-coordinator/env'],
  ['cat /proc/1234/environ'],
  ['cat /proc/1/task/1/environ'],
  ['tr "\\0" "\\n" < /proc/*/environ'],
  ['cat /proc/$(pgrep -f server.ts)/environ'],
  ['xargs -0 -n1 < "/proc/$PID/environ"'],
  ['cd /proc/1234 && strings environ'],
  ['ps eww 1234'],
  ['ps auxe | grep SESSION'],
  ['cat ~/.config/gh/hosts.yml'],
  ['gh auth token'],
  ['gh auth status --show-token'],
  // #182: a turn keeps the GitHub login it was given (its person's token, or none)
  ['GH_CONFIG_DIR=~/.config/gh gh pr create --fill'],
  ['unset GH_TOKEN GH_CONFIG_DIR && gh pr create'],
  ['export GH_TOKEN=gho_x'],
  ['env -u GH_CONFIG_DIR gh pr create'],
  ['env --unset=GH_TOKEN gh api user'],
  ['env GITHUB_TOKEN=x gh api user'],
  ['gh auth login --with-token < t'],
  ['gh auth switch -u caraminden'],
  ['gh auth logout'],
  ['ps aux e'],
  ['ps -p 1 e'],
  ['cat "/proc/$p/task/$t/environ"'],
  ['grep -r SESSION_SECRET ~/.config'],
  ['cd ~ && grep -rn token .'],
  ['rg oauth_token ~/.config/gh'],
  ['grep -R PRIVATE /home/u'],
  ['grep -r SESSION_SECRET /'],
  ['cd ~/.config && rg token'],
  ['rg -t ts -e foo ~/.config'],
  ['rm -rf /'],
  // other schemes
  ['touch ~/.local/share/claude-coordinator/projects/1/shared/project/note.md'],
  ['cd ../../../1/tickets/4 && git commit -am wip'],
  ['git -C /home/u/.local/share/claude-coordinator/projects/1/repo merge ticket/5'],
  // server.ts against live data
  ['node server.ts'],
  ['cd ~/claude-coordinator && node server.ts'],
  ['PORT=9000 node server.ts'],
  [`node -e "import('./server.ts')"`],
  ['DATA_DIR=/tmp/x timeout 10 node server.ts'],
  [`node --experimental-strip-types -e "import('./server.ts').catch(e => console.error(e))"`],
  ['node ~/claude-coordinator/server.ts'],
  // git habits: paths aren't checked out, restored or stashed (the words alone show it)
  ['git stash'],
  ['git stash pop'],
  ['git stash push -u -m wip'],
  ['git restore src/x.ts'],
  ['git restore --staged --worktree src/x.ts'],
  ['git checkout -- src/x.ts'],
  ['git checkout HEAD src/x.ts'],
  ['git checkout main -- .'],
  ['bash -c "git stash && git pull"'],
  // a minion's worktree doesn't push main or force
  ['git push origin main'],
  ['git push origin HEAD:main'],
  ['git push origin ticket/9:refs/heads/main'],
  ['git push -u origin :master'],
  ['git push origin main:'],
  ['git push --repo=origin main'],
  ['git push --all origin'],
  ['git push origin :'],
  ["git push origin 'refs/heads/*:refs/heads/*'"],
  ['git push --force origin ticket/9'],
  ['git push -fu origin ticket/9'],
  ['git push origin +ticket/9'],
  ['git push --delete origin main'],
  ['git push --repo origin main'],
  // #468 S01-1: a command in a double-quoted $( … ) or backtick capture is checked like an unquoted one
  ['x="$(pkill -f dev.ts)"'],
  ['echo "$(git stash)"'],
  [`out="$(rm -rf ${data}/state.db 2>&1)"`],
  ['PIDS="$(ss -ltnp | grep node | cut -d= -f2)"; kill $PIDS'],
  ['kill "$(ss -ltnp | grep ":$P " | grep -o \'pid=[0-9]*\' | cut -d= -f2)"'],
  ['KEY="$(cat ~/.ssh/id_rsa)"'],
  ['echo "$(cd ~/claude-coordinator && git reset --hard origin/main)"'],
  ['if [ -n "$(systemctl --user restart claude-coordinator)" ]; then echo x; fi'],
  ['echo "`pkill -f node`"'],
  ['echo "a $(echo ")") b $(pkill -f node)"'],
  ['echo "$(echo "$(cat ~/.ssh/id_rsa)")"'],
  [`git commit -m "$(cat <<'EOF'\nA message (with a paren and a " quote\nEOF\n)" && git stash`],
  // #468 S01-8: a heredoc opened with <<\EOF ends at EOF, and what follows it is checked
  [`cat <<\\EOF > /tmp/x\nhi\nEOF\nrm -rf ${data}/state.db`],
  ['cat <<\\EOF\nhi\nEOF\npkill -f node'],
  ['git commit -m "$(cat <<\\EOF\nmsg\nEOF\n)" && git stash'],
  // #468 S01-2: the live tools/deploy.sh may run, but naming it doesn't let a write to the live checkout through
  ['cp tools/deploy.sh ~/claude-coordinator/tools/deploy.sh'],
  ['rm -f ~/claude-coordinator/tools/deploy.sh', 'deploy'],
  ['cd ~/claude-coordinator && git checkout -- tools/deploy.sh', 'deploy'],
  ["cd ~/claude-coordinator && sed -i 's/a/b/' tools/deploy.sh"],
  ['cd ~/claude-coordinator && git commit -am x tools/deploy.sh', 'deploy'],
  ['cp ~/claude-coordinator/tools/deploy.sh ~/claude-coordinator/tools/land.sh', 'deploy'],
  ['echo ~/claude-coordinator/tools/deploy.sh; systemctl --user restart claude-coordinator', 'deploy'],
  // #468 S01-4: a kill fed by a process listing is pkill spelled out
  ["ps -ef | grep dev.ts | awk '{print $2}' | xargs kill -9"],
  ["kill -9 $(ps aux | grep '[n]ode' | awk '{print $2}')"],
  ['kill $(pgrep -f node)'],
  ['pgrep -f dev.ts | xargs kill'],
  ['PIDS="$(pgrep -f dev.ts)"; kill $PIDS'],
  ['for p in $(pgrep node); do kill $p; done'],
  ['for p in $(pgrep node); do readlink /proc/$q/cwd && kill $p; done'],
  // #454 killed its own shell with the first (#485)
  ['kill $(pgrep -f "PORT=19860")'],
  ['pgrep -f dotnet | xargs kill'],
  // a per-pid check doesn't excuse a kill fed by the socket table
  ['for p in $(ss -ltnp | grep node | grep -o "[0-9]\\{4,\\}"); do [ "$(readlink /proc/$p/cwd)" = "$PWD" ] && kill $p; done'],
  // #468 S01-5: the sqlite3 rules still cover the live data dir's own databases and other schemes' folders
  [`sqlite3 ${data}/state.db 'create table t(x)'`],
  [`sqlite3 ${data}/coordinator.db < q.sql`],
  [`cd ${data} && sqlite3 -readonly coordinator.db .dump`],
  [`sqlite3 ${data}/backups/coordinator-2026-11-01.db "select * from credentials"`],
  [`sqlite3 ${data}/projects/1/tickets/3/state.db "select 1"`],
  [`sqlite3 -readonly ${data}/projects/1/repo/app.db < q.sql`],
  ["sqlite3 ~/.local/share/claude-*/state.db 'select 1'"],
  // #468 S01-9: after a cd the tripwire can't follow, a push still can't name main or force
  ['cd "$WT" && git push origin main'],
  ['cd "$WT" && git push --force origin main'],
  ['cd "$WT" && git push --force origin topic'],
  ['git -C "$WT" push origin HEAD:main'],
  // #468 S01-10: comparisons in (( )) and [[ ]] aren't redirects, but a redirect next to them still is
  [`(( n > 1 )) && echo x > ${data}/state.db`],
  [`[[ -n $x ]] && echo x > ${data}/state.db`],
  [`[[ $a > $b ]]; echo x > ${data}/state.db`],
  [`((cat x) > ${data}/state.db)`],
  [`[[ $(echo x > ${data}/state.db) ]]`],
  ['echo $(( $(pkill -f node) + 1 ))'],
  [`echo "$(( n > 1 ))" > ${data}/state.db`],
  // #468 S01-10 review: a redirect glued to the ]] that ends the condition
  ['[[ 1 ]]>>~/.local/share/claude-coordinator/coordinator.db'],
  ['[[ 1 ]]>~/claude-coordinator/src/server.ts'],
  [`[[ -n $x ]]&>${data}/state.db`],
  [`[[ $a < $b ]]<${home}/.ssh/id_rsa`],
  // #468 S01-11: server.ts as the script, an option's value, or the argument of an eval still runs it
  ['node --import ./x.ts server.ts'],
  ['node -r ./x.cjs --env-file .env server.ts'],
  ['node -e "import(process.argv[1])" server.ts'],
  ['deno run -A server.ts'],
  ["PORT=8700 bash -c 'node server.ts'"],
  ["DATA_DIR=/tmp/d bash -c 'node tools/x.ts && node server.ts'"],
  // #468 S01-11 review: an option the tripwire doesn't know may take the next word as its value, so server.ts after it may be the script
  ['node --diagnostic-dir ./diag server.ts'],
  ['cd ~/claude-coordinator && node --heap-prof-dir ./h server.ts'],
  ['node --diagnostic-dir /tmp server.ts'],
  ['node --cpu-prof-dir ./p --report-dir ./r server.ts'],
  ['node --some-future-option ./x.ts server.ts'],
  // #468 S01-1 review: variables set inside a $( … ), backticks or a ( … ) subshell end with it
  ['echo "$(DATA_DIR=/tmp PORT=9999)"; node server.ts'],
  ['echo $(DATA_DIR=/tmp PORT=9999); node server.ts'],
  ['echo `DATA_DIR=/tmp PORT=9999`; node server.ts'],
  ['x="$(export DATA_DIR=/tmp PORT=9999)" && node server.ts'],
  ['(DATA_DIR=/tmp PORT=9999); node server.ts'],
  ['(export DATA_DIR=/tmp; PORT=9999) && node server.ts'],
  // #468 S01-12: a search pattern or a message isn't read, but the files a command reads still are
  ['grep -e token ~/.ssh/id_rsa'],
  ['grep -f ~/.ssh/id_rsa src/x.ts'],
  ['grep /home/u/.ssh/id_rsa ~/.ssh/id_rsa'],
  ['git commit -F ~/.ssh/id_rsa'],
  ['git commit -m x -- ~/.ssh/id_rsa'],
  ['git commit -m x /home/josh/notes.md'],
  ['git -C /home/josh/repo commit -m x'],
  ['gh pr create --title x --body-file ~/.ssh/id_rsa'],
  ['watch systemctl --user restart claude-coordinator'],
  // #468 S01-13: a glob one level down in the scheme's folder, and ~<own name> for ~
  ['rm -rf ../*'],
  [`rm -rf ${data}/projects/2/tickets/*`],
  ['rm -rf "$TMPDIR"/../*'],
  ['rm -rf ~u/.local/share/claude-coordinator/state.db'],
  ['cat ~u/.ssh/id_rsa'],
  ['D=~u/.local/share/claude-coordinator; rm -f $D/state.db'],
  // #468 S01-14: what stays blocked next to command -v and perl -M
  ['command pkill -f node'],
  ['command -p pkill -f node'],
  ["perl -Mstrict -pi -e 's/a/b/' ~/claude-coordinator/src/x.ts"],
  ["perl -MList::Util -i -pe 's/a/b/' ~/.local/share/claude-coordinator/state.db"],
  // #468 S01-15: flock's lock file, a -c string, systemctl option values and unit globs
  ['flock /tmp/l rm -rf ~/.local/share/claude-coordinator/state.db'],
  ['flock -w 5 /tmp/l pkill -f node'],
  ["flock /tmp/l -c 'rm -rf ~/.local/share/claude-coordinator/state.db'"],
  ['systemctl --user -s KILL kill claude-coordinator'],
  ['systemctl --user --signal KILL kill claude-coordinator'],
  ["systemctl --user restart 'claude-coordinator*'"],
  ["systemctl --user stop 'citadel-*'"],
  ['D=~/.local/share/claude-coordinator; [ -n "$X" ] && D=/tmp/x; rm -f $D/state.db'],
  ['D=~/.local/share/claude-coordinator; [ -z "$X" ] || D=/tmp/x; rm -f $D/state.db'],
];

const ALLOWED = [
  // normal work in the worktree
  'cat ~/.codex/config.toml && codex --version',
  'git status && git diff --stat',
  'git add -A && git commit -m "Tripwire: block writes to ~/.ssh and ~/claude-coordinator"',
  'git commit -F - <<EOF\nBlocks cat ~/.ssh/id_rsa and rm -rf ~/claude-coordinator\nEOF',
  'git commit -m "$(cat <<\'EOF\'\nTwo fixes:\n1) cat ~/.ssh/id_rsa is blocked\n2) so is rm -rf ~/claude-coordinator\nEOF\n)" && git log -1',
  'node --test test/',
  'node --check server.ts',
  'kill $P',
  'kill "$(cat $TMPDIR/dev.pid)"',
  'pgrep -af "app/dev/dev.ts"',
  // ss or lsof picking the port itself, and listings that only check
  "kill $(ss -ltnp 'sport = :8080' | grep -o 'pid=[0-9]*' | cut -d= -f2)",
  'kill $(ss -Htlnp "sport = :$P" | grep -oP "pid=\\K[0-9]+")',
  'kill $(lsof -ti :8080)',
  'lsof -t -i tcp:$P | xargs -r kill',
  'kill $p; sleep 1; ss -ltn | grep -c ":$P "',
  'ss -ltnp | grep node; kill $!',
  'P=$(ss -ltnp | grep -c node); echo $P; kill $SERVER_PID',
  'P=$(ss -ltnp | grep node | cut -d= -f2); P=$!; kill $P',
  'for p in $(pgrep -f "^node app/dev/dev.ts"); do [ "$(readlink /proc/$p/cwd)" = "$PWD" ] && kill $p; done; ss -ltn | grep -c 8080',
  'DATA_DIR=$(mktemp -d) PORT=8123 node server.ts',
  'export DATA_DIR=/tmp/d PORT=8124; node server.ts &',
  'env DATA_DIR=/tmp/d PORT=8125 node server.ts',
  'npm test',
  'podman build -t x . && podman run --rm -p 127.0.0.1:8001:80 x',
  'dotnet build Delve.sln',
  'rm -rf node_modules /tmp/scratch',
  'echo hi > /dev/null 2>&1',
  'ls ~ && cd ~ && ls',
  'mkdir -p ~/.local/share/claude-coordinator/projects/2/shared/123 && cp x.png ~/.local/share/claude-coordinator/projects/2/shared/123/',
  'echo note > ~/.local/share/claude-coordinator/projects/2/shared/project/handoff.md',
  // reading live state
  'sqlite3 -readonly ~/.local/share/claude-coordinator/coordinator.db "select count(*) from tickets"',
  'sqlite3 "file:/home/u/.local/share/claude-coordinator/coordinator.db?mode=ro" .tables',
  'ls -la ~/.local/share/claude-coordinator/',
  'du -sh ~/.local/share/claude-coordinator/*',
  'cat ~/.config/systemd/user/claude-coordinator.service',
  'grep -rn foo ~/claude-coordinator/src | head',
  'find ~/claude-coordinator -name "*.ts" -exec grep -l Runner {} \\;',
  'for f in ~/claude-coordinator/src/*.ts; do wc -l $f; done',
  'git -C ~/claude-coordinator log --oneline -5',
  'cd ~/claude-coordinator && git status && git rev-parse HEAD',
  'git -C ~/claude-coordinator fetch',
  'git -C ~/.local/share/claude-coordinator/projects/1/repo log -3',
  'cat ~/.local/share/claude-coordinator/projects/1/shared/project/plan.md',
  'diff ~/claude-coordinator/server.ts server.ts',
  'cp ~/claude-coordinator/README.md /tmp/',
  'systemctl --user status claude-coordinator',
  'journalctl --user -u claude-coordinator -n 50',
  // the deploy routine
  'git -C ~/claude-coordinator pull --ff-only /home/u/.local/share/claude-coordinator/projects/2/repo main',
  'cd ~/claude-coordinator && git pull --ff-only ~/.local/share/claude-coordinator/projects/2/repo main',
  'systemd-run --user --collect --unit=cc-restart-when-idle --description="Restart when idle" /tmp/cc-restart-when-idle.sh',
  '~/claude-coordinator/tools/deploy.sh',
  'tools/deploy.sh',
  'git fetch -q && git rebase main && tools/deploy.sh 2>&1 | tail -20',
  'cd ~/claude-coordinator && ./tools/deploy.sh',
  'systemd-run --user --unit=cc-restart-when-idle bash /home/u/claude-coordinator/tools/deploy.sh',
  // the scheme's own main checkout
  'git -C ~/.local/share/claude-coordinator/projects/2/repo merge --ff-only ticket/55',
  // ssh and git use keys on their own
  'ssh -i ~/.ssh/id_ed25519 host uptime',
  'git push origin HEAD',
  // git habits that stay allowed
  'git stash list && git stash show -p stash@{0}',
  'git restore --staged src/x.ts',
  'git checkout -b ticket/10',
  'git checkout -B ticket/10 main',
  'git reset src/x.ts && git reset --soft HEAD~1',
  'git push -u origin ticket/9',
  'git push --force-with-lease origin ticket/9',
  'git push -o ci.skip origin ticket/9',
  'git push --tags',
  // paths that only look protected
  'echo "~/.ssh is off limits"',
  "cat '$HOME/.ssh/x'",
  'cat $SOMEDIR/coordinator.db > out.txt',
  'gh pr create --body "see ~/claude-coordinator/README.md"',
  // reads the replay of past turns turned up
  `node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync(process.argv[1],{readOnly:true})" ~/.local/share/claude-coordinator/coordinator.db`,
  'sqlite3 ~/.local/share/claude-coordinator/coordinator.db "select project_id, number from tickets where status=\'running\'"',
  'cd ~/.local/share/claude-coordinator && sqlite3 "file:coordinator.db?mode=ro" ".backup coordinator.db.bak-x"',
  'git clone -q ~/.local/share/claude-coordinator/projects/1/repo /tmp/delve',
  'ls -la ~/.claude/.credentials.json ~/.ssh',
  // normal process and env inspection next to the #115 blocks
  'ps aux | grep node',
  'ps -ef | grep claude',
  'ps -eo pid,etime,cmd --sort=etime',
  'ps -p 1234 -o pid,comm,etime',
  'cat /proc/1234/status && cat /proc/meminfo',
  'ls -la /proc/1234/',
  'ls -la ~/.config/claude-coordinator/',
  'echo "$PATH" && [ -n "$GH_TOKEN" ] && echo set',
  'env DATA_DIR=/tmp/d PORT=8126 node --test test/',
  'sqlite3 -readonly ~/.local/share/claude-coordinator/state.db "select count(*) from claude_state"',
  'sqlite3 -readonly ~/.local/share/claude-coordinator/coordinator.db ".dump tickets"',
  'grep -rn credentials src test',
  'claude --version && claude -p "say hi" --model haiku',
  'claude -p login --model haiku',
  'curl -s localhost:8573/api/health',
  'ls /home && ls -la /home/josh',
  'rg -n runner ~/.local/share/claude-coordinator/projects/2/shared',
  'grep -n environ src/tripwire.ts',
  'gh auth status && gh pr view 3',
  'test -n "$GH_TOKEN" && echo linked',
  'env -u PORT node x.ts',
  'gh auth git-credential get',
  'cat ~/.config/gh/config.yml',
  'git commit -m "Tripwire: block reads of /proc/1/environ and /proc/*/environ"',
  "gh pr create --title x --body 'Blocks /proc/$PID/environ reads'",
  'git commit -F - <<EOF\nBlocks cat /proc/$(pgrep node)/environ\nEOF',
  'cat /tmp/x/proc/1/environ',
  'ps -C node -o pid,etime',
  'ps --sort etime -e',
  'ps -u cara -o pid,cmd | grep server',
  'grep -rn foo src ~/.claude/projects',
  'rg foo ~/.local/share/claude-coordinator/projects/2/shared',
  'grep -n token ~/.config/gh/config.yml',
  'grep -rn "/home/u" src',
  'rg -t ts "/home/u/.config" docs',
  'grep -rn -A 3 /home/u/.config src test',
  'gh search issues auth token',
  'podman exec perigee-godot godot --version',
  'podman ps -a && podman images',
  'podman logs perigee-godot',
  'podman run --rm docker.io/library/alpine:3 echo hi',
  'systemctl --user status citadel-claude-3',
  'gh issue create -t auth -b token',
  'rg -n "/" src',
  'cd ~/claude-coordinator && git pull --ff-only /home/u/.local/share/claude-coordinator/projects/2/repo main && systemd-run --user --collect --unit=cc-restart-when-idle /tmp/cc-restart-when-idle.sh',
  'cd ~/claude-coordinator && curl -s localhost:8573/api/version && gh pr list',
  'chmod 600 ~/.local/share/claude-coordinator/coordinator.db*',
  'env $E PORT=8617 DATA_DIR=/tmp/d node server.ts',
  `node -e "for (const c of ['node server.ts', 'ls']) console.log(label(c))"`,
  'git -C ~/claude-coordinator archive HEAD | tar -t | head',
  'cd ~/claude-coordinator && git status && R=/x/repo; git -C $R merge --ff-only ticket/6',
  'sqlite3 ~/.local/share/claude-coordinator/coordinator.db ".backup $D/coordinator.db"',
  "cd ~/.local/share/claude-coordinator/projects/2/tickets/9 && perl -pi -e 's/a\\/b/c/g' src/x.ts",
  "sed -i 's#/home/u/claude-coordinator#~/app#' README.md",
  // #251: variables the command sets, or the turn's TMPDIR, are followed, so scratch work stays easy
  'rm -rf "$TMPDIR/out" && mkdir -p "$TMPDIR/out"',
  'd="$TMPDIR/out"; rm -rf "${d:?}"/*',
  'rm -rf "$TMPDIR"/*',
  'D=/tmp/x; rm -rf $D/state.db',
  'T=$(mktemp -d); cp a.db $T/; rm -rf $T',
  'D="$(mktemp -d /tmp/c86-XXXX)"; sqlite3 -readonly ~/.local/share/claude-coordinator/coordinator.db ".backup $D/coordinator.db"; sqlite3 $D/coordinator.db "delete from push_subscriptions"; rm -rf "$D"',
  'f=$(mktemp); echo hi > "$f"; rm -f "$f"',
  `D=${data}; sqlite3 -readonly $D/state.db "select 1"; cp $D/coordinator.db "$TMPDIR/"; ls -la $D`,
  'sqlite3 -readonly ~/.local/share/claude-coordinator/coordinator.db ".backup $TMPDIR/copy.db"',
  // The copy the block messages advise (#497).
  `sqlite3 -readonly ~/.local/share/claude-coordinator/coordinator.db "VACUUM INTO '$TMPDIR/copy.db'"`,
  'rm -f /tmp/cc-$USER.log out-$N.txt',
  'for f in src/*.ts test/*.ts; do sed -i "s/a/b/" "$f"; done',
  'for f in a.png b.png; do mv "$f" "$TMPDIR/"; done',
  'cd "$(git rev-parse --show-toplevel)" && rm -rf node_modules',
  'echo scratch/ >> "$(git rev-parse --git-path info/exclude)"',
  'git diff --name-only | xargs grep -n TODO',
  'find . -name "*.orig" -delete',
  `rm -rf ${data}/projects/2/tickets/9/build ${data}/projects/2/shared/9`,
  'git commit -m "$(cat <<\'EOF\'\nBlocks D=x; rm -f $D/state.db\nEOF\n)"',
  'rm -rf $(pwd)/build',
  "bash <<'EOF'\nnpm test\nrm -rf /tmp/x\nEOF",
  'env -i PATH="$PATH" HOME="$HOME" DATA_DIR=/tmp/d PORT=8691 SESSION_SECRET=$(head -c 32 /dev/urandom | base64) node server.ts',
  // #468 S01-1: quoted captures of harmless commands, and a quoted heredoc message that mentions anything
  'echo "$(date +%F) on $(git rev-parse --short HEAD)"',
  'x="$(echo \')\')"; echo "$x"',
  'echo "`git rev-parse HEAD`"',
  `git commit -m "$(cat <<'EOF'\nSay "run git push origin main" and fix the 5" width (and pkill -f node\nrm -rf ${data}/state.db\nEOF\n)" && git log -1`,
  // #468 S01-8: the body of a <<\EOF heredoc is still skipped
  'cat <<\\EOF > /tmp/x\npkill -f node and rm -rf ~/claude-coordinator\nEOF\nls',
  // #468 S01-4: a process listing whose pids are each checked first, or a ps of one pid
  'pgrep -f dev.ts | while read p; do [ "$(readlink /proc/$p/cwd)" = "$PWD" ] && kill $p; done',
  'ps -p $PID -o pid= && kill $PID',
  'kill $(ps -o pid= -p $(cat $TMPDIR/dev.pid))',
  // #468 S01-5: a minion's own databases, in its worktree or TMPDIR (under the scheme's own folder)
  'sqlite3 app.db < schema.sql',
  'cat schema.sql | sqlite3 "$TMPDIR/test.db"',
  'sqlite3 app.db .dump',
  "sqlite3 dev.db 'select * from credentials'",
  "sqlite3 state.db 'create table t(x)'",
  "sqlite3 \"$TMPDIR/state.db\" 'select 1'",
  // #468 S01-9: after a lost cd, a push of a named branch, or of HEAD (its branch unknown)
  'cd "$WT" && git push -u origin ticket/9',
  'cd "$WT" && git push --force-with-lease origin HEAD',
  // #468 S01-10: < and > compare in (( )), $(( )) and [[ ]]
  '(( total > $LIMIT )) && echo big',
  'if (( $n > $m )); then echo x; fi',
  'if [[ "$a" > "$b" ]]; then echo x; fi',
  '[[ $a < $b && $c > $d ]] && echo ok',
  'echo $(( n > $m )) "$(( n << $k ))"',
  'while (( i < $N )); do i=$((i + 1)); done',
  // #468 S01-11: server.ts as another script's argument, and a shell started with both variables set
  'node tools/count.ts src/server.ts',
  'node --test-reporter spec tools/count.ts ~/claude-coordinator/server.ts',
  "DATA_DIR=/tmp/d PORT=8700 bash -c 'node server.ts'",
  // #468 S01-11 review: an option's value or a known flag before the script, then server.ts as its argument
  'node --diagnostic-dir ./diag tools/count.ts src/server.ts',
  'node --experimental-strip-types tools/count.ts src/server.ts',
  'node --no-warnings --test-reporter=spec tools/count.ts src/server.ts',
  // #468 S01-1 review: variables set inside a subshell or capture hold inside it, and one set from a capture holds after
  '(DATA_DIR=/tmp/d PORT=8700; node server.ts)',
  'echo "$(DATA_DIR=/tmp/d PORT=8700 node --check server.ts; export DATA_DIR=/tmp/d PORT=8700; node server.ts)"',
  'DATA_DIR="$(mktemp -d)" PORT=8700; node server.ts',
  'D=/tmp/x; (D=~/.local/share/claude-coordinator); rm -rf $D/build',
  // #468 S01-12: words that only look like paths: a search pattern, a commit message or PR text, an echoed systemctl
  "grep -rn '/home/cody' src",
  "grep -n '~/.ssh' README.md",
  "grep -rn '/proc/self/environ' src test",
  "rg -n -e '/home/cody' -e '~/.ssh/id_rsa' src",
  "git commit -m '/home/josh paths are blocked now'",
  "git commit -am '~/.ssh is off limits'",
  "git commit --message='/proc/1/environ is blocked'",
  "gh pr create --title '/home/josh is blocked' --body '~/.ssh/id_rsa too'",
  'echo systemctl --user restart claude-coordinator',
  // #468 S01-13: a glob inside the minion's own worktree or TMPDIR
  `rm -rf ${data}/projects/2/tickets/9/build/* ../9/dist/*`,
  'ls ~u && ls ~u/.config',
  // #468 S01-14: command -v only looks a name up; perl -M loads a module
  'command -v pkill',
  'command -V pkill && command -v killall',
  'perl -Mstrict -e \'print 1\' "$f"',
  'perl -MList::Util=sum -e \'print sum(1, 2)\' "$f"',
  'perl -Ilib -wMstrict -e \'print 1\' "$f"',
  // #468 S01-15: the other side of each
  'flock /tmp/l npm test',
  'flock -w 5 /tmp/l -c "npm test"',
  'flock 9',
  'cd tools && ./deploy.sh',
  'systemctl --user -n 50 status claude-coordinator',
  "systemctl --user restart 'my-app*'",
  'D=/tmp/a; [ -n "$X" ] && D=/tmp/b; rm -rf $D/build',
  '[ -n "$D" ] || D=/tmp/x; rm -rf $D/build',
];

// Things a person may reasonably allow once: a card for that exact call.
const ASKS = [
  // a deploy that cuts off running turns
  'tools/deploy.sh --now',
  'git rebase main && ./tools/deploy.sh --now 2>&1 | tail -20',
  // #468 S01-15: run from its own folder
  'cd tools && ./deploy.sh --now',
  'cd ~/claude-coordinator/tools && ./deploy.sh --now',
  // data-dir files other than the live database
  'rm ~/.local/share/claude-coordinator/coordinator.db.bak-machines ~/.local/share/claude-coordinator/coordinator.db.bak-x',
  'cd ~/.local/share/claude-coordinator && rm coordinator.db.bak-*',
  'echo x > ~/.local/share/claude-coordinator/coordinator.db.bak-machines',
  'echo x>>~/.local/share/claude-coordinator/vapid.json',
  'mv ~/.local/share/claude-coordinator/old ~/.local/share/claude-coordinator/old-2',
  'rm ~/.local/share/claude-coordinator/backups/$F',
  'rm -rf ~u/.local/share/claude-coordinator/backups',
  // #468 S01-15: the change of D may not run
  'D=~/.local/share/claude-coordinator; [ -n "$X" ] && D=/tmp/x; rm -rf $D/backups',
  // #468 S01-1 review: a subshell's D=… doesn't change D after it
  'D=~/.local/share/claude-coordinator; (D=/tmp/x); rm -rf $D/backups',
  'D=~/.local/share/claude-coordinator; echo "$(D=/tmp/x)"; rm -rf $D/backups',
  // nor does one in a bash -c string, which runs in a shell of its own
  "D=~/.local/share/claude-coordinator; bash -c 'D=/tmp/x'; rm -rf $D/backups",
  // SQL on the live database, when the card can show all of it
  `sqlite3 ${data}/coordinator.db "delete from tickets where id = 3"`,
  'sqlite3 ~/.local/share/claude-coordinator/coordinator.db "update tickets set state=null"',
  'cd ../../../.. && sqlite3 coordinator.db "vacuum"',
  'sqlite3 -json ~/.local/share/claude-coordinator/coordinator.db "select 1; delete from events"',
  // installing and enabling user units
  'cp deploy/backup.timer ~/.config/systemd/user/',
  'ln -s $PWD/x.container ~/.config/containers/systemd/x.container',
  'systemctl --user enable cc-backup.timer',
  'systemctl --user link ~/repo/deploy/cc-backup.service && systemctl --user daemon-reload',
];

for (const [command, mode] of BLOCKED) {
  test(`blocks: ${command}`, () => {
    const v = verdict(command, worktree, mode === 'deploy' ? { ...cfg, deployScript: true } : cfg);
    assert.ok(v, 'expected a block');
    assert.equal(v.ask, false, 'expected a hard block, not a card');
  });
}
for (const command of ASKS) {
  test(`asks: ${command}`, () => assert.equal(verdict(command)?.ask, true));
}
for (const command of ALLOWED) {
  test(`allows: ${command}`, () => assert.equal(bash(command), null));
}

test('every kill-by-name refusal names a way to stop your own server that the tripwire allows (Mandate #86)', () => {
  for (const no of ['pkill -f dev.ts', 'killall node', 'kill $(pgrep -f dev.ts)', 'kill $(ss -ltnp | grep ":$P " | grep -o "pid=[0-9]*" | cut -d= -f2)']) {
    const why = bash(no) ?? '';
    assert.match(why, /`kill <pid>` with the pid it printed when it started/, no);
    const look = why.match(/`(ss -ltnp 'sport = :<your port>')`/)?.[1];
    assert.ok(look, no);
    for (const ok of [look.replace('<your port>', '18431'), 'kill 41234', 'kill $!']) assert.equal(bash(ok), null, ok);
  }
});

test('git habits: path checkouts and moves over uncommitted changes, read from the real repo', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tripwire-git-'));
  // The real home: a turn's TMPDIR is under it (#218), where cfg's /home/u would make the scratch another person's.
  const c = { ...cfg, home: homedir(), data: tmp };
  const wt = join(tmp, 'projects/2/tickets/9');
  const sh = (cmd: string, cwd = wt) => execSync(cmd, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  try {
    mkdirSync(join(wt, 'sub'), { recursive: true });
    sh('git init -q -b ticket/9 && echo a > a.txt && echo c > sub/c.txt && git add a.txt sub/c.txt && git commit -qm a');
    sh('git branch other');
    const at = (command: string, cwd: string | null = wt) => tripwire({ tool_name: 'Bash', tool_input: { command }, cwd }, c)?.reason ?? null;

    // A clean tree moves freely; a name that isn't a branch or commit is a path.
    for (const ok of ['git checkout other', 'git merge other', 'git reset --hard', 'git rebase other', 'git checkout -f']) assert.equal(at(ok), null, ok);
    assert.match(at('git checkout a.txt')!, /names a path.*git show HEAD:path/);
    assert.match(at("git checkout 'sub/*.txt'")!, /names a path/);
    // A name that is neither (a branch on some remote for git to set up, a typo) is left to git.
    assert.equal(at('git checkout feature-on-upstream'), null);

    // Untracked files don't count; a changed tracked file does.
    writeFileSync(join(wt, 'b.txt'), 'b');
    assert.equal(at('git checkout other'), null);
    writeFileSync(join(wt, 'a.txt'), 'changed');
    for (const move of ['git checkout other', 'git switch other', 'git merge other', 'git reset --hard HEAD', 'git rebase other', 'git pull', 'git cherry-pick other', 'cd sub && git merge other']) {
      assert.match(at(move) ?? '', /^Commit first: .* 1 uncommitted tracked file\(s\) \(a\.txt\)/, move);
    }
    // A path checkout's refusal names the way to put one file back, and that way is allowed (Mandate #86's logs).
    assert.match(at('git checkout -- a.txt')!, /`git show HEAD:\.\/path > path`/);
    assert.match(at('git restore a.txt')!, /`git show HEAD:\.\/path > path`/);
    for (const ok of ['git show HEAD:./a.txt > a.txt', `git show HEAD:./a.txt > ${wt}/a.txt`, `git -C ${wt} show HEAD:./a.txt > ${wt}/a.txt`]) assert.equal(at(ok), null, ok);
    sh('git show HEAD:./a.txt > a.txt');
    // `./` reads the path from the folder it runs in, so it is right from a subfolder too.
    writeFileSync(join(wt, 'sub/c.txt'), 'changed');
    assert.equal(at('git show HEAD:./c.txt > c.txt', join(wt, 'sub')), null);
    sh('git show HEAD:./c.txt > c.txt', join(wt, 'sub'));
    assert.equal(sh('git status --porcelain --untracked-files=no').toString(), '', 'both files are back as they were at HEAD');
    writeFileSync(join(wt, 'a.txt'), 'changed');
    assert.match(at(`git -C ${wt} merge other`, '/tmp')!, /Commit first/);
    assert.match(at('git checkout -')!, /Commit first/);
    // A forced checkout with no branch throws the changes away too (#468 S01-3).
    for (const move of ['git checkout -f', 'git checkout --force', 'git checkout -qf']) assert.match(at(move) ?? '', /^Commit first: .* \(a\.txt\)/, move);
    // Committing earlier in the same call is the normal way to move.
    assert.equal(at('git add -A && git commit -qm wip && git checkout other'), null);
    for (const ok of ['git checkout -b x', 'git reset a.txt', 'git merge --abort', 'git rebase --continue', 'git commit -am wip && git status']) assert.equal(at(ok), null, ok);
    // An unknown folder lets it through.
    assert.equal(at('git merge other', null), null);

    // A worktree on main: a push with no branch named would push main.
    sh('git commit -qam wip && git checkout -q -b main');
    assert.match(at('git push')!, /current branch is main/);
    assert.match(at('git push origin HEAD')!, /Pushing to main/);
    assert.equal(at('git push --tags'), null);
    // Outside a minion's worktree (a Taskmaster's folder, the scheme repo), pushes are left to the scheme.
    const repo = join(tmp, 'projects/2/repo');
    mkdirSync(repo);
    assert.equal(at('git push origin main', repo), null);
    assert.equal(at('git push --force origin x', repo), null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a soft or mixed reset onto a commit the branch lacks is refused: the next commit would revert it (Peek Auras #309)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tripwire-squash-'));
  const c = { ...cfg, home: homedir(), data: tmp };
  const wt = join(tmp, 'projects/2/tickets/9');
  const sh = (cmd: string) => execSync(cmd, { cwd: wt, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString().trim();
  try {
    mkdirSync(wt, { recursive: true });
    // A default branch called trunk: nothing here may lean on the name main.
    sh('git init -q -b trunk && echo a > a.txt && git add a.txt && git commit -qm a && git checkout -qb ticket/9-x && echo b > b.txt && git add b.txt && git commit -qm b');
    sh('git checkout -q trunk && echo c > c.txt && git add c.txt && git commit -qm c && git update-ref refs/remotes/origin/trunk trunk && git checkout -q ticket/9-x');
    const at = (command: string, cwd: string | null = wt) => tripwire({ tool_name: 'Bash', tool_input: { command }, cwd }, c)?.reason ?? null;
    const tip = sh('git rev-parse trunk');
    const no = ['git reset --soft trunk', 'git reset --soft origin/trunk', `git reset --soft ${tip}`, 'git reset trunk', 'git reset -q --mixed trunk', `git -C ${wt} reset --soft trunk`, 'git reset --soft trunk --'];
    // What leaves HEAD where it is earlier in the same call doesn't excuse it (#677 review).
    no.push('git merge --abort; git reset --soft trunk', 'git rebase --abort && git reset --soft trunk', 'git checkout -b ticket/10-y && git reset --soft trunk', 'git cherry-pick abc123 && git reset --soft trunk');
    for (const cmd of no) {
      assert.match(at(cmd, cmd.includes(' -C ') ? '/tmp' : wt) ?? '', /would revert .*`git rebase .*git reset --soft \$\(git merge-base HEAD /s, cmd);
    }
    // Squashing onto where the branch started, a path, a hard reset, or a reset after a rebase in the same call.
    const base = sh('git merge-base HEAD trunk');
    for (const ok of ['git reset --soft HEAD~1', `git reset --soft ${base}`, 'git reset --soft $(git merge-base HEAD trunk)', 'git reset a.txt', 'git reset -- trunk', 'git reset trunk -- a.txt', 'git reset --hard trunk', 'git rebase -q trunk && git reset --soft trunk']) {
      assert.equal(at(ok), null, ok);
    }
    // Undoing an amend: the commit before it is on no branch, and nothing is reverted.
    sh('git commit -q --amend -m b2');
    assert.equal(at('git reset --soft HEAD@{1}'), null);
    // A branch rebased onto the tip squashes onto it freely.
    sh('git rebase -q trunk');
    assert.equal(at('git reset --soft trunk'), null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('once tools/deploy.sh exists, it is still allowed', () => {
  assert.equal(bash('~/claude-coordinator/tools/deploy.sh', worktree, { ...cfg, deployScript: true }), null);
  // Run through a shell or systemd-run too (#468 S01-2).
  for (const command of ['bash ~/claude-coordinator/tools/deploy.sh', 'cd ~/claude-coordinator && sh -x tools/deploy.sh', 'systemd-run --user --collect --unit=cc-deploy bash /home/u/claude-coordinator/tools/deploy.sh', 'cd ~/claude-coordinator && ./tools/deploy.sh 2>&1 | tail -5']) {
    assert.equal(bash(command, worktree, { ...cfg, deployScript: true }), null, command);
  }
});

test('a Taskmaster in its own scheme folder can work; one in another scheme cannot write', () => {
  assert.equal(bash('echo x > notes.md', `${data}/projects/2/coordinator`), null);
  assert.ok(bash('echo x > notes.md', `${data}/projects/1/coordinator`));
  assert.ok(tripwire({ tool_name: 'Bash', tool_input: { command: 'touch x' } , cwd: `${data}/projects/2/coordinator` }, { ...cfg, project: 1 }));
});

test('an ask is a hard block without an explanation, in a Taskmaster turn, or from a file tool', () => {
  const command = 'systemctl --user enable cc-backup.timer';
  for (const description of [undefined, '', 'Enable timer']) {
    const v = tripwire({ tool_name: 'Bash', tool_input: { command, description }, cwd: worktree }, { ...cfg, ask: true });
    assert.equal(v?.ask, false, String(description));
    assert.match(v!.reason, /only with an explanation/);
  }
  assert.equal(tripwire({ tool_name: 'Bash', tool_input: { command, description: WHY }, cwd: worktree }, cfg)?.ask, false);
  assert.equal(tripwire({ tool_name: 'Write', tool_input: { file_path: `${data}/coordinator.db.bak-x` }, cwd: worktree }, { ...cfg, ask: true })?.ask, false);
});

test('file tools: writes, edits and reads', () => {
  const t = (tool_name: string, tool_input: object) => tripwire({ tool_name, tool_input, cwd: worktree }, cfg)?.reason ?? null;
  assert.ok(t('Write', { file_path: `${home}/claude-coordinator/src/x.ts` }));
  assert.ok(t('Edit', { file_path: `${home}/.config/claude-coordinator/env` }));
  assert.ok(t('MultiEdit', { file_path: `${data}/projects/1/tickets/3/a.ts` }));
  assert.ok(t('NotebookEdit', { notebook_path: `${home}/.config/systemd/user/x.service` }));
  assert.ok(t('Write', { file_path: '../../../../coordinator.db' }));
  assert.ok(t('Read', { file_path: `${home}/.ssh/id_ed25519` }));
  assert.ok(t('Read', { file_path: '~/.claude/.credentials.json' }));
  assert.ok(t('Read', { file_path: '~/.claude-2/.credentials.json' }));
  assert.ok(t('Read', { file_path: `${home}/.local/share/containers/storage/volumes/citadel-claude-3/_data/.claude-3/.credentials.json` }));
  assert.ok(t('Read', { file_path: `${data}/claude-accounts/1/2/.credentials.json` }));
  assert.ok(t('Grep', { pattern: 'token', path: `${data}/claude-accounts/1/2` }));
  assert.ok(t('Grep', { pattern: 'token', path: data }));
  assert.equal(t('Read', { file_path: `${data}/claude-accounts/1/2/projects/x/s.jsonl` }), null);
  assert.ok(t('Grep', { pattern: 'x', path: `${home}/.ssh` }));
  assert.ok(t('Read', { file_path: `${home}/.config/claude-coordinator/env` }));
  assert.ok(t('Grep', { pattern: 'SECRET', path: `${home}/.config/claude-coordinator` }));
  assert.ok(t('Read', { file_path: '/proc/1234/environ' }));
  assert.ok(t('Read', { file_path: '~/.config/gh/hosts.yml' }));
  assert.equal(t('Read', { file_path: '/proc/1234/status' }), null);
  assert.ok(t('Read', { file_path: '/home/josh/.config/citadel-claude/.credentials.json' }));
  assert.ok(t('Read', { file_path: `${home}/.local/share/containers/storage/volumes/citadel-claude-3/_data/.claude/.credentials.json` }));
  assert.ok(t('Grep', { pattern: 'token', path: `${home}/.local/share/containers` }));
  assert.ok(t('Read', { file_path: '/run/user/1000/podman/podman.sock' }));
  assert.ok(t('Write', { file_path: '/home/josh/notes.md' }));
  assert.ok(t('Grep', { pattern: 'token', path: '/home' }));
  assert.ok(t('Grep', { pattern: 'SECRET', path: `${home}/.config` }));
  assert.ok(t('Grep', { pattern: 'x', path: home }));
  assert.ok(t('Grep', { pattern: 'x', path: '/' }));
  assert.equal(t('Grep', { pattern: 'x', path: `${home}/.config/systemd` }), null);
  assert.equal(t('Grep', { pattern: 'x', path: worktree }), null);
  assert.equal(t('Glob', { pattern: '*', path: `${home}/.config` }), null);
  assert.equal(t('Read', { file_path: `${home}/claude-coordinator/server.ts` }), null);
  assert.equal(t('Read', { file_path: `${data}/projects/1/shared/project/plan.md` }), null);
  assert.equal(t('Write', { file_path: `${worktree}/src/x.ts` }), null);
  assert.equal(t('Edit', { file_path: 'src/runner.ts' }), null);
  assert.equal(t('Write', { file_path: `${data}/projects/2/shared/project/handoff.md` }), null);
  // The scheme's repo memory, which the Taskmaster's prompt says it may write.
  assert.equal(t('Edit', { file_path: `${home}/.claude/projects/-home-u--local-share-claude-coordinator-projects-2-repo/memory/MEMORY.md` }), null);
  assert.equal(t('mcp__thread__set_thread_status', { title: 'x' }), null);
});

test('reasons say why and what to do instead', () => {
  assert.match(bash('systemctl --user restart claude-coordinator')!, /cc-restart-when-idle/);
  assert.match(bash('systemctl --user restart claude-coordinator', worktree, { ...cfg, deployScript: true })!, /tools\/deploy\.sh/);
  assert.match(bash('git -C ~/claude-coordinator pull --ff-only', worktree, { ...cfg, deployScript: true })!, /run it from your worktree/);
  assert.match(bash('node server.ts')!, /DATA_DIR=\$\(mktemp -d\)/);
  assert.match(bash('rm ~/.local/share/claude-coordinator/coordinator.db')!, /sqlite3 -readonly/);
});

test('the hook script blocks with exit 2, asks in a minion turn, and lets other calls through', () => {
  const hook = (ask: boolean) => tripwireHooks(2, `${home}/.claude`, ask).PreToolUse[0].hooks[0].command.split(' ').map((s: string) => s.slice(1, -1));
  const [node, script, config] = hook(true);
  assert.equal(script, TRIPWIRE);
  const run = (input: object, c = config) => spawnSync(node, [script, c], { input: JSON.stringify(input), encoding: 'utf8' });
  const blocked = run({ tool_name: 'Bash', tool_input: { command: 'cat ~/.ssh/id_rsa', description: WHY }, cwd: '/tmp' });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /\[tripwire\].*SSH keys/);
  const enable = { tool_name: 'Bash', tool_input: { command: 'systemctl --user enable cc-backup.timer', description: WHY }, cwd: '/tmp' };
  const asked = run(enable);
  assert.equal(asked.status, 0);
  const out = JSON.parse(asked.stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'ask');
  assert.match(out.permissionDecisionReason, /systemctl enable/);
  // A Taskmaster's turn can't show cards, so the same call is a plain block there.
  assert.equal(run(enable, hook(false)[2]).status, 2);
  assert.equal(run({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/tmp' }).status, 0);
  assert.equal(spawnSync(node, [script, '{bad'], { input: '{}', encoding: 'utf8' }).status, 0);
});

// ---------- the card a tripwire ask turns into (Approvals.ask; the MCP round trip is in approvals.test.ts) ----------

test('cards: approve settles that exact call, deny blocks it, and one card at a time', async () => {
  const events: any[] = [];
  const a = new Approvals((ticketId, kind, data) => events.push({ ticketId, kind, data }));
  const input = { command: 'rm ~/.local/share/claude-coordinator/coordinator.db.bak-x', description: WHY };
  const first = a.ask(1, 'Bash', input, worktree, cfg, false);
  assert.ok('id' in first, JSON.stringify(first));
  const card = events.at(-1).data;
  assert.deepEqual(card.input, input, 'the card shows the call in full');
  assert.equal(card.tripwire.explanation, WHY);
  assert.match(card.tripwire.reason, /live data dir/);

  // While it waits, no second tripwire card, from this minion; another minion still can.
  const second = a.ask(1, 'Bash', { command: 'systemctl --user enable x.timer', description: WHY }, worktree, cfg, false);
  assert.match((second as any).refused, /already waiting/);
  assert.ok('id' in a.ask(2, 'Bash', input, worktree, cfg, false));

  const decided = a.wait(1, first.id, 10_000);
  assert.deepEqual(a.decide(1, first.id, true, 'Cara'), { state: 'allowed', by: 'Cara' });
  assert.deepEqual(await decided, { state: 'allowed', by: 'Cara' });

  // Once it's settled, the next call can ask; a deny ends tripwire cards for the rest of the turn.
  const next = a.ask(1, 'Bash', { command: 'systemctl --user enable x.timer', description: WHY }, worktree, cfg, false);
  assert.ok('id' in next);
  assert.deepEqual(a.decide(1, next.id, false, 'Cara'), { state: 'denied', by: 'Cara' });
  assert.match((a.ask(1, 'Bash', input, worktree, cfg, false) as any).refused, /denied a tripwire card earlier this turn/);
  a.endTurn(1, 'The turn ended while this waited.');
  assert.ok('id' in a.ask(1, 'Bash', input, worktree, cfg, false), 'a new turn starts afresh');
});

test('cards: refused for hard blocks, missing explanations, long calls, and other prompts without rules', () => {
  const a = new Approvals(() => {});
  const refused = (input: object, rules = false) => (a.ask(5, 'Bash', input, worktree, cfg, rules) as any).refused;
  assert.match(refused({ command: 'systemctl --user restart claude-coordinator', description: WHY }), /The tripwire blocks this/);
  assert.match(refused({ command: 'systemctl --user enable x.timer' }), /explanation/);
  assert.match(refused({ command: `rm ${data}/x.bak # ${'x'.repeat(20_000)}`, description: WHY }), /too long to show in full/);
  assert.match(refused({ command: 'gh pr merge 3' }), /Nobody can answer a permission prompt/);
  assert.equal(a.waiting(5), 0);
  // With approval rules, other prompts still get their card, as before.
  assert.equal(refused({ command: 'gh pr merge 3' }, true), undefined);
  assert.equal(a.waiting(5), 1);
});

test('a blocked data-dir write points at sqlite3 -readonly and a copy in TMPDIR (#251)', () => {
  for (const command of [`D=${data}; rm -f $D/state.db`, 'rm -f "$D/state.db"', `rm -f ${data}/vapid.json`]) {
    assert.match(bash(command) ?? '', /sqlite3 -readonly/, command);
    assert.match(bash(command) ?? '', /\$TMPDIR\/copy\.db/, command);
  }
  assert.match(bash('rm -f "$D/state.db"') ?? '', /can't tell what \$D holds/);
});

test("a minion can write in its TMPDIR, its scheme's tmp folder (#218)", () => {
  const tmp = `${data}/projects/2/tmp/9`;
  assert.equal(tripwire({ tool_name: 'Write', tool_input: { file_path: `${tmp}/out.txt`, content: 'x' }, cwd: worktree }, { ...cfg, ask: true }), null);
  for (const command of [`echo hi > ${tmp}/x.txt`, `cp a ${tmp}/`, `mkdir -p ${tmp}/b && cd ${tmp}/b && dotnet build`, `rm -rf ${tmp}/b`]) assert.equal(bash(command), null, command);
});

test('no turn launches an ultra review: it is billed to a person, so only their click starts one (#432)', () => {
  for (const command of ['claude ultrareview', 'claude ultrareview main --json --trust-workspace', 'cd /tmp && claude ultrareview 12', 'claude -p "/code-review ultra"', "claude -p '/ultrareview main'", '/home/cara/.local/bin/claude ultrareview', 'a=ultrareview; claude "$a" main --trust-workspace', 'claude "$(echo ultrareview)"', 'claude $UNKNOWN_SUB']) {
    const v = verdict(command);
    assert.ok(v && !v.ask, command);
    assert.match(v.reason, /ultra review is billed/, command);
  }
  for (const command of ['claude --version', 'echo ultrareview', 'grep -rn ultrareview src', 'claude -p "/code-review high"']) assert.equal(verdict(command), null, command);
  const skill = (skill: string, args?: string) => tripwire({ tool_name: 'Skill', tool_input: { skill, args } }, cfg);
  assert.match(skill('code-review', 'ultra')!.reason, /billed/);
  assert.match(skill('code-review', 'ultra 123 --post')!.reason, /billed/);
  assert.match(skill('ultrareview')!.reason, /billed/);
  assert.equal(skill('code-review', 'high'), null);
  assert.equal(skill('citadel:self-review'), null);
});

// ---------- #485: rules narrowed where they stopped real work, each with its twin that stays refused ----------

test('a target the tripwire can now pin down: a function argument bound at its call, and $(basename …) in a known folder (#485)', () => {
  const tmp = `${data}/projects/2/tmp/9`;
  const allowed: [string, string?][] = [
    // #709 and #717: a function writing to its argument, called with literal names
    ['cd "$TMPDIR" && mkdir -p src && cd src\nf(){ gh api "repos/$1/contents/$2?ref=$3" -H "Accept: application/vnd.github.raw" > "$4" 2>"$4.err" || { echo "FAIL $1 $2"; cat "$4.err"; }; }\nf obra/superpowers skills/writing-skills/SKILL.md 22f0b46 sp-writing.md\nf obra/superpowers skills/x/SKILL.md 22f0b46 sp-x.md'],
    ["get(){ gh api \"repos/$1/contents/$2?ref=$3\" -H 'Accept: application/vnd.github.raw' > \"$4\"; }; get jame581/GodotPrompter skills/csharp-godot/SKILL.md d7b26cd cg.md"],
    ['function save() { rm -f "${1}.old"; mv "$1" "$1.old"; }; save notes.md'],
    ['f() { rm -f "$1"; }; for x in a.txt b.txt; do f "$x"; done', tmp],
    ['cd "$TMPDIR" && f(){ gh api "repos/$1" > "$2"; }; f a/b out.md; f c/d out2.md'],
    // #1034: a single name from basename, in a folder it knows
    ['cd $TMPDIR && for f in apps/_citadel/rail.js apps/_citadel/theme.css; do curl -s http://127.0.0.1:8573/$f > "$(basename $f)"; done'],
    ['curl -s "$URL" > "$(basename "$URL").json"', tmp],
    ['cp "$SRC" "$(basename "$SRC")"', tmp],
  ];
  for (const [command, cwd] of allowed) assert.equal(bash(command, cwd), null, command);
  const refused: [string, string?][] = [
    // the arguments decide: a live-data path, or one it can't read
    [`f(){ rm -f "$1"; }; f ${data}/state.db`],
    ['f(){ rm -f "$1"; }; f "$D"'],
    ['f(){ echo x > "$2"; }; f a "$out"', tmp],
    ['f(){ cd "$1" && rm -f state.db; }; f ~/.local/share/claude-coordinator'],
    // a function the tripwire can't see every call of is checked as before, with its arguments unknown
    ['f(){ rm -f "$1"; }; export -f f; bash -c "f /x"'],
    ['f(){ rm -f "$1"; }; g=f; $g x'],
    ['f(){ rm -f "$1"; }'],
    ['f(){ rm -f "$1"; }; f a.txt; $CMD b'],
    // a word the call leaves out, or ${1:-…}, may take a default the tripwire doesn't follow
    ['f(){ rm -rf "${1:-$HOME/.local/share/claude-coordinator}"/state.db; }; f'],
    ['f(){ rm -rf "${1:-$HOME/.local/share/claude-coordinator}"/state.db; }; f ""'],
    // each call's words are read before any is bound
    [`g(){ rm -f "$2"; }; f(){ g "$2" "$1"; }; f ${data}/state.db a.txt`, tmp],
    // a body that moves its arguments or scopes its variables is checked where it stands
    [`f(){ shift; rm -f "$1"; }; f a.txt ${data}/state.db`, tmp],
    [`f(){ set -- "$2"; rm -f "$1"; }; f a.txt b.txt`, tmp],
    [`f(){ local x="$1"; rm -f "$x"; }; f a.txt`, tmp],
    // a shell started inside the function has $1… of its own
    [`f(){ echo ${data} | xargs sh -c 'rm -rf "$1"' _; }; f a.txt`, tmp],
    [`f(){ bash -c 'rm -rf "$1"' sh "$2"; }; f a.txt ${data}`, tmp],
    // a word bash splits, globs or brace-expands moves the words after it
    [`f(){ rm -rf "$2"; }; f {a.txt,${data}} x.txt`, tmp],
    [`f(){ rm -rf "$2"; }; f ${data}/* x.txt`, tmp],
    [`D="a.txt ${data}"; f(){ rm -rf "$2"; }; f $D x.txt`, tmp],
    [`f(){ rm -rf "$2"; }; f "$E" ${data} x.txt`, tmp],
    // a definition that may not last, or calls the tripwire can't see
    [`f(){ rm -rf "$1"; }; ( f(){ :; } ); f ${data}`, tmp],
    [`f(){ rm -rf "$1"; }; true || f(){ :; }; f ${data}`, tmp],
    [`f(){ rm -rf "$1"; }; f(){ :; } & f ${data}`, tmp],
    [`f(){ :; }; if true; then f(){ rm -rf "$1"; }; fi; f ${data}`, tmp],
    [`f(){ :; }; for i in 1; do f(){ rm -rf "$1"; }; done; f ${data}`, tmp],
    ['f(){ rm -rf "$1"; }; f a.txt; . ./x.sh', tmp],
    ['f(){ rm -rf "$1"; }; f a.txt; source x.sh', tmp],
    // a command's own basename may print anything
    [`basename(){ echo ${data}/; }; cp x.db "$(basename y)state.db"`, tmp],
    // more calls than it follows
    [`f(){ rm -f "$1"; }; ${Array.from({ length: 65 }, (_, i) => `f a${i}`).join('; ')}`, tmp],
    // basename names a file in the current folder: the folder must be known, and not the live data
    ['cd "$(cat where)" && curl -s "$u" > "$(basename "$u")"'],
    [`cd ${data} && curl -s "$u" > "$(basename "$u")"`],
    // only basename: other commands' output may hold a slash
    ['curl -s "$u" > "$(dirname "$u")"', tmp],
    ['curl -s "$u" > "$(basename "$u")/x"', tmp],
    ['curl -s "$u" > "$(echo "$u")"', tmp],
    // a lone name may be . or ..: a remover or find would take the folder itself
    ['rm -rf "$(basename "$d")"', tmp],
    ['find "$(basename "$d")" -delete', tmp],
    ['rm -rf ".$(basename "$d")"', tmp],
  ];
  for (const [command, cwd] of refused) assert.ok(verdict(command, cwd), command);
});

test('env: names only pass, values stay refused, and the message says how to check one (#485)', () => {
  for (const command of ['env | cut -d= -f1', "env | cut -d '=' -f 1 | sort", "env | awk -F= '{print $1}' | grep -i node", "env | sed 's/=.*//'", 'env | cut -f1 -d='])
    assert.equal(bash(command), null, command);
  for (const command of ['env', 'env | grep NAME', 'env | cut -d= -f2', 'env | cut -d= -f1-', 'env | cut -d= -f1,2', 'env | sort', 'env | sort | cut -d= -f1', "env | awk '{print}'", 'env > e.txt | cut -d= -f1', 'env; cut -d= -f1 x'])
    assert.ok(verdict(command), command);
  // a value with a line break would put its later lines through as names
  assert.ok(tripwire({ tool_name: 'Bash', tool_input: { command: 'env | cut -d= -f1' }, cwd: '/tmp' }, { ...cfg, env: { X: 'a\nTOKEN=s' } }));
  assert.match(bash('env | grep NAME')!, /^`env`[^.]*\. Check one variable with `\[ -n "\$NAME" \]/);
  assert.match(bash('env | grep NAME')!, /env \| cut -d= -f1/);
});

test('git: --ours and --theirs mid-merge, and any checkout in a clone under the turn\'s TMPDIR (#485)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tripwire-485-'));
  const c = { ...cfg, home: homedir(), data: tmp, env: { TMPDIR: join(tmp, 'projects/2/tmp/9') } };
  const wt = join(tmp, 'projects/2/tickets/9');
  const clone = join(tmp, 'projects/2/tmp/9/clone');
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const sh = (cmd: string, cwd = wt) => execSync(cmd, { cwd, stdio: 'pipe', env });
  const at = (command: string, cwd = wt) => tripwire({ tool_name: 'Bash', tool_input: { command }, cwd }, c)?.reason ?? null;
  try {
    mkdirSync(wt, { recursive: true });
    sh('git init -q -b ticket/9 && echo a > a.txt && echo b > b.txt && git add a.txt b.txt && git commit -qm a');
    sh('git checkout -qb other && echo b > a.txt && git commit -qam b && git checkout -q ticket/9 && echo c > a.txt && git commit -qam c');
    // Not mid-merge: --ours names a path as any path checkout does.
    assert.match(at('git checkout --ours a.txt') ?? '', /names a path/);
    sh('git merge other || true');
    for (const ok of ['git checkout --ours a.txt', 'git checkout --theirs -- a.txt', `git checkout --ours -- ${wt}/a.txt`]) assert.equal(at(ok), null, ok);
    // Without --ours or --theirs, mid-merge or not, it stays refused; so does --ours on a file with no open conflict, or on a folder or glob.
    writeFileSync(join(wt, 'b.txt'), 'changed');
    for (const no of ['git checkout -- a.txt', 'git checkout HEAD a.txt', 'git restore a.txt', 'git checkout --ours b.txt', 'git checkout --ours -- a.txt b.txt', 'git checkout --ours -- .', "git checkout --theirs '*.txt'", 'git checkout --ours "$F"'])
      assert.ok(at(no), no);
    sh('git checkout -q -- b.txt');
    sh('git merge --abort');

    // A clone under the turn's TMPDIR is scratch: its checkouts can't lose anyone's work.
    mkdirSync(join(tmp, 'projects/2/tmp/9'), { recursive: true });
    sh(`git clone -q ${wt} ${clone}`);
    writeFileSync(join(clone, 'a.txt'), 'changed');
    for (const ok of [`git -C ${clone} checkout -- a.txt`, `cd ${clone} && git checkout -- a.txt`, 'cd "$TMPDIR/clone" && git checkout HEAD~1 a.txt', `git -C ${clone} checkout other`, `git -C ${clone} restore a.txt`]) assert.equal(at(ok), null, ok);
    // The worktree itself stays refused, from inside or by -C from the clone, and so does a clone outside the turn's TMPDIR.
    writeFileSync(join(wt, 'a.txt'), 'changed');
    for (const no of ['git checkout -- a.txt', 'git restore a.txt', 'git checkout other']) assert.ok(at(no), no);
    assert.ok(at(`git -C ${wt} checkout -- a.txt`, clone));
    const other = join(tmp, 'elsewhere');
    sh(`git clone -q ${wt} ${other}`);
    assert.ok(at('git checkout -- a.txt', other));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('systemd-run is a wrapper: the command it runs is checked past its options (#513)', () => {
  const db = '~/.local/share/claude-coordinator/state.db';
  for (const command of [
    `systemd-run --user rm -f ${db}`,
    `systemd-run --user --unit=x rm -f ${db}`,
    `systemd-run --user -p X=1 -- rm -f ${db}`,
    `systemd-run --user --unit x --description 'clean up' -G rm -f ${db}`,
    `systemd-run --user -E A=1 --on-active 5 -qu x rm -f ${db}`,
    `systemd-run --user -P timeout 5 rm -f ${db}`,
    `systemd-run --user --uni x --desc y rm -f ${db}`,
    'systemd-run --user --unit=x pkill node',
    'systemd-run --user -u x cat ~/.ssh/id_ed25519',
    // A listing piped into a kill it runs; xargs's own -p is not systemd-run's.
    'ss -ltnp | grep x | systemd-run --user --unit x -P xargs kill',
    "ss -ltnp | grep 8573 | awk '{print}' | systemd-run --user -P xargs -p kill",
  ])
    assert.ok(verdict(command), command);
  for (const command of ['systemd-run --user --unit=x sleep 5', 'systemd-run --user --unit x -p MemoryMax=1G --collect sleep 5', 'systemd-run --user -P --wait -- ls /tmp'])
    assert.equal(bash(command), null, command);
});

test('systemd-run --setenv counts for server.ts, a grep pattern is not a path, and the refusals name citadel-dev-copy (#485)', () => {
  for (const command of ['systemd-run --user --setenv=DATA_DIR=/tmp/d --setenv=PORT=19999 node server.ts', 'systemd-run --user -E DATA_DIR=/tmp/d -E PORT=19999 --unit=dev node server.ts', 'systemd-run --user --setenv DATA_DIR=/tmp/d --setenv PORT=19999 node server.ts'])
    assert.equal(bash(command), null, command);
  for (const command of ['systemd-run --user --setenv=PORT=19999 node server.ts', 'systemd-run --user node server.ts', 'systemd-run --user --setenv=DATA_DIR=/tmp/d -- node server.ts --setenv=PORT=1'])
    assert.ok(verdict(command), command);
  // #827, #825, #366: a pattern grep searches for, never a file it reads
  for (const command of ["podman images --format '{{.Repository}}:{{.Tag}} {{.Size}}' | grep citadel-claude | head -3", "podman ps -a --format '{{.Names}} {{.Status}}' 2>&1 | grep citadel-claude", 'grep -rn citadel-claude src/'])
    assert.equal(bash(command), null, command);
  for (const command of ['podman inspect citadel-claude-1', 'cat ~/.config/citadel-claude/settings.json', 'grep -f ~/.config/citadel-claude/x src'])
    assert.ok(verdict(command), command);
  assert.match(bash('node server.ts')!, /citadel-dev-copy start/);
  assert.match(bash('pkill -f server.ts')!, /citadel-dev-copy/);
});

test('the six folders turns no longer deny by Read rule stay refused here, for every way to read them (#485)', () => {
  // Claude Code's folder-wide Read(…/**) deny rules refused any Bash read after a cd it couldn't resolve, so turn-launch dropped them: this is their guard now.
  const t = (tool_name: string, tool_input: object) => tripwire({ tool_name, tool_input, cwd: worktree }, cfg)?.reason ?? null;
  const dirs = [`${home}/.ssh`, `${home}/.config/claude-coordinator`, `${home}/.config/citadel-claude`, `${home}/.local/share/containers/storage`, '/run/user/1000/podman', '/run/user/1000/containers'];
  for (const d of dirs) {
    const f = `${d}/id_ed25519`;
    for (const [tool, input] of [['Read', { file_path: f }], ['Grep', { pattern: 'x', path: d }], ['Grep', { pattern: 'x', path: f }], ['Glob', { pattern: '*', path: d }], ['Glob', { pattern: `${d}/**` }]] as const)
      assert.ok(t(tool, input), `${tool} ${JSON.stringify(input)}`);
    for (const command of [`cat ${f}`, `grep -r x ${d}`, `head ${f}`, `cd ${d} && cat id_ed25519`]) assert.ok(bash(command), command);
  }
});
