import type { NativeTool } from './types';
import { ReadTool } from './read';
import { WriteTool } from './write';
import { EditTool } from './edit';
import { BashOutputTool } from './bash-output';
import { KillShellTool } from './kill-shell';
import { BashTool } from './bash';
import { GlobTool } from './glob';
import { GrepTool } from './grep';
import { TodoWriteTool } from './todo-write';
import { WebFetchTool } from './web-fetch';
import { WebSearchTool } from './web-search';
import { AskUserQuestionTool } from './ask-user-question';
import { SendUserFileTool } from './send-user-file';

/** Plan A core set + Plan B tools + SendUserFile (2026-08-25). WebFetch/WebSearch
 *  are the web pair (free in every preset/mode — see permission-types.rulesForMode);
 *  AskUserQuestion (interactive, driver-routed) comes last. */
export const CORE_TOOLS: NativeTool[] = [ReadTool, WriteTool, EditTool, BashTool, BashOutputTool, KillShellTool, GlobTool, GrepTool, TodoWriteTool, WebFetchTool, WebSearchTool, SendUserFileTool, AskUserQuestionTool];
