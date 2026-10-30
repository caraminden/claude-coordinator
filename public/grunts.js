// Grunts (subagents) in a chat: their reports fold to one line each, and a fan-out to one block.

/**
 * The Agent call a stored event belongs to when a Grunt said or did it, else null. Claude Code tags
 * every event from inside a subagent with the tool call that started it; the minion's own have none.
 */
export function gruntOf(kind, data) {
  return kind === 'claude' && typeof data?.parent_tool_use_id === 'string' && data.parent_tool_use_id ? data.parent_tool_use_id : null;
}

/** A Grunt report's one line: its "Verdict:" line if it has one, else its first line of text, without Markdown. */
export function gist(text) {
  const lines = String(text ?? '').split('\n').map((l) => l.replace(/[#*_`>~|]/g, '').replace(/^\s*[-+]\s+/, '').trim()).filter(Boolean);
  const line = lines.find((l) => /^verdict\b/i.test(l)) ?? lines[0] ?? '';
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

/** Who a Grunt is, from the Agent call's input: its description, else its agent type. */
export function gruntName(input) {
  const name = [input?.description, input?.subagent_type].find((s) => typeof s === 'string' && s.trim());
  return name ? name.trim() : 'Grunt';
}

/** A fan-out block's title: "8 Grunts finished", with the span from the first start to the last report when known. */
export function groupTitle(count, ms, duration) {
  return [`${count} Grunt${count === 1 ? '' : 's'} finished`, ms > 0 ? duration(ms) : ''].filter(Boolean).join(' · ');
}
