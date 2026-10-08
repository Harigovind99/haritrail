import * as path from 'path';
import { LineRange, StepKind } from './types';

export interface ToolDescription {
  kind: StepKind;
  verb: string;
  title: string;
  filePath?: string;
  readRange?: LineRange;
}

const TEST_RE =
  /(^|[\s;&|(])(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(jest|vitest|mocha|ava|tap|karma|playwright\s+test|cypress\s+run|pytest|py\.test|nosetests|tox|unittest|rspec|minitest|phpunit|pest|go\s+test|cargo\s+(nextest|test)|dotnet\s+test|mvn(w)?\s+(-\S+\s+)*test|gradle(w)?\s+(\S+\s+)*test|ctest|swift\s+test|mix\s+test|flutter\s+test|deno\s+test|bats)\b|\bnode\s+--test\b|run_tests?|\btest\.(sh|py)\b/i;
const BUILD_RE =
  /\b(tsc|webpack|vite\s+build|esbuild|rollup|next\s+build|make|cmake|ninja|cargo\s+(build|check|clippy)|go\s+(build|vet)|mvn(w)?\s+(-\S+\s+)*(package|compile|install|verify)|gradle(w)?\s+(\S+\s+)*(build|assemble)|dotnet\s+build|msbuild|swift\s+build|gcc|g\+\+|clang|javac|(npm|pnpm|yarn|bun)\s+(run\s+)?(build|compile|lint|typecheck|check)|eslint|ruff|mypy|pylint|flake8|prettier\s+--check)\b/i;
const INSTALL_RE =
  /\b((npm|pnpm|bun)\s+(i|install|add|ci)|yarn(\s+(add|install))?\s*$|yarn\s+(add|install)|pip3?\s+install|uv\s+(add|pip|sync)|poetry\s+(add|install)|cargo\s+add|go\s+(get|mod\s+tidy)|apt(-get)?\s+install|brew\s+install|gem\s+install|bundle\s+install|composer\s+(require|install)|dotnet\s+add)\b/i;
const GIT_RE = /(^|[\s;&|(])(git|gh)\s+/;

/** Classify a shell command into run / test / build / git / install. */
export function classifyCommand(command: string): StepKind {
  const c = command.trim();
  if (TEST_RE.test(c)) {
    return 'test';
  }
  if (INSTALL_RE.test(c)) {
    return 'install';
  }
  if (BUILD_RE.test(c)) {
    return 'build';
  }
  if (GIT_RE.test(c) && /^\s*(cd\s+\S+\s*&&\s*)?(git|gh)\s+/.test(c)) {
    return 'git';
  }
  return 'run';
}

export function oneLine(text: string, max = 80): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, Math.max(1, max - 3)).trimEnd() + '...' : s;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Resolve a path the agent used against the session working directory. */
export function resolveAgentPath(p: string, cwd?: string): string {
  if (path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p)) {
    return path.normalize(p);
  }
  return cwd ? path.normalize(path.join(cwd, p)) : p;
}

const VERBS: Record<StepKind, string> = {
  read: 'Read',
  edit: 'Edited',
  create: 'Created',
  search: 'Searched',
  run: 'Ran',
  test: 'Tested',
  build: 'Built',
  git: 'Git',
  install: 'Installed',
  delegate: 'Delegated',
  web: 'Browsed',
  plan: 'Planned',
  mcp: 'Called',
  ask: 'Asked you',
  skill: 'Used skill',
  other: 'Used',
};

export function verbFor(kind: StepKind): string {
  return VERBS[kind];
}

/**
 * Turn one tool_use block into something people can read at a glance.
 * Unknown tools still get a sensible label so new Claude Code tools never break the view.
 */
export function describeTool(name: string, input: Record<string, unknown>, cwd?: string): ToolDescription {
  const filePathOf = (key: string): string | undefined => {
    const p = str(input[key]);
    return p ? resolveAgentPath(p, cwd) : undefined;
  };
  const base = (p: string) => path.basename(p) || p;

  switch (name) {
    case 'Read':
    case 'NotebookRead': {
      const filePath = filePathOf('file_path') ?? filePathOf('notebook_path');
      const offset = num(input.offset);
      const limit = num(input.limit);
      let readRange: LineRange | undefined;
      if (offset !== undefined || limit !== undefined) {
        const start = Math.max(1, offset ?? 1);
        readRange = { start, end: limit !== undefined ? start + Math.max(1, limit) - 1 : start };
      }
      return { kind: 'read', verb: 'Read', title: filePath ? base(filePath) : 'file', filePath, readRange };
    }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const filePath = filePathOf('file_path') ?? filePathOf('notebook_path');
      return { kind: 'edit', verb: 'Edited', title: filePath ? base(filePath) : 'file', filePath };
    }
    case 'Write': {
      const filePath = filePathOf('file_path');
      // Corrected to "edit" later if the result says the file already existed.
      return { kind: 'create', verb: 'Created', title: filePath ? base(filePath) : 'file', filePath };
    }
    case 'Grep': {
      const pattern = str(input.pattern) ?? '';
      const scope = str(input.glob) ?? str(input.type) ?? (str(input.path) ? base(str(input.path)!) : undefined);
      return { kind: 'search', verb: 'Searched', title: oneLine(`"${pattern}"${scope ? ' in ' + scope : ''}`, 70) };
    }
    case 'Glob':
      return { kind: 'search', verb: 'Listed', title: oneLine(str(input.pattern) ?? '*', 70) };
    case 'LS':
      return { kind: 'search', verb: 'Listed', title: oneLine(str(input.path) ? base(str(input.path)!) : '.', 70) };
    case 'Bash':
    case 'PowerShell': {
      const command = str(input.command) ?? '';
      const kind = classifyCommand(command);
      return { kind, verb: verbFor(kind), title: oneLine(command.split('\n')[0] || command, 70) };
    }
    case 'BashOutput':
      return { kind: 'run', verb: 'Checked', title: 'background command output' };
    case 'KillShell':
    case 'KillBash':
      return { kind: 'run', verb: 'Stopped', title: 'background command' };
    case 'Task':
    case 'Agent': {
      const desc = str(input.description) ?? str(input.subagent_type) ?? 'subagent';
      const who = str(input.subagent_type);
      return { kind: 'delegate', verb: 'Delegated', title: oneLine(who && who !== desc ? `${desc} (${who})` : desc, 70) };
    }
    case 'WebFetch': {
      const url = str(input.url) ?? '';
      let title = url;
      try {
        const u = new URL(url);
        title = u.hostname + (u.pathname !== '/' ? u.pathname : '');
      } catch {
        /* keep raw */
      }
      return { kind: 'web', verb: 'Fetched', title: oneLine(title, 70) };
    }
    case 'WebSearch':
      return { kind: 'web', verb: 'Searched web', title: oneLine(`"${str(input.query) ?? ''}"`, 70) };
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos) ? input.todos : [];
      const doing = todos.find((t) => (t as { status?: string })?.status === 'in_progress') as
        | { content?: string; activeForm?: string }
        | undefined;
      const title = doing ? oneLine(doing.activeForm ?? doing.content ?? '', 60) : `${todos.length} to-dos`;
      return { kind: 'plan', verb: 'Planned', title };
    }
    case 'TaskCreate':
      return { kind: 'plan', verb: 'Planned', title: oneLine(str(input.subject) ?? 'new task', 60) };
    case 'TaskUpdate': {
      const id = str(input.taskId) ?? (typeof input.taskId === 'number' ? String(input.taskId) : undefined);
      const status = str(input.status);
      return { kind: 'plan', verb: 'Planned', title: oneLine(`task ${id ? '#' + id : ''}${status ? ': ' + status.replace(/_/g, ' ') : ' updated'}`, 60) };
    }
    case 'ToolSearch':
      return { kind: 'other', verb: 'Loaded', title: 'more tools' };
    case 'SendUserMessage':
      return { kind: 'ask', verb: 'Messaged', title: 'you' };
    case 'ExitPlanMode':
    case 'EnterPlanMode':
      return { kind: 'plan', verb: 'Planned', title: name === 'ExitPlanMode' ? 'presented a plan' : 'entered plan mode' };
    case 'AskUserQuestion':
      return { kind: 'ask', verb: 'Asked you', title: 'a question' };
    case 'Skill':
    case 'SlashCommand':
      return { kind: 'skill', verb: 'Used skill', title: oneLine(str(input.skill) ?? str(input.command) ?? name, 60) };
    default:
      break;
  }
  if (name.startsWith('mcp__')) {
    const [, server = 'mcp', ...rest] = name.split('__');
    return { kind: 'mcp', verb: 'Called', title: oneLine(`${server} · ${rest.join('__') || 'tool'}`, 60) };
  }
  // Unknown tool: try to find a file path so the trail still lands somewhere.
  const anyPath = filePathOf('file_path') ?? filePathOf('path');
  return { kind: 'other', verb: 'Used', title: name, filePath: anyPath && /\.[a-z0-9]+$/i.test(anyPath) ? anyPath : undefined };
}

/** Count lines changed between two snippets, ignoring identical leading/trailing lines. */
export function countLineChanges(oldText: string, newText: string): { added: number; removed: number } {
  const a = oldText.length ? oldText.split('\n') : [];
  const b = newText.length ? newText.split('\n') : [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  return { added: Math.max(0, endB - start + 1), removed: Math.max(0, endA - start + 1) };
}

export interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export function isPatchHunks(v: unknown): v is PatchHunk[] {
  return (
    Array.isArray(v) &&
    v.every((h) => h && typeof h === 'object' && typeof (h as PatchHunk).newStart === 'number' && Array.isArray((h as PatchHunk).lines))
  );
}

/** Read a structured patch into exact +/- counts and changed line ranges (new-file coordinates). */
export function rangesFromPatch(hunks: PatchHunk[]): { ranges: LineRange[]; added: number; removed: number } {
  const ranges: LineRange[] = [];
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    let line = h.newStart;
    let cur: LineRange | undefined;
    let pendingDeletion = false;
    const flush = () => {
      if (cur) {
        ranges.push(cur);
        cur = undefined;
      }
    };
    for (const raw of h.lines) {
      const tag = raw.charAt(0);
      if (tag === '+') {
        added++;
        if (cur && cur.end === line - 1 && !cur.deletionOnly) {
          cur.end = line;
        } else {
          flush();
          cur = { start: line, end: line };
        }
        pendingDeletion = false;
        line++;
      } else if (tag === '-') {
        removed++;
        if (!cur) {
          pendingDeletion = true;
        }
      } else if (tag === '\\') {
        // "\ No newline at end of file"
      } else {
        if (pendingDeletion && !cur) {
          ranges.push({ start: Math.max(1, line - 1), end: Math.max(1, line - 1), deletionOnly: true });
        }
        pendingDeletion = false;
        flush();
        line++;
      }
    }
    if (pendingDeletion && !cur) {
      ranges.push({ start: Math.max(1, line - 1), end: Math.max(1, line - 1), deletionOnly: true });
    }
    flush();
  }
  return { ranges, added, removed };
}

const FAIL_RE =
  /(\b[1-9]\d*\s+(failed|failing|failures?)\b|\bFAIL(ED)?\b|AssertionError|Traceback \(most recent call last\)|\bpanicked at\b|BUILD FAILURE|npm ERR!|\berror TS\d+)/;

/** Guess whether a test command's output was a pass or a fail. */
export function guessTestOutcome(output: string, isError: boolean): 'pass' | 'fail' {
  if (isError) {
    return 'fail';
  }
  return FAIL_RE.test(output.slice(-20000)) ? 'fail' : 'pass';
}
