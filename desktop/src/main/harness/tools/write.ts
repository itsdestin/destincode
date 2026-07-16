import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { defineTool } from './registry';
import { canonicalize, resolveP } from './guards';
import { toHunks } from './edit';

export const WriteTool = defineTool({
  name: 'Write',
  description: 'Create a new file or fully overwrite an existing one. To overwrite, you must Read the file first.',
  inputSchema: z.object({ file_path: z.string(), content: z.string() }),
  permissionSubject: (a) => a.file_path,
  async execute(args, ctx) {
    const abs = resolveP(args.file_path, ctx.cwd);
    const canonical = canonicalize(args.file_path, ctx.cwd);
    const exists = fs.existsSync(abs);
    if (exists && !ctx.readRegistry.has(canonical)) {
      return {
        text: `Write rejected: ${args.file_path} already exists. Read it first so you know what you are replacing.`,
        isError: true,
      };
    }
    const old = exists ? fs.readFileSync(abs, 'utf8') : '';
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, args.content);
    ctx.readRegistry.set(canonical, fs.statSync(abs).mtimeMs);
    return {
      text: `${exists ? 'Overwrote' : 'Created'} ${args.file_path} (${args.content.length} chars).`,
      structuredPatch: toHunks(old, args.content, args.file_path),
    };
  },
});
