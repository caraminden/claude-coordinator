// What a person sent, drawn in the chat: the bubble, its images and files, a long message's clamp, a taken-back line.
import { asSpeaker, authorKind } from './avatars.js';
import { GITHUB_NAME, machineAuthor, senderTone } from './chattext.js';
import { api, fileHref, formatSize, h, me, taskmasterName, view } from './base.js';
import { askHeader } from './askcard.js';
import { loadDraft, saveDraft } from './composer.js';
import { markdown, threadRefs, holdPicSize } from './core.js';
import { noteStrike, struckSource } from './strike.js';
import { optimistic } from './ui/optimistic.js';
import { threadNumberHref } from './threadrefs.js';
/** Show a long message's first lines, with a button for the rest. */
export function clamp(msg) {
  msg.classList.add('clamped');
  msg.append(h('button', { type: 'button', class: 'show-all small secondary', onclick: () => unclamp(msg) }, 'Show all'));
}

export function unclamp(msg) {
  msg.classList.remove('clamped');
  msg.querySelector(':scope > .show-all')?.remove();
}

/** A message's rendered text, keeping its source so a strike_text that lands later can redraw it. */
export function messageBody(text, strikes, ticketId, eventId) {
  const body = markdown(struckSource(text, strikes), ticketId);
  body.dataset.body = eventId;
  Object.assign(body, { source: text, ticketId, strikes });
  return body;
}

/** A blob's bytes as base64, the way a message carries an image. */
export const blobBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

/** An object URL for base64 image data (the page's CSP allows blob: images but not data: ones). */
export function base64Url(mediaType, data) {
  return URL.createObjectURL(new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type: mediaType }));
}

/** A sent image fetched back as { mediaType, data }, the way the composer holds one. */
async function imageData(src) {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`Could not load its image (HTTP ${res.status})`);
  const blob = await res.blob();
  const data = await blobBase64(blob);
  return { mediaType: blob.type, data };
}

/**
 * A strike_text note, or null: "Struck through in #116: ~~the wrong words~~ → the reason", linking the
 * chat that shows the message when that's another one.
 */
export function strikeNote(data) {
  const s = noteStrike(data);
  if (!s) return null;
  const c = s.chat;
  const where = c === null ? ' above' : c ? [' in ', h('a', { class: 'thread-ref', href: c.number == null ? `#/p/${c.project}` : threadNumberHref(c.project, c.number) }, c.number == null ? `the ${taskmasterName(c.project)}'s chat` : `#${c.number}`)] : '';
  return h('div', { class: 'note strike-note' }, `✎ Struck through`, where, ': ', h('del', {}, s.quote), ' → ', threadRefs(s.reason));
}

/** A chat message from a person; `about`, for a comment on a file, links that file. */
/**
 * A message still queued for the next turn says so, with a ✕ to take it back and, on your own, a ✎ to
 * take it back into the message box to fix and resend; it loses them once sent.
 */
export function markQueued(bubble, ticket) {
  if (bubble.classList.contains('withdrawn')) return; // taken back, or being taken back from this tab
  const id = Number(bubble.dataset.event);
  const queued = !!ticket?.queued_ids?.includes(id);
  const tag = bubble.querySelector('.queued-tag');
  if (!queued) return tag?.remove();
  if (tag) return;
  // Both show at once and send behind; a refusal (the turn took it meanwhile) puts the bubble back as it is now.
  const takeBack = (label, apply, send, undo = () => {}) =>
    optimistic({
      key: `unqueue:${id}`,
      apply: () => {
        showTakenBack(bubble, me);
        apply();
      },
      send,
      undo: () => {
        if (!bubble.querySelector('.taken-back-tag.mine')) return; // the server's own "taken back" came meanwhile
        bubble.classList.remove('withdrawn');
        bubble.querySelector('.taken-back-tag')?.remove();
        markQueued(bubble, view?.id === ticket.id ? view.ticket : ticket);
        undo();
      },
      label,
    });
  const unqueue = () => api(`api/tickets/${ticket.id}/unqueue`, { method: 'POST', body: { id } });
  const sent = bubble.sent;
  let takeOut;
  const edit =
    sent &&
    h(
      'button',
      {
        type: 'button',
        class: 'take-back',
        title: 'Take back to edit',
        'aria-label': 'Take back to edit',
        onclick: (e) => {
          e.preventDefault();
          takeBack(
            'take back the message to edit',
            () => {
              const form = view?.id === ticket.id && document.querySelector('.composer');
              // Its files go in now; its images once they have loaded, below.
              if (form)
                takeOut = form.editBack(
                  sent.text,
                  sent.files.map((upload) => ({ upload })),
                );
              else {
                // A Retry from another chat: the text waits in this chat's draft (attachments stay in the struck bubble).
                const draft = loadDraft(`cc-draft:${ticket.id}`)?.trim();
                saveDraft(`cc-draft:${ticket.id}`, draft ? `${sent.text}\n${draft}` : sent.text);
                takeOut = null;
              }
            },
            async () => {
              // Images first: if one won't load, the message stays queued rather than coming back without it.
              const images = await Promise.all(sent.images.map((name) => imageData(`api/tickets/${ticket.id}/images/${encodeURIComponent(name)}`)));
              await unqueue();
              if (takeOut && view?.id === ticket.id) document.querySelector('.composer')?.attach(images);
            },
            () => takeOut?.(),
          );
        },
      },
      '✎',
    );
  bubble.querySelector('.who').append(
    h(
      'span',
      { class: 'msg-tag queued-tag' },
      'queued for the next turn',
      edit ?? '',
      h(
        'button',
        {
          type: 'button',
          class: 'take-back',
          title: 'Take back this message',
          'aria-label': 'Take back this message',
          onclick: (e) => {
            e.preventDefault(); // a Taskmaster message's ✕ sits in its <summary>
            takeBack('take back the message', () => {}, unqueue);
          },
        },
        '✕',
      ),
    ),
  );
}

/** A message struck through as taken back, by the server's word or (class mine) this tab's click while it sends. */
export function showTakenBack(bubble, by, mine = true) {
  bubble.querySelector('.queued-tag')?.remove();
  bubble.querySelector('.taken-back-tag')?.remove();
  bubble.classList.add('withdrawn');
  bubble.querySelector('.who').append(h('span', { class: `msg-tag taken-back-tag${mine ? ' mine' : ''}` }, `taken back by ${by}`));
}

export function userBubble(author, text, imageSrcs, about = null, event = null, files = []) {
  const github = author === GITHUB_NAME;
  const msg = h('div', { class: github ? 'msg user github' : 'msg user' }, asSpeaker(h('div', { class: 'who' }, author, about ? [' on ', h('a', { class: 'about', href: fileHref(about.ticketId, about.path), title: about.path }, about.name)] : ''), authorKind(author), author));
  // GitHub's messages end lines with bare URLs, which Markdown alone would leave as text.
  if (github && text) text = text.replace(/(^|\s)(https?:\/\/[^\s<>]*[^\s<>.,;:!?'")\]])/g, '$1[$2]($2)');
  if (text) msg.append(event ? messageBody(text, event.strikes, null, event.id) : markdown(text));
  if (event?.mentions?.length) chipMentions(msg, event.mentions);
  if (imageSrcs.length) {
    msg.append(
      h(
        'div',
        { class: 'images' },
        imageSrcs.map((src) => {
          const img = h('img', { src, alt: 'Attached image', loading: 'lazy' });
          holdPicSize(img);
          return h('a', { href: src, target: '_blank', rel: 'noopener' }, img);
        }),
      ),
    );
  }
  if (files.length) msg.append(h('div', { class: 'files' }, files.map(fileChip)));
  // A contraption's ask: its header and summary, the full text behind the toggle (askcard.js).
  if (event?.ask) {
    msg.querySelector('.who').remove();
    return h('details', { class: 'msg user ask' }, h('summary', {}, asSpeaker(h('div', { class: 'who' }, askHeader(event.ask)), 'person', event.ask.person ?? author), h('div', { class: 'ask-summary' }, event.ask.summary)), msg);
  }
  // Messages between Claudes and from the app aren't meant for people, so they start collapsed to one line,
  // except the brief that started the minion: it says what the minion is for.
  const who = machineAuthor(author);
  // Sent by another agent: it takes its sender's colour (#693), a Taskmaster's (this scheme's or another's) or a minion's.
  const tone = senderTone(author) ? ` ${senderTone(author)}` : '';
  // A schedule's brief starts collapsed (Cara, 2026-11-16: "scheduled briefs can start collapsed"), its row naming the schedule; the rest keep the brief open.
  if (who && event?.brief && !event.schedule) {
    msg.querySelector('.who').textContent = who;
    msg.className += tone;
  } else if (who) {
    msg.querySelector('.who').remove();
    return h('details', { class: `msg user coord${tone}` }, h('summary', {}, asSpeaker(h('span', { class: 'who' }, h('span', { class: 'name' }, event?.schedule ? `${who}: ${event.schedule}` : who)), authorKind(author)), h('span', { class: 'preview' }, previewNodes(text, event?.strikes))), msg);
  }
  return msg;
}

/**
 * Each "@Name" in a message's words that the server found a mention of (#1149) as a chip; yours stands out. Code and
 * links keep their text. The words stay as typed, which is what the agent reads.
 */
export function chipMentions(root, names) {
  const esc = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `@(${[...names]
      .sort((a, b) => b.length - a.length)
      .map(esc)
      .join('|')})(?![\\p{L}\\p{N}_-])`,
    'giu',
  );
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement.closest('code, a, .who, .mention') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
  const texts = [];
  while (walk.nextNode()) texts.push(walk.currentNode);
  for (const node of texts) {
    const parts = node.data.split(re);
    if (parts.length < 2) continue;
    // split with one group: words, then the matched name, in turn.
    node.replaceWith(
      ...parts.map((part, i) => {
        if (i % 2 === 0) return part;
        const name = names.find((n) => n.toLowerCase() === part.toLowerCase()) ?? part;
        return h('span', { class: `mention${me && name.toLowerCase() === me.toLowerCase() ? ' me' : ''}`, title: `Mentioned ${name}` }, `@${part}`);
      }),
    );
  }
}

/** A collapsed message's one line: its text without Markdown marks, struck words keeping their line. */
export function previewNodes(text, strikes) {
  // A heading's # marks go, but not a #575 reference's.
  const flat = (t) =>
    t
      .replace(/(^|\s)#{1,6}(?=\s)/g, '$1')
      .replace(/[*_`>\[\]~]/g, '')
      .replace(/\s+/g, ' ');
  // A URL in the one-line preview is still a link (Citadel-wide: links are clickable); it opens without toggling the message.
  // URLs are found before the marks go, so a link with _ or # in it keeps them.
  const links = (t) => t.split(/(https?:\/\/[^\s()<>\[\]`]+[^\s()<>\[\]`.,;:!?'"*_~])/).map((bit, i) => (i % 2 ? h('a', { href: bit, target: '_blank', rel: 'noopener', onclick: (e) => e.stopPropagation() }, bit) : flat(bit)));
  return struckSource((text ?? '').trim(), strikes)
    .split(/~~(.+?)~~/)
    .flatMap((part, i) => (i % 2 ? h('del', {}, flat(part)) : links(part)));
}

/** An attached file in a message: images and PDFs open in a tab (the server says so), anything else downloads. */
export function fileChip({ name, size, href }) {
  const opens = /\.(png|jpe?g|gif|webp|avif|pdf)$/i.test(name); // the same list as INLINE in src/uploads.ts
  return h('a', { class: 'file-chip', href, title: opens ? `Open ${name}` : `Download ${name}`, ...(opens ? { target: '_blank', rel: 'noopener' } : { download: name }) }, h('span', { class: 'icon', 'aria-hidden': 'true' }, '📄'), h('span', { class: 'name' }, name), h('span', { class: 'size' }, formatSize(size)));
}
