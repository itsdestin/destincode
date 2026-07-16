import type { NativeTool } from './types';
import { ReadTool } from './read';
import { WriteTool } from './write';
import { EditTool } from './edit';
import { BashTool } from './bash';
import { GlobTool } from './glob';
import { GrepTool } from './grep';
import { TodoWriteTool } from './todo-write';
import { AskUserQuestionTool } from './ask-user-question';

/** Plan A core set + Plan B tools. WebFetch/WebSearch are appended by their own
 *  task; AskUserQuestion (interactive, driver-routed) is appended here. */
export const CORE_TOOLS: NativeTool[] = [ReadTool, WriteTool, EditTool, BashTool, GlobTool, GrepTool, TodoWriteTool, AskUserQuestionTool];
export const toolByName = new Map(CORE_TOOLS.map((t) => [t.name, t]));
