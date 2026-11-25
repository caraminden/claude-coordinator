// A minion's hand-off to the server (#706) and the checks it must pass, for both who start one: the minion itself
// (hand_off_land) and, since #1930 (Josh, 2026-11-25, "Yes, server ships it"), a member's Ship It on a card the minion
// posted with its hand-off prepared, which the server ships with no turn and no worker.
import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { needsGo } from '../public/shipping.js';
import { APP_NAME } from './appname.ts';
import { criticRefusal } from './critic-gate.ts';
import { buildOwnerKey, type Ticket } from './db.ts';
import { fixLine, fixProofProblem, parseFixProof } from './fix-proof.ts';
import { gitOut } from './git.ts';
import { HANDOFF_FIX, HttpError, oneOf, str, type App } from './http.ts';
import { landArgs, landConflict, landPhase, type Handoff } from './land.ts';
import { changedLines, parseProbe, PROBE_HELP, PROBE_LINES } from './live-probe.ts';
import { pacificStamp } from './pacific.ts';
import { parseLearned, touchedFiles } from './ship-lessons.ts';
import { offSkills } from './skills.ts';
import { thrown } from './thrown.ts';
import { buildBranch } from './workspace.ts';

/** A hand-off that passed every check, ready for startHandoff. */
interface Ready {
  cwd: string;
  env: Record<string, string>;
  args: string[];
  h: Handoff;
}

const hasLand = (cwd: string) =>
  access(join(cwd, 'tools', 'land.sh')).then(
    () => true,
    () => false,
  );

/**
 * Every check a hand-off must pass; throws the refusal. `caller` is the calling turn's token, or with no turn calling, what
 * throws if one has started meanwhile: minting a token here would cut that turn off its tools.
 */
export async function checkHandoff(app: App, ticket: Ticket, body: Record<string, unknown>, caller: string | (() => void)): Promise<Ready> {
  if (ticket.kind !== 'ticket' || !ticket.cwd) throw new HttpError(403, 'Only a minion with a worktree lands with tools/land.sh');
  if (!(await hasLand(ticket.cwd))) throw new HttpError(404, 'This worktree has no tools/land.sh: land the way the scheme instructions say');
  // No risk label is high (Q10, Build 4): a scheme whose pre-ship review is off, with nothing else giving the label, has every ship wait for a person's go.
  const labeller = app.store.reviews.labelGiver(ticket.project_id);
  const unlabelled = labeller ? '' : "this scheme's pre-ship review is off and nothing else gives the risk label";
  const h: Handoff = unlabelled
    ? { summary: str(body.summary, 'Summary', 300, HANDOFF_FIX), risk: 'high', reason: `No risk label: ${unlabelled}${typeof body.risk_reason === 'string' && body.risk_reason.trim() ? `. ${body.risk_reason.trim()}` : ''}`.slice(0, 300) }
    : { summary: str(body.summary, 'Summary', 300, HANDOFF_FIX), risk: oneOf(body.risk, ['low', 'medium', 'high'], 'Risk') as Handoff['risk'], reason: str(body.risk_reason, 'Risk reason', 300, ': call hand_off_land again with risk_reason: one line on why that label, plus what you chose not to fix') };
  // The scheme's go threshold (#1043, Shipping in Minion rules): from that label up, a change ships only on a person's go.
  // A feeder's merge into its build branch is covered by the build's go card (buildLines in prompts.ts).
  const project = app.store.getProject(ticket.project_id);
  const goFrom = project?.go_from ?? 'high';
  const hasGo = typeof body.go === 'string' && !!body.go.trim();
  const reviewOff = !!project && offSkills(project).includes('self-review');
  if (body.into === undefined && (unlabelled || needsGo(goFrom, h.risk)) && !hasGo && body.fix_proof !== undefined && !unlabelled && goFrom !== 'all' && !reviewOff) {
    // #1398 (Cara, 2026-11-20, "Fixes ship; data still asks"): a bug fix that proves itself ships with no go, and its
    // shipped line says so. Not where every change waits for a person, nor with no label; data and auth always ask.
    let proof;
    try {
      proof = parseFixProof(body.fix_proof);
    } catch (err) {
      throw new HttpError(400, thrown(err).message!);
    }
    const why = await fixProofProblem(ticket.cwd, proof, app.store.props.forTarget('minion', ticket.id).type);
    if (why) throw new HttpError(400, `Not handed off as a fix without a go: ${why}. Ask with a ship card (kind ship) and hand it off with go instead`);
    // The reason carries the line, so the shipped line says it (and Releases reads it there) without a field in land.ts, a pipeline file.
    h.reason = `${h.reason.replace(/[.\s]+$/, '')}. ${fixLine(proof)}`;
  } else if (body.into === undefined && (unlabelled || needsGo(goFrom, h.risk))) {
    if (!hasGo)
      throw new HttpError(
        400,
        unlabelled
          ? `Not handed off: ${unlabelled}, so this ship waits for a person's go. Ask with a ship card (kind ship), then hand it off again with go naming who gave it and when`
          : `In this scheme ${goFrom === 'all' ? 'every change' : `a ${h.risk}-risk change`} ships only on a person's go: name who gave it and when in go, or ask with a ship card (kind ship) first${goFrom === 'all' || reviewOff ? '' : '. A bug fix that proves itself passes fix_proof instead (self-review skill, "The go threshold")'}`,
      );
    h.go = str(body.go, 'Go', 200);
  } else if (body.into === undefined && project && offSkills(project).includes('self-review')) {
    // Cara's Q10 (#1062, ADR 0014): with self-review off nothing labels a change's risk, so every ship waits for a person's go.
    if (typeof body.go !== 'string' || !body.go.trim()) throw new HttpError(400, "This scheme has turned self-review off, so every change ships only on a person's go: name who gave it and when in go, or ask with a ship card (kind ship) first");
    h.go = str(body.go, 'Go', 200);
  }
  // A blocking reviewer or critic whose last verdict on this minion failed holds the ship (Q7, Block or advise), a feeder's merge too, until it passes or a person gives the go.
  const holds = app.store.reviews.holds(ticket.project_id, ticket.id);
  if (holds.length && !h.go) {
    if (typeof body.go !== 'string' || !body.go.trim())
      throw new HttpError(
        400,
        `Not handed off: ${holds.map((x) => `${x.name} (\`${x.slug}\`, last verdict ${x.verdict})`).join(', ')} ${holds.length > 1 ? 'block' : 'blocks'} this ship. Fix what it found and run it again until it passes (record each round with review_set run), or ask a person with a ship card (kind ship) and hand it off again with go naming who gave it and when`,
      );
    h.go = str(body.go, 'Go', 200);
  }
  if (body.deploy !== undefined && typeof body.deploy !== 'boolean') throw new HttpError(400, 'deploy must be true or false');
  if (body.deploy === false) h.deploy = false;
  if (body.stay_open !== undefined && typeof body.stay_open !== 'boolean') throw new HttpError(400, 'stay_open must be true or false');
  if (body.waiting_on !== undefined && body.stay_open !== true) throw new HttpError(400, 'waiting_on goes with stay_open: true');
  if (body.stay_open === true) {
    h.stayOpen = true;
    if (body.waiting_on !== undefined) h.waitingOn = str(body.waiting_on, 'waiting_on', 120);
  }
  // The live probe (#1741): a ship to main of PROBE_LINES or more names one check the server runs once it's live, where something of the scheme is served here.
  if (body.probe !== undefined) {
    if (body.into !== undefined) throw new HttpError(400, 'A probe goes with a ship to main, not a merge into a build');
    try {
      h.probe = parseProbe(body.probe);
    } catch (err) {
      throw new HttpError(400, `${thrown(err).message}. ${PROBE_HELP}`);
    }
    if (h.probe.kind === 'sql' && (await app.waiters.elsewhere(ticket.id))) throw new HttpError(400, "A sql probe reads this server's own database, so only the scheme it runs uses one: pick http or timing");
  } else if (body.into === undefined) {
    // As the ship's own app deploys pick them (server.ts, LandHandoffs' apps): a home app on main.
    const served = !(await app.waiters.elsewhere(ticket.id)) || (body.deploy !== false && app.store.listContraptions().some((c) => c.home_scheme === ticket.project_id && !!c.repo && (c.branch ?? 'main') === 'main'));
    const lines = served ? await changedLines(ticket.cwd) : 0;
    if (lines >= PROBE_LINES) throw new HttpError(400, `Not handed off: this change is ${lines} lines (${PROBE_LINES} or more), so it names one check the server runs once it's live, with no model: a pass is a line in your chat, a fail wakes you. Pick what would show it broken live. ${PROBE_HELP}`);
  }
  let args: string[];
  try {
    args = landArgs(body, ticket.cwd);
  } catch (err) {
    throw new HttpError(400, thrown(err).message!);
  }
  // The critic gate (#1504): a critic this change matches runs before the ship, a feeder's merge too.
  const unjudged = await criticRefusal(app.store.reviews, { ...ticket, cwd: ticket.cwd! }, args, body.fix === true);
  if (unjudged) throw new HttpError(400, unjudged);
  // The build minion's take-in of main isn't the end of its work: a clean one would dismiss it mid-build.
  if (args.includes('--full')) throw new HttpError(400, 'A build minion takes main in within its turn: run tools/land.sh --into build/<n> --full yourself (in a container, the land tool)');
  // As land.sh's own first check, but now, before the minion ends its turn on a land that would refuse at once.
  const dirty = await new Promise<string>((done) => execFile('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: ticket.cwd! }, (err, out) => done(err ? `git status failed: ${err.message}` : out.trim())));
  if (dirty) throw new HttpError(409, `Not handed off: your worktree has uncommitted changes. Commit them first.\n${dirty.slice(0, 2000)}`);
  if (typeof caller === 'function') caller();
  const env = app.runner.hostEnv(ticket, typeof caller === 'string' ? caller : undefined);
  if (body.fix === true) env.LAND_FIX = '1';
  if (body.outage === true) env.LAND_URGENT = '1'; // its restart skips deploy.sh's starved-box hold (#1417)
  // Fast mode (#1017): low and medium lands go live on the smoke check; every land in the scheme is let through on known reds.
  const scheme = app.store.getProject(ticket.project_id);
  if (scheme?.land_mode === 'fast') {
    if (h.risk !== 'high') env.LAND_FAST = '1';
    const known = app.fastMode?.knownRed(ticket.project_id);
    if (known) env.LAND_KNOWN_RED = known;
  }
  // A branch that wouldn't rebase cleanly is sent back now, in the minion's own turn, not after its wait in line (#770).
  const clash = await landConflict(ticket.cwd, env, args);
  if (clash) throw new HttpError(409, `Not handed off: ${clash}`);
  // Its three lines (#1119) ride with the hand-off and queue on a clean land; they never refuse it.
  const learned = parseLearned(body.learned);
  if (learned !== null) {
    h.learned = learned;
    h.touched = await touchedFiles(ticket.cwd, args[0] === '--into' ? [args[1], `origin/${args[1]}`, 'main'] : undefined);
  }
  return { cwd: ticket.cwd, env, args, h };
}

/** Start it: land.sh runs and the minion shows as landing. False when a landing already runs for it. */
export function startHandoff(app: App, ticket: Ticket, { cwd, env, args, h }: Ready): boolean {
  if (!app.landings.handOff(ticket.id, cwd, env, args, h)) return false;
  app.runner.places.refused(ticket.id, false);
  app.store.updateTicket(ticket.id, { state: 'outside', note: landPhase('') });
  app.runner.broadcastTicket(ticket.id);
  return true;
}

/** A ship card's prepared hand-off: hand_off_land's arguments but the go, and the commit they were tested and reviewed at. */
export interface Prepared {
  args: Record<string, unknown>;
  head: string;
}

/** What a prepared hand-off takes: hand_off_land's arguments for a plain ship to main, less the go, which is the click. */
const PREPARED_KEYS = ['summary', 'learned', 'risk', 'risk_reason', 'probe', 'fix', 'stay_open', 'waiting_on'];
const isShipOption = (label: unknown) => /^ship it$/i.test(String(label ?? '').trim());
/** A branch in a build under way merges there, and the build minion's own go card opens its ship in its turn: both cards go to the minion. */
const inBuild = (app: App, ticket: Ticket) => !!buildBranch(app.store.getProject(ticket.project_id)?.repo_dir ?? null, ticket.build) || (ticket.build != null && app.store.getSetting<number>(buildOwnerKey(ticket.project_id, ticket.build)) === ticket.id);

/** Whether a ship card here is one the server could ship: a minion on a tools/land.sh ship path, outside a build. A pull-request scheme's card stays the minion's. */
const serverShips = async (app: App, ticket: Ticket) => ticket.kind === 'ticket' && !!ticket.cwd && (app.store.getProject(ticket.project_id)?.ship_path ?? 'citadel') === 'citadel' && (await hasLand(ticket.cwd)) && !inBuild(app, ticket);

/** A ship card's hand_off, checked as the hand-off itself will be, so what it refuses is fixed in the minion's turn and not after the click. */
export async function prepareHandoff(app: App, ticket: Ticket, raw: unknown, questions: { multiSelect?: boolean; options: { label: string }[] }[], token: string): Promise<Prepared> {
  const bad = (why: string) => new HttpError(400, `Card not posted: ${why}`);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad("hand_off is an object: hand_off_land's arguments, without go");
  if (!(await serverShips(app, ticket))) throw bad("hand_off is for a minion's own ship to main with hand_off_land, not a build's card or a pull request: leave it out and the answer comes to you");
  const unknown = Object.keys(raw).filter((k) => !PREPARED_KEYS.includes(k));
  if (unknown.length) throw bad(`hand_off takes no ${unknown.join(', ')} (it takes ${PREPARED_KEYS.join(', ')}; the click is the go)`);
  const ships = questions[0]?.options.filter((o) => isShipOption(o.label)).length;
  if (questions.length !== 1 || questions[0].multiSelect || ships !== 1) throw bad('a card with hand_off asks one question, pick one, with one option labelled "Ship It"');
  const args = { ...raw } as Record<string, unknown>;
  const head = await gitOut(['rev-parse', 'HEAD'], ticket.cwd!);
  if (!head) throw bad("git couldn't read your worktree's commit");
  try {
    await checkHandoff(app, ticket, { ...args, go: 'the click' }, token);
  } catch (err) {
    if (err instanceof HttpError) throw new HttpError(err.status, `Card not posted, since the ship it prepares would be refused: ${err.message}`);
    throw err;
  }
  return { args, head };
}

/** Whether a change touches the ship pipeline (tools/pipeline-files.txt, where a repo has one) and so ships only from the `pipeline-lane` claim's holder; null when it may ship. */
async function laneRefusal(app: App, ticket: Ticket): Promise<string | null> {
  if (app.store.claims.get(ticket.project_id, 'pipeline-lane')?.holder === ticket.id) return null;
  // A branch that drops the list changes the list, which is in its own list; a repo without one has no pipeline files.
  const list = await readFile(join(ticket.cwd!, 'tools', 'pipeline-files.txt'), 'utf8').catch((err) => {
    if (err.code === 'ENOENT') return '';
    throw err;
  });
  const changed = await gitOut(['diff', '--name-only', '--no-renames', '-z', 'main...HEAD'], ticket.cwd!, { trim: false });
  if (changed === null) return "it couldn't tell whether the change needs the pipeline lane";
  const paths = ['tools/pipeline-files.txt', ...list.split('\n').map((l) => l.trim())].filter((l) => l && !l.startsWith('#'));
  const hit = changed.split('\0').find((f) => f && paths.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p)));
  return hit ? `${hit} is a pipeline file and you don't hold the pipeline lane` : null;
}

/** What the chat and the queue say now that rules out shipping with no turn; null when nothing does. Read again after the slow checks. */
function chatRefusal(app: App, ticketId: number, cardEvent: number): string | null {
  const { store, runner } = app;
  const t = store.getTicket(ticketId);
  if (!t || t.status === 'closed') return 'you were dismissed';
  if (runner.noTurns) return 'this is a preview';
  if (runner.parked(t)) return 'you were sealed';
  if (runner.busy(ticketId)) return 'your turn was running or about to';
  const wrote = store.eventsOfKinds(ticketId, ['user_message'], cardEvent).some((e) => {
    const d = JSON.parse(e.data);
    return !d.from && runner.personOf?.(d.author) != null;
  });
  return wrote ? 'a person wrote to you after the card' : null;
}

/**
 * A member pressed Ship It: ship it now as its minion prepared it, with no turn. Null once it started; else why it goes to
 * the minion as an ordinary answer, or '' for a card the server never ships (a build's, a pull-request scheme's).
 * `record` keeps the answer in the chat, and what the minion's next turn, if it has one, reads of it.
 */
export async function shipOnClick(app: App, ticket: Ticket, card: { event: number; data: { kind?: string; into?: number; handoff?: Prepared } }, answer: { by: string; uid: number | null; picked: string[]; added: boolean; record(held: string): void }): Promise<string | null> {
  const { data } = card;
  if (data.kind !== 'merge' || data.into || !(await serverShips(app, ticket))) return '';
  if (answer.picked.length !== 1 || !isShipOption(answer.picked[0])) return "the pick wasn't Ship It";
  if (answer.added) return 'the answer had words or files added';
  const prepared = data.handoff;
  if (!prepared) return 'the card had no hand-off prepared (hand_off)';
  try {
    const clear = () => {
      const now = chatRefusal(app, ticket.id, card.event);
      if (now) throw new HttpError(409, now);
    };
    clear();
    // A copy of the data (a dev copy) names the live worktrees: nothing pressed there may ship them.
    if (!resolve(ticket.cwd!).startsWith(resolve(app.dataDir) + sep)) return "your worktree isn't in this server's own folder";
    const moved = async () => (await gitOut(['rev-parse', 'HEAD'], ticket.cwd!)) !== prepared.head && 'your branch moved since the card';
    const early = await moved();
    if (early) return early;
    const lane = await laneRefusal(app, ticket);
    if (lane) return lane;
    const go = `${answer.by}, ${pacificStamp(Date.now())}, by Ship It (the server shipped it with no turn)`.slice(0, 200);
    // Its pushes go out as whoever pressed it, as from the turn their answer would have started.
    const ready = await checkHandoff(app, { ...ticket, person_id: answer.uid ?? ticket.person_id }, { ...prepared.args, go }, clear);
    ready.h.go = go; // on its shipped line at any risk
    // The checks take seconds: what came meanwhile still counts, and nothing below the last read of the commit waits.
    const late = await moved();
    if (late) return late;
    clear();
    const fresh = app.store.eventsOfKinds(ticket.id, ['question'], card.event - 1).find((e) => e.id === card.event);
    if (!fresh || JSON.parse(fresh.data).settled) return 'you settled the card meanwhile';
    if (!startHandoff(app, ticket, ready)) return 'a ship of yours already ran';
    // A ship that fails wakes it on the presser's login, as the turn their answer would have started ran on it.
    if (answer.uid != null && answer.uid !== ticket.person_id) app.store.updateTicket(ticket.id, { person_id: answer.uid });
    answer.record(`${answer.by} answered your ship card: Ship It. ${APP_NAME} handed your ship off as you prepared it, with no turn of yours. If it has to go again and what they approved is unchanged, hand it off with go "${go}".`);
    app.runner.emit(ticket.id, 'note', { text: `${answer.by} pressed Ship It, so ${APP_NAME} started this ship with no turn.` });
    return null;
  } catch (err) {
    return thrown(err)
      .message!.replace(/^Not handed off: /, '')
      .replace(/\s+/g, ' ')
      .slice(0, 400);
  }
}
