// Turns a zod validation failure on a tool call into ONE sentence the model can
// act on. This is the only place tool-argument errors are worded — the driver
// (harness-session.ts runOneTool, step 1) calls it for every failed safeParse.
//
// WHY (ledger D-2, 2026-08-26 native-tools investigation): every native tool
// schema is now `.strict()`, so a parameter the tool does not know — e.g. a
// Claude-Code-trained model sending `Grep {"-i": true}` — is an ERROR instead
// of being silently dropped. An error is only useful if it says which name was
// wrong AND which names are right, so the model's next call is the fixed one.
// The other failure kinds (missing / wrong type / bad enum value) get the same
// treatment: name the field in plain words rather than zod's raw
// "Invalid input: expected string, received undefined".
import type { z } from 'zod';

/** The parameter names a schema accepts, when it is a plain object schema.
 *  zod v4 exposes `.shape` directly on ZodObject; anything else (records,
 *  unions, the MCP passthrough) has no fixed list, so we return undefined and
 *  the message simply omits the list rather than guessing one. */
export function validParameterNames(schema: z.ZodType): string[] | undefined {
  const shape = (schema as { shape?: unknown }).shape;
  return shape && typeof shape === 'object' ? Object.keys(shape as object) : undefined;
}

function label(path: readonly PropertyKey[]): string {
  return path.map(String).join('.');
}

export function formatArgErrors(toolName: string, error: z.ZodError, schema: z.ZodType): string {
  const problems: string[] = [];
  const unknown: string[] = [];
  let unknownAtTopLevel = false;
  for (const issue of error.issues) {
    const field = label(issue.path);
    switch (issue.code) {
      case 'unrecognized_keys': {
        // One issue may carry several keys; collect them and word them once below.
        if (field === '') unknownAtTopLevel = true;
        for (const k of issue.keys) unknown.push(field ? `${field}.${k}` : k);
        break;
      }
      case 'invalid_type': {
        // zod v4 does not expose the received type as a field — only in its
        // message ("…expected string, received undefined"). "received undefined"
        // is the missing-required case, which deserves its own wording.
        const received = /received (\w+)/.exec(issue.message)?.[1];
        if (received === 'undefined') problems.push(`missing required parameter "${field}" (expected ${issue.expected})`);
        else problems.push(`"${field}" must be a ${issue.expected}${received ? ` (received ${received})` : ''}`);
        break;
      }
      case 'invalid_value': {
        // Enum mismatch: list the allowed values verbatim so the fix is a copy.
        problems.push(`"${field}" must be one of ${issue.values.map((v) => JSON.stringify(v)).join(', ')}`);
        break;
      }
      default:
        // Anything else (min/max, regex, custom refinements): zod's own message,
        // prefixed with the field so it can still be located.
        problems.push(field ? `"${field}": ${issue.message}` : issue.message);
    }
  }
  if (unknown.length > 0) {
    let s = `unknown parameter(s) ${unknown.map((k) => `"${k}"`).join(', ')}`;
    // The valid list only makes sense for top-level keys — it IS the top-level shape.
    const valid = unknownAtTopLevel ? validParameterNames(schema) : undefined;
    if (valid) s += `. Valid parameters: ${valid.join(', ')}`;
    problems.unshift(s);
  }
  return `Invalid arguments for ${toolName}: ${problems.join('; ')}. Fix the arguments and call again.`;
}
