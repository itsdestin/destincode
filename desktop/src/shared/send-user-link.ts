// Shared vocabulary for the "link deliverable", used by three surfaces that
// must agree on it and that may not import each other:
//   1. the NATIVE harness tool  — main/harness/tools/send-user-link.ts
//   2. the CLAUDE CODE MCP tool — main/claude-code-mcp.ts deploys a one-tool
//      MCP server and attaches it per session, because the real `claude` CLI
//      ships SendUserFile and has no link equivalent
//   3. the RENDERER, which must recognise BOTH names as "this is a link
//      deliverable" and draw the same Deliverables tile for either
// Lives in shared/ so the renderer never reaches into main/ to learn a name.

/** The native harness tool's name. */
export const SEND_USER_LINK_TOOL = 'SendUserLink';

/** The MCP server id the app attaches to Claude Code sessions. Also the
 *  display name Claude Code shows for the server in `/mcp`. */
export const CLAUDE_CODE_MCP_SERVER_ID = 'youcoded';

/** The tool name Claude Code composes for it: `mcp__{server}__{tool}`.
 *
 *  Matched EXACTLY everywhere, never as a `mcp__*__SendUserLink` wildcard: the
 *  app can install third-party MCP servers from the marketplace, and any of
 *  them could name a tool `SendUserLink`. A wildcard would let an unrelated
 *  server draw official-looking, one-click-to-the-browser link tiles in the
 *  user's chat. */
export const CLAUDE_CODE_LINK_TOOL = `mcp__${CLAUDE_CODE_MCP_SERVER_ID}__${SEND_USER_LINK_TOOL}`;

/** True for either spelling of the link deliverable — the native tool, or the
 *  Claude Code MCP tool. The single answer to "should this render as a link
 *  tile?", shared by the renderer's card, its bubble hoist, and the fallback
 *  tool views. */
export function isSendUserLinkToolName(name: string): boolean {
  return name === SEND_USER_LINK_TOOL || name === CLAUDE_CODE_LINK_TOOL;
}

/** What both tools tell the model they are for. The native tool appends its
 *  own sentences about parameters it alone accepts; keeping the first three
 *  sentences identical keeps model behaviour identical across session types. */
export const SEND_USER_LINK_BASE_DESCRIPTION = [
  'Send finished URLs to the user — a deployed page, a preview, a localhost dev server, an API — as a "Deliverables" card with links they can open in the browser.',
  'Use it for links the user will want to visit, not for every URL mentioned in passing; do not re-send a link that has not changed.',
  'Only http:// and https:// URLs are accepted (use an absolute URL — localhost and LAN IPs are fine, e.g. http://localhost:5173).',
].join(' ');
