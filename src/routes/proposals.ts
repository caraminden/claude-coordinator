// The proposal and approval routes (#1715, moved out of tickets.ts): what a minion or Taskmaster asks a person for in its
// chat (a plan, a machine's notes or lending, a host tool, a release key, an approval of a tool call) and the person's
// verdict on it.
import { join } from 'node:path';
import { lines, mcpMerge, mergeTarget, plainMerge } from '../approvals.ts';
import { lendsMachine, managesMachine } from '../access.ts';
import { APP_NAME } from '../appname.ts';
import { cardHref } from '../card-links.ts';
import { keyFiles } from '../release-key.ts';
import { originRepo } from '../github.ts';
import { lineDiff } from '../instructions.ts';
import { parseMerge, prInfo } from '../merge-card.ts';
import { tripwireConfig } from '../turn-launch.ts';
import { tmpDirFor } from '../turn-tmp.ts';
import { claudeConfigDir } from '../sessions.ts';
import { HttpError, isRecord, json, ownWrites, readJson, str, ticketView, type Route } from '../http.ts';
import { homeApp, makeKey } from './app.ts';
import { deciding, postPlan } from '../plan-cards.ts';
import { saveInstructions, type HeldEdit } from '../instructions-save.ts';
import { machineNotes, patchMachine } from './machines.ts';
import { lendAfter, lendLines, lendPatch, parseLendChange } from '../machine-lend.ts';
import { installCommand, LIVE_MANIFEST, listed, parseHostTool, readManifest, sourceName, toolLabel } from '../host-tools.ts';
import { approveHostTool } from '../host-tool-ship.ts';
import { addressee, deliverAnswer, personWrote } from './tickets.ts';
import { thrown } from '../thrown.ts';
import { decideTidy } from './memory-curator.ts';

// How long one wait for an approval card's outcome holds the request open.
const APPROVAL_POLL_MS = 25_000;

export const proposalRoutes: Route[] = [
  {
    method: 'POST',
    path: '/api/tickets/:ticket/plans',
    who: ['self'],
    refuse: 'Only the minion or Taskmaster itself can propose a plan in its chat',
    async handler(ctx) {
      const { req, res, app, ticket } = ctx;
      const { id } = ticket;
      const { store, runner } = app;
      // Claude proposes a plan: an Approve / Revise card that waits, across restarts, for a person.
      const body = await readJson(req);
      const plan = str(body.plan, 'Plan', 20_000);
      const summary = str(body.summary, 'Summary', 200);
      const to = addressee(app, ticket, body.to);
      const event = postPlan(app, id, { summary, plan, ...(to ? { to } : {}) });
      return json(res, 201, { id: JSON.parse(event.data).id, href: cardHref(ticket, event.id) });
    },
  },
  {
    method: 'POST',
    path: '/api/tickets/:ticket/machine-notes',
    who: ['minion'],
    refuse: "Only the minion itself can propose a machine's notes in its chat",
    async handler(ctx) {
      const { req, res, app, ticket } = ctx;
      const { store } = app;
      // A minion proposes a machine's whole new notes (#617, Josh: "Minion proposes, owner approves"): a plan card
      // only the machine's owner or an admin can approve, which writes them through the Machines page's PATCH.
      const body = await readJson(req);
      const name = str(body.machine, 'Machine', 30).toLowerCase();
      const notes = machineNotes(body.notes);
      const project = store.getProject(ticket.project_id)!;
      const asker = store.turnAsker(ticket.id);
      const machine = store.listMachines().find((m) => m.name === name);
      // As a turn of this minion's gets it (src/runner.ts): lent to this scheme, and someone's own only on its owner's ask.
      if (!machine || !lendsMachine(store, machine, project, asker === null ? [] : [asker])) throw new HttpError(404, `No machine called ${name} that this minion gets`);
      if (notes === machine.notes) throw new HttpError(400, `Those are already ${name}'s notes`);
      const owner = machine.owner_id === null ? null : (store.getUser(machine.owner_id)?.name ?? null);
      const event = postPlan(app, ticket.id, {
        summary: `New notes for ${name}`,
        plan: notes,
        machine: { id: machine.id, name, owner },
        old: machine.notes,
        diff: lineDiff(machine.notes, notes),
      });
      return json(res, 201, { id: JSON.parse(event.data).id, href: cardHref(ticket, event.id), owner });
    },
  },
  {
    method: 'POST',
    path: '/api/tickets/:ticket/machine-lend',
    who: ['self'],
    refuse: 'Only the minion or Taskmaster itself can propose machine lending in its chat',
    async handler(ctx) {
      const { req, res, app, ticket } = ctx;
      const { store } = app;
      // propose_machine_lend (#1638): a card whose Approve saves the change through the Machines page's PATCH (src/machine-lend.ts).
      const body = await readJson(req);
      const name = str(body.machine, 'Machine', 30).toLowerCase();
      let change;
      try {
        change = parseLendChange(body);
      } catch (err) {
        throw new HttpError(400, thrown(err).message!);
      }
      const why = body.why === undefined ? '' : str(body.why, 'Why', 500);
      const project = store.getProject(ticket.project_id)!;
      // Any machine by name, lent here or not: asking for one not lent yet is the point. Approving is who can save it on the page.
      // Someone else's own machine stays out of sight (#306): only shared ones and the turn's asker's own.
      const asker = store.turnAsker(ticket.id);
      const seen = store.listMachines().filter((m) => m.owner_id === null || m.owner_id === asker);
      const machine = seen.find((m) => m.name === name);
      const view = machine && app.machines.view(machine);
      if (!machine || !view || view.runners) {
        const names = seen.filter((m) => !app.machines.view(m).runners).map((m) => m.name);
        throw new HttpError(404, machine ? `${name} is a CI runner host: it lends no tools` : `No machine called ${name}; there are ${names.join(', ') || 'none'}`);
      }
      // An online agent says what it has, so a typo is caught here, not after a person approves it. Offline, nobody knows.
      const page = `#/p/${project.id}/machines/${name}`;
      if (view.managed === false && (change.tick || change.untick || change.server !== undefined)) {
        throw new HttpError(400, `${name}'s agent is from before ticks: it lends what its own command line says. Propose workspace_tools instead, or ask its owner to reinstall it from [${name} on the Machines page](${page})`);
      }
      if (view.managed) {
        const missing = (change.tick ?? []).filter((w) => !view.workspaces.some((f) => f.name === w));
        if (missing.length) throw new HttpError(400, `${name} has no workspace called ${missing.join(', ')}; it has ${view.workspaces.map((w) => w.name).join(', ') || 'none'}`);
        if (change.server && !view.found.some((f) => f.name === change.server)) throw new HttpError(400, `${name} has no MCP server called ${change.server}; it found ${view.found.map((f) => f.name).join(', ') || 'none'}`);
      }
      const now = { projects: view.projects, lend: view.lend, workspace_tools: view.workspace_tools, always_on: view.always_on, managed: view.managed };
      const scheme = { id: project.id, name: project.name };
      const lines = lendLines(change, now, scheme, name);
      if (!lines.length) throw new HttpError(400, `Nothing to change: ${name} already ${Object.keys(change).length ? 'has all of that' : 'is as it is; name what should change'}`);
      const after = lendAfter(change, now, project.id);
      const was = view.projects.includes(project.id);
      const owner = machine.owner_id === null ? null : (store.getUser(machine.owner_id)?.name ?? null);
      const event = postPlan(app, ticket.id, {
        summary: change.here === false && was ? `Take ${name} from ${project.name}` : change.here && !was ? `Lend ${name} to ${project.name}` : `Change what ${name} lends`,
        plan: [
          ...lines,
          '',
          view.managed === false ? 'It goes on lending what its own command line says.' : `After this it lends: ${after.server ? `the ${after.server} MCP server; ` : ''}${after.workspaces.length ? `workspaces ${after.workspaces.join(', ')}` : 'no workspaces'}.`,
          ...(why ? ['', `Why: ${why}`] : []),
          '',
          `[${name} on the Machines page](${page})`,
        ].join('\n'),
        machineLend: { id: machine.id, name, owner, scheme, change, lines, after, why, page },
      });
      return json(res, 201, { id: JSON.parse(event.data).id, href: cardHref(ticket, event.id), owner, page });
    },
  },
  {
    method: 'POST',
    path: '/api/tickets/:ticket/host-tool',
    who: ['minion'],
    refuse: 'Only the minion itself can propose a host tool in its chat',
    async handler(ctx) {
      const { req, res, app, ticket } = ctx;
      // propose_host_tool (#1147; Josh, 2026-11-19): a card showing the exact install; only a member of the Citadel scheme approves it.
      let tool;
      try {
        tool = parseHostTool(await readJson(req));
      } catch (err) {
        throw new HttpError(400, thrown(err).message!);
      }
      if (listed(readManifest(LIVE_MANIFEST), tool)) throw new HttpError(400, `${toolLabel(tool)} is on the server already: it's in the host tools list`);
      const command = installCommand(tool);
      const byHand = tool.source === 'pacman';
      const event = postPlan(app, ticket.id, {
        summary: `Install ${toolLabel(tool)} on the server`,
        plan: `${tool.why}\n\n${byHand ? 'A person runs, by hand (the server has no root)' : 'Approve runs, on the server'}:\n\n\`\`\`\n${command}\n\`\`\`\n\n${byHand ? `pacman takes no version: it installs the repo's current one, and the list's check flags it unless that is ${tool.version}. ` : ''}From ${sourceName(tool.source)}. It is listed in the host tools list, which a rebuild of the server installs from.`,
        hostTool: { ...tool, command },
      });
      return json(res, 201, { id: JSON.parse(event.data).id, href: cardHref(ticket, event.id) });
    },
  },
  {
    method: 'POST',
    path: '/api/tickets/:ticket/release-key',
    who: ['self'],
    refuse: 'Only the minion or Taskmaster itself can ask for a release key in its chat',
    async handler(ctx) {
      const { req, res, app, ticket } = ctx;
      // make_release_key (#837; Cara, 2026-11-17, "Both"): a card a member approves, which makes the key on the server.
      // Neither the key nor its password goes through the chat; the card only names where they are.
      const c = homeApp(app, ticket.project_id, str((await readJson(req))?.contraption, 'contraption', 100));
      const { jks, pass } = keyFiles(app.apkBuilds.keyDir, c.name);
      const event = postPlan(app, ticket.id, {
        summary: `Make ${c.title}'s release key`,
        plan: `Approve makes ${c.title}'s Android signing key on the server: \`${jks}\`, with a random password in \`${pass}\` beside it, both readable only by ${APP_NAME}. Neither goes in a repo or a chat. It signs every APK from now on, so it is never replaced, and it goes off-box with the nightly backup. Its first APK builds once it's made.`,
        releaseKey: { app: c.name, title: c.title },
      });
      return json(res, 201, { id: JSON.parse(event.data).id, href: cardHref(ticket, event.id) });
    },
  },
  {
    method: 'POST',
    path: '/api/tickets/:ticket/verdict',
    who: ['person'],
    refuse: 'Only people approve plans',
    async handler(ctx) {
      const { req, res, app, session, ticket } = ctx;
      const { id } = ticket;
      const { store, runner } = app;
      // A person approves a plan card (the go) or sends it back with notes; never the minion or the Taskmaster.
      const body = await readJson(req);
      if (body.verdict !== 'approve' && body.verdict !== 'revise' && body.verdict !== 'reject') throw new HttpError(400, 'verdict must be approve, revise or reject');
      const event = store.eventsOfKinds(id, ['plan']).find((e) => JSON.parse(e.data).id === body.planId);
      if (!event) throw new HttpError(404, 'No such plan');
      const card = JSON.parse(event.data);
      // A held instructions edit (#1162): Save anyway, Work it in (notes optional) or Cancel edit; only it has a reject of its own.
      const ins = card.instructions as HeldEdit | undefined;
      if (body.verdict === 'reject' && !ins) throw new HttpError(400, 'verdict must be approve or revise');
      // A machine's notes card (#617) or a release key card (#837): a reason to reject is optional, and a reject is final.
      // A host tool card (#1147) too.
      // A machine lending card (#1638) too, and a memory tidy card (#1803).
      const fixed = card.machine || card.releaseKey || card.hostTool || card.machineLend || card.memory;
      const ml = card.machineLend;
      const notes = body.verdict === 'approve' ? null : (fixed || ins) && !String(body.notes ?? '').trim() ? '' : str(body.notes, 'Notes', 10_000);
      if (card.status === 'withdrawn') throw new HttpError(409, 'Its minion withdrew this card: nothing to answer');
      if (card.status === 'dismissed') throw new HttpError(409, `${card.by} dismissed this card`);
      if (card.status === 'superseded')
        throw new HttpError(
          409,
          card.machine
            ? `A newer proposal for ${card.machine.name}'s notes replaced this one`
            : ml
              ? `A newer proposal for ${ml.name}'s lending replaced this one`
              : card.releaseKey
                ? 'A newer card for this key replaced this one'
                : card.hostTool
                  ? `A newer proposal for ${card.hostTool.package} replaced this one`
                  : 'A newer plan replaced this one',
        );
      if (ins && card.status !== 'pending') throw new HttpError(409, `${card.by} already ${card.status === 'approved' ? 'saved' : card.status === 'rejected' ? 'cancelled' : 'sent back'} this edit`);
      if (card.status !== 'pending')
        throw new HttpError(
          409,
          fixed
            ? `${card.by} already ${card.status === 'approved' ? 'approved' : 'rejected'} ${card.machine ? 'these notes' : ml ? 'this change' : card.hostTool ? 'this tool' : card.memory ? 'this memory tidy' : 'this key'}`
            : `${card.by} already ${card.status === 'approved' ? 'approved this plan' : 'asked for changes'}`,
        );
      // One answer per card: the key, the notes and the install each take time (keytool, a write) before the card says "approved",
      // so a second click in that gap would run them again after the first one's answer. Held until the card's new status is readable.
      if (deciding.has(event.id)) throw new HttpError(409, `${card.by}'s card is being answered right now`);
      deciding.add(event.id);
      try {
        if (card.machine && notes === null) {
          const machine = store.getMachine(card.machine.id);
          if (!machine) throw new HttpError(409, `${card.machine.name} was removed`);
          if (!managesMachine(session, machine)) throw new HttpError(403, `Only ${card.machine.owner ? `${card.machine.owner}, who owns ${card.machine.name},` : 'an admin'}${card.machine.owner ? ' or an admin' : ''} can approve its notes`);
          // Approve writes what the card showed, or nothing: notes changed since (on the Machines page) aren't overwritten unseen.
          if (machine.name !== card.machine.name || machine.notes !== card.old) throw new HttpError(409, `${card.machine.name}'s notes changed since this was proposed; ask the minion to propose them again`);
          await patchMachine(app, session, machine, { notes: card.plan });
        }
        let lendResult = '';
        if (ml && notes === null) {
          const machine = store.getMachine(ml.id);
          if (!machine || machine.name !== ml.name) throw new HttpError(409, `${ml.name} was removed or renamed; ask for it again`);
          // Who can save it on the Machines page (Cara, 2026-11-22, "Who can save the page"): an admin, or its owner for their own.
          if (!managesMachine(session, machine)) throw new HttpError(403, `Only ${ml.owner ? `${ml.owner}, who owns ${ml.name},` : 'an admin'}${ml.owner ? ' or an admin' : ''} can change what it lends`);
          const v = app.machines.view(machine);
          const patch = lendPatch(ml.change, { projects: v.projects, lend: v.lend, workspace_tools: v.workspace_tools, always_on: v.always_on, managed: v.managed }, ml.scheme.id);
          if (patch.projects?.includes(ml.scheme.id) && !store.canSee(session, ml.scheme.id)) throw new HttpError(403, `You aren't in ${ml.scheme.name}, so you can't lend ${ml.name} to it`);
          // The same save as the page's: the agent is told the ticks, and sessions on what is no longer lent end.
          if (Object.keys(patch).length) await patchMachine(app, session, machine, patch);
          lendResult = Object.keys(patch).length ? '' : ' (it already had all of that: someone saved it on the Machines page meanwhile)';
        }
        // A memory tidy card (#1803): Approve wakes the run, which applies it all with apply_memory through the page's own
        // decideTidy; Reject turns it down here. Either way only while the tidy is open: one ticked on the page is decided.
        if (card.memory) {
          const p = store.memoryProposals.get(card.memory.proposal);
          if (p && p.status !== 'open') {
            // The tidy was decided but its card never was (a kill between the two, 2ME7): settle the card now, so its buttons go.
            const settled = { status: p.status === 'applied' ? 'approved' : p.status === 'superseded' ? 'superseded' : 'rejected', by: p.decided_by ?? 'Citadel', at: Date.now() };
            store.setEventData(event.id, { ...card, ...settled });
            runner.emit(id, 'plan_result', { id: card.id, ...settled });
          }
          if (!p || p.status !== 'open') throw new HttpError(409, !p ? 'That memory tidy is gone' : p.status === 'superseded' ? 'A newer tidy replaced this one' : `${p.decided_by} already ${p.status === 'applied' ? 'applied' : 'turned down'} this tidy on the Memory page`);
          if (notes !== null) decideTidy(app, store.getProject(p.project_id)!, p, [], session.name);
        }
        // A host tool installs software on the server every scheme's turns share: a member of the Citadel scheme approves it (Josh, 2026-11-19).
        if (card.hostTool && notes === null && !session.admin) throw new HttpError(403, `Only a member of the ${APP_NAME} scheme can approve installing software on the server`);
        if (ins && notes === null) {
          // Save anyway writes what the card showed, or nothing: a Settings save since then isn't overwritten unseen.
          if (ins.scope === 'citadel' && !session.admin) throw new HttpError(403, `Only a ${APP_NAME} admin or a member of the ${APP_NAME} scheme can save the ${APP_NAME}-wide text`);
          const now = ins.scope === 'citadel' ? store.appInstructions().text : store.getProject(ins.project)?.instructions;
          if (now !== ins.old) throw new HttpError(409, 'The instructions changed since this edit was held; ask the minion to make it again');
          await saveInstructions(app, id, ins, `${ins.by}, saved by ${session.name}`);
        }
        // A release key card (#837): any member of the app's home scheme makes the key, as the Releases page's button does.
        if (card.releaseKey && notes === null) await makeKey(app, session, card.releaseKey.app);
        const result = { status: body.verdict === 'approve' ? 'approved' : fixed || body.verdict === 'reject' ? 'rejected' : 'revising', by: session.name, at: Date.now() };
        store.setEventData(event.id, { ...card, ...result });
        runner.emit(id, 'plan_result', { id: card.id, ...result });
        runner.echoOverlordAnswer(ticket, session.name, `${card.summary}\n→ ${notes === null ? (ins ? 'Saved anyway' : 'Approved') : body.verdict === 'reject' ? `Cancelled${notes ? `: ${notes}` : ''}` : `Sent back${notes ? `: ${notes}` : ''}`}`, undefined, session.uid);
        deliverAnswer(
          app,
          id,
          session.name,
          ins
            ? notes === null
              ? 'Saved anyway: your instructions edit is saved as it was, beside what already said it.'
              : body.verdict === 'reject'
                ? `Cancelled: your instructions edit is dropped and nothing was saved. Don't make it again unless asked.${notes ? `\n\n${notes}` : ''}`
                : `Work it in: nothing was saved. Put your change where the card shows it is already said, or reword it to point there in a few words, then call edit_instructions again.${notes ? `\n\n${notes}` : ''}`
            : card.hostTool
              ? notes === null
                ? card.hostTool.source === 'pacman'
                  ? `Approved: ${toolLabel(card.hostTool)} goes in the host tools list. You get a message saying who runs the install.`
                  : `Approved: ${toolLabel(card.hostTool)} is installing on the server now (\`${card.hostTool.command}\`). You get a message once it's in. Keep working on what doesn't depend on it.`
                : `Rejected installing ${toolLabel(card.hostTool)}; nothing was installed.${notes ? `\n\n${notes}` : ''}`
              : card.releaseKey
                ? notes === null
                  ? `Approved: ${card.releaseKey.title}'s release key is made on the server, and its APK is building now. The key and its password stay out of chats and repos.`
                  : `Rejected the release key card for ${card.releaseKey.title}; no key was made.${notes ? `\n\n${notes}` : ''}`
                : ml
                  ? notes === null
                    ? `Approved: ${ml.name}'s lending is saved as the card showed${lendResult}. Its agent has it now, and minion turns that start from now get it: a minion that needs it ends its turn and carries on in the next.`
                    : `Rejected your proposed lending for ${ml.name}; nothing changed.${notes ? `\n\n${notes}` : ''}`
                  : card.memory
                    ? notes === null
                      ? `Approved: ${session.name} approved your memory tidy (${card.memory.counts}). Call apply_memory now: it applies every change, deletes too, and says what changed. Then report that in a few lines and close yourself with close_self.`
                      : `${session.name} turned the memory tidy down; nothing changed.${notes ? `\n\n${notes}` : ''} Close yourself with close_self.`
                    : card.machine
                      ? notes === null
                        ? `Approved: ${card.machine.name}'s new notes are saved, and turns read them from their next start.`
                        : `Rejected your proposed notes for ${card.machine.name}; they are unchanged.${notes ? `\n\n${notes}` : ''}`
                      : notes === null
                        ? `Plan approved: build it this way. ("${card.summary}")`
                        : `Revise the plan ("${card.summary}") before building:\n\n${notes}\n\nPost the revised plan with propose_plan, and write no code until it is approved.`,
          { plan: { planId: card.id, verdict: body.verdict } },
        );
        // After the answer, so its message comes first; it runs behind the click (an install can take minutes).
        if (card.hostTool && notes === null) void approveHostTool(app, id, card.hostTool, session.name);
        personWrote(ctx);
        return json(res, 202, ticketView(app, id));
      } finally {
        await ownWrites();
        deciding.delete(event.id);
      }
    },
  },
  {
    method: 'POST',
    path: '/api/tickets/:ticket/approvals',
    who: ['minion'],
    refuse: 'Only the minion itself can ask for approval in its chat',
    async handler(ctx) {
      const { req, res, ticket, app } = ctx;
      const { id } = ticket;
      const { store, runner } = app;
      // Claude Code asks before a tool call (a tripwire ask or an approval rule): an Approve / Deny card, or a refusal.
      if (!runner.isRunning(id)) throw new HttpError(409, 'The minion is not mid-turn');
      const body = await readJson(req);
      const tool = str(body.tool_name, 'Tool name', 300);
      const input = isRecord(body.input) ? body.input : {};
      const use = typeof body.tool_use_id === 'string' ? body.tool_use_id.slice(0, 200) : undefined;
      const project = store.getProject(ticket.project_id)!;
      const rules = lines(project.approval_rules).length > 0;
      // A merge's card shows the PR, looked up once now as the turn's own GitHub login.
      const merge = rules && tool === 'Bash' && typeof input.command === 'string' ? parseMerge(input.command) : null;
      const env = merge && runner.turnGithubEnv(id);
      const pr = merge && env ? await prInfo(merge, ticket.cwd, env) : null;
      // With a person's typed go standing in the scheme (#201, #260), a plain merge's PR decides whether it skips the card.
      const goCall = rules && runner.approvals.hasGo(project.id) ? (tool === 'Bash' ? (plainMerge(String(input.command), merge) ? merge : null) : mcpMerge(tool, input)) : null;
      const goEnv = goCall && goCall !== merge ? runner.turnGithubEnv(id) : null;
      const goPr = goCall === merge ? pr : goCall && goEnv ? await prInfo(goCall, ticket.cwd, goEnv) : null;
      // A merge in another shape (chained, a cd, no --repo) may be its PR's: then it's sent back once with the plain command (#209).
      const near = rules && !goCall && merge && env && !merge.admin && merge.method !== 'rebase' && runner.approvals.hasGo(project.id) ? merge : null;
      const schemeRepo = (goCall || near) && project.repo_dir ? await originRepo(project.repo_dir) : null;
      const target = goCall ? mergeTarget(goPr, schemeRepo) : null;
      // The card's lookup skips a moved shell's PR; a refusal runs nothing, so the worktree's answer does here.
      const nearPr = near ? (pr ?? (near.moved && !near.repo ? await prInfo({ ...near, moved: false }, ticket.cwd, env!) : null)) : null;
      const nearTarget = near ? mergeTarget(nearPr, schemeRepo) : null;
      const retry = nearTarget && { target: nearTarget, command: `gh pr merge ${nearTarget.number} --repo ${schemeRepo} ${near!.method === 'merge' ? '--merge' : '--squash'}${near!.auto ? ' --auto' : ''}` };
      if ((merge || goCall) && !runner.isRunning(id)) throw new HttpError(409, 'The minion is not mid-turn');
      // Judged with the turn's TMPDIR (src/turn-launch.ts), as its hook judged it, not the server's own.
      const cfg = { ...tripwireConfig(project.id, claudeConfigDir(process.env), true), env: { ...process.env, TMPDIR: tmpDirFor(runner.tmpRoot(project.id), id) } };
      const r = runner.approvals.ask(id, tool, input, ticket.cwd, cfg, rules, merge ? { ...merge, pr } : undefined, target, retry, use);
      return json(res, 'id' in r ? 201 : 200, r);
    },
  },
  {
    method: 'GET',
    path: '/api/tickets/:ticket/approvals',
    who: ['minion'],
    refuse: 'Only the minion itself can wait on its approvals',
    async handler(ctx) {
      const { res, url, app, ticket } = ctx;
      const { id } = ticket;
      const { runner } = app;
      // The thread's MCP server waits here for the card's outcome, half a minute at a time.
      return json(res, 200, await runner.approvals.wait(id, url.searchParams.get('id') ?? '', APPROVAL_POLL_MS));
    },
  },
  {
    method: 'POST',
    path: '/api/tickets/:ticket/approve',
    who: ['person'],
    refuse: 'Only people approve tool calls',
    async handler(ctx) {
      const { req, res, session, app, ticket } = ctx;
      const { id } = ticket;
      const { runner } = app;
      // Only a signed-in person's click settles a card; the coordinator and threads cannot.
      const body = await readJson(req);
      if (typeof body.allow !== 'boolean') throw new HttpError(400, 'allow must be true or false');
      const approvalId = String(body.approvalId ?? '');
      const before = runner.approvals.get(id, approvalId);
      if (before.state === 'expired') throw new HttpError(409, 'This request expired; the turn that asked has ended');
      if (before.state !== 'pending') throw new HttpError(409, `${before.by} already ${before.state === 'allowed' ? 'approved' : 'denied'} this`);
      if (body.allow && runner.approvals.isTripwire(approvalId) && !session.admin) throw new HttpError(403, 'Only an admin can approve a tripwire card');
      runner.startNow.touch(id, session.uid);
      return json(res, 200, runner.approvals.decide(id, approvalId, body.allow, session.name));
    },
  },
];
