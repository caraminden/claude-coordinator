// A turn's GitHub token is in its env (#182), so `env` or `echo $GH_TOKEN` would print it into the
// chat, which everyone in the scheme reads. These shapes are distinctive enough to hide (#481 added
// Citadel's machine tokens from machines.ts, Anthropic and AWS keys, and PEM private keys).
const TOKENS: [RegExp, string][] = [
  [/\b(gh[opsur]_[A-Za-z0-9]{30,}|github_pat_\w{40,})\b/g, '[GitHub token hidden]'],
  [/\bccm_\d+_[\w-]{43}/g, '[Citadel machine token hidden]'],
  [/\bsk-ant-[\w-]{20,}/g, '[Anthropic key hidden]'],
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, '[AWS key hidden]'],
  // To its END line, or to the end of the text when the output was cut off inside it.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[private key hidden]'],
];
export const hideTokens = (s: string) => TOKENS.reduce((out, [shape, hidden]) => out.replace(shape, hidden), s);
