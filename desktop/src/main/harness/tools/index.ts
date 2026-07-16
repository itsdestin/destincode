import type { NativeTool } from './types';
import { ReadTool } from './read';
import { WriteTool } from './write';
import { EditTool } from './edit';
import { BashTool } from './bash';
import { GlobTool } from './glob';
import { GrepTool } from './grep';
import { TodoWriteTool } from './todo-write';

/** Plan A core set. Plan B appends WebFetch/WebSearch/AskUserQuestion. */
export const CORE_TOOLS: NativeTool[] = [ReadTool, WriteTool, EditTool, BashTool, GlobTool, GrepTool, TodoWriteTool];
export const toolByName = new Map(CORE_TOOLS.map((t) => [t.name, t]));
