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

/** True for the tools that run a shell command. */
export function isShellTool(name: string): boolean {
  return name === 'Bash' || name === 'PowerShell';
}

// ------------------------------------------------------------------ shell commands that only look

/** Shell commands that print files. Agents often read code this way instead of with the Read tool. */
const LOOK_READ = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'bat', 'batcat', 'nl', 'sed', 'wc', 'diff', 'cmp', 'stat', 'file',
  'xxd', 'od', 'hexdump', 'strings', 'readlink', 'realpath', 'get-content', 'gc',
]);
/** Shell commands that list or search files. */
const LOOK_SEARCH = new Set([
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'find', 'fd', 'fdfind', 'ls', 'tree', 'locate', 'which', 'du',
  'select-string', 'sls', 'get-childitem', 'gci', 'dir',
]);
/** Harmless helpers that appear around a look (after cd, inside a pipe) but are not a look on their own. */
const LOOK_HELPERS = new Set([
  'cd', 'pushd', 'popd', 'set-location', 'pwd', 'echo', 'printf', 'true', 'sort', 'uniq', 'cut', 'tr', 'awk',
  'column', 'jq', 'fmt', 'fold', 'rev', 'tac', 'paste', 'basename', 'dirname', 'select-object', 'measure-object',
]);
/** Commands whose one file operand HariTrail can place on the map. */
const SINGLE_FILE_READERS = new Set(['cat', 'nl', 'head', 'tail', 'bat', 'batcat', 'less', 'more', 'sed', 'get-content', 'gc']);

export interface ShellParse {
  /** Words of each simple command, split on |, ||, &&, ;, & and new lines. */
  segments: string[][];
  /**
   * True when the command may write a file or run code that cannot be seen in its words: output
   * redirected to a file, a here-document, command or process substitution, or an unclosed quote.
   */
  unsafe: boolean;
}

/** A small, quote-aware split of a shell command. Not a full shell parser: anything unusual is marked unsafe. */
export function parseShell(command: string): ShellParse {
  const c = command;
  const segments: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: string | undefined;
  let unsafe = false;
  const endWord = () => {
    if (inWord) {
      words.push(word);
    }
    word = '';
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) {
      segments.push(words);
    }
    words = [];
  };
  /** Reads the word a redirection points at; returns it and the index of its last character. */
  const target = (from: number): [string, number] => {
    let j = from;
    while (j < c.length && (c[j] === ' ' || c[j] === '\t')) {
      j++;
    }
    let t = '';
    let q: string | undefined;
    for (; j < c.length; j++) {
      const x = c[j];
      if (q) {
        if (x === q) {
          q = undefined;
        } else {
          t += x;
        }
        continue;
      }
      if (x === '"' || x === "'") {
        q = x;
        continue;
      }
      if (' \t\n;|&<>'.includes(x)) {
        break;
      }
      t += x;
    }
    return [t, j - 1];
  };
  /** Output redirection starting at `from` (just after the > or &>): only /dev/null is harmless. */
  const redirect = (from: number): number => {
    let j = from;
    if (c[j] === '>' || c[j] === '|') {
      j++;
    }
    if (c[j] === '&') {
      // >&2, >&- : duplicate or close a stream; no file is written.
      j++;
      while (j < c.length && /[0-9-]/.test(c[j])) {
        j++;
      }
      return j - 1;
    }
    if (c[j] === '(') {
      unsafe = true;
      return j;
    }
    const [t, end] = target(j);
    if (t !== '/dev/null') {
      unsafe = true;
    }
    return end;
  };

  for (let i = 0; i < c.length; i++) {
    const ch = c[i];
    if (quote) {
      if (ch === quote) {
        quote = undefined;
      } else if (ch === '\\' && quote === '"' && i + 1 < c.length) {
        word += c[++i];
      } else {
        if (quote === '"' && (ch === '`' || (ch === '$' && c[i + 1] === '('))) {
          unsafe = true;
        }
        word += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
      continue;
    }
    if (ch === '\\' && i + 1 < c.length) {
      i++;
      if (c[i] !== '\n') {
        word += c[i];
        inWord = true;
      }
      continue;
    }
    if (ch === '`' || (ch === '$' && c[i + 1] === '(')) {
      unsafe = true;
      word += ch;
      inWord = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      endWord();
      continue;
    }
    if (ch === '\n' || ch === ';') {
      endSegment();
      continue;
    }
    if (ch === '|') {
      if (c[i + 1] === '|') {
        i++;
      }
      endSegment();
      continue;
    }
    if (ch === '&') {
      if (c[i + 1] === '&') {
        i++;
        endSegment();
      } else if (c[i + 1] === '>') {
        endWord();
        i = redirect(i + 2);
      } else {
        endSegment();
      }
      continue;
    }
    if (ch === '>') {
      if (/^\d+$/.test(word)) {
        // "2>" names a stream, not an argument.
        word = '';
        inWord = false;
      } else {
        endWord();
      }
      i = redirect(i + 1);
      continue;
    }
    if (ch === '<') {
      endWord();
      if (c[i + 1] === '<' || c[i + 1] === '(') {
        unsafe = true;
        i++;
      }
      continue;
    }
    word += ch;
    inWord = true;
  }
  if (quote) {
    unsafe = true;
  }
  endSegment();
  return { segments, unsafe };
}

/** The words of one simple command with leading VAR=value assignments dropped and the name lower-cased. */
function commandWords(seg: string[]): string[] {
  let k = 0;
  while (k < seg.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[k])) {
    k++;
  }
  const out = seg.slice(k);
  if (out.length) {
    out[0] = (out[0].split(/[\\/]/).pop() || out[0]).toLowerCase();
  }
  return out;
}

type Look = 'read' | 'search' | 'helper';

/** The command xargs runs, without xargs' own options. */
function xargsCommand(args: string[]): string[] {
  let k = 0;
  while (k < args.length && args[k].startsWith('-')) {
    if (/^-[InPLdEsa]$/.test(args[k])) {
      k++;
    }
    k++;
  }
  return commandWords(args.slice(k));
}

/** Whether one simple command only looks at files, and how. Undefined means it may do anything else. */
function lookOf(words: string[]): Look | undefined {
  if (!words.length) {
    return 'helper';
  }
  const [name, ...args] = words;
  if (name === 'xargs') {
    const inner = xargsCommand(args);
    return inner.length ? lookOf(inner) : 'helper';
  }
  if (name === 'sed' && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) {
    return undefined;
  }
  if (name === 'find' || name === 'fd' || name === 'fdfind') {
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (/^-(delete|fprint0?|fprintf|fls)$/.test(a)) {
        return undefined;
      }
      if (/^-(exec|execdir|ok|okdir)$/.test(a) || ((name === 'fd' || name === 'fdfind') && /^(-x|-X|--exec|--exec-batch)$/.test(a))) {
        const inner: string[] = [];
        for (k++; k < args.length && args[k] !== ';' && args[k] !== '+'; k++) {
          inner.push(args[k]);
        }
        const look = lookOf(commandWords(inner));
        if (look !== 'read' && look !== 'search') {
          return undefined;
        }
      }
    }
    return 'search';
  }
  if (LOOK_SEARCH.has(name)) {
    return 'search';
  }
  if (LOOK_READ.has(name)) {
    return 'read';
  }
  if (LOOK_HELPERS.has(name)) {
    return 'helper';
  }
  return undefined;
}

/**
 * 'read' or 'search' when a shell command only reads or lists files (cat, sed -n, grep, rg, find, ls...),
 * so it counts as exploring rather than as a check. Anything that could write a file or run other code
 * returns undefined.
 */
export function shellLook(command: string): 'read' | 'search' | undefined {
  const { segments, unsafe } = parseShell(command);
  if (unsafe || !segments.length) {
    return undefined;
  }
  let kind: 'read' | 'search' | undefined;
  for (const seg of segments) {
    const look = lookOf(commandWords(seg));
    if (look === undefined) {
      return undefined;
    }
    if (look === 'search') {
      kind = 'search';
    } else if (look === 'read' && kind !== 'search') {
      kind = 'read';
    }
  }
  return kind;
}

const GLOB_RE = /[*?[\]{}$~]/;

/** Lines named by a sed -n script such as '10,40p' or '12p'. */
function sedRange(script: string): LineRange | undefined {
  const m = /^\s*(\d+)\s*(?:,\s*(\d+))?\s*p\s*$/.exec(script);
  if (!m) {
    return undefined;
  }
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : start;
  return start >= 1 && end >= start ? { start, end } : undefined;
}

/** The count in head -n 30, head -30 or head --lines=30. */
function headCount(args: string[]): number | undefined {
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    let m = /^-(\d+)$/.exec(a) ?? /^-n(\d+)$/.exec(a) ?? /^--lines=(\d+)$/.exec(a);
    if (!m && a === '-n' && k + 1 < args.length) {
      m = /^(\d+)$/.exec(args[k + 1]);
    }
    if (m) {
      return Number(m[1]);
    }
  }
  return undefined;
}

/** The file operands of a single-file reader and the lines it prints, when it says. */
function readerOperands(words: string[]): { files: string[]; range?: LineRange } | undefined {
  const [name, ...args] = words;
  if (!SINGLE_FILE_READERS.has(name)) {
    return undefined;
  }
  const files: string[] = [];
  let range: LineRange | undefined;
  if (name === 'sed') {
    let quiet = false;
    let script: string | undefined;
    const operands: string[] = [];
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (a === '-e' || a === '--expression') {
        script = args[++k];
      } else if (a.startsWith('--expression=')) {
        script = a.slice('--expression='.length);
      } else if (a === '-f' || a.startsWith('--file')) {
        return undefined;
      } else if (a === '-n' || a === '--quiet' || a === '--silent') {
        quiet = true;
      } else if (/^-[a-zA-Z]+$/.test(a)) {
        quiet = quiet || a.includes('n');
      } else {
        operands.push(a);
      }
    }
    if (script === undefined) {
      script = operands.shift();
    }
    if (quiet && script !== undefined) {
      range = sedRange(script);
    }
    return { files: operands, range };
  }
  if (name === 'get-content' || name === 'gc') {
    for (let k = 0; k < args.length; k++) {
      const a = args[k].toLowerCase();
      if (a === '-path' || a === '-literalpath') {
        files.push(args[++k]);
      } else if (a === '-totalcount' || a === '-head' || a === '-first') {
        const n = Number(args[++k]);
        range = Number.isInteger(n) && n > 0 ? { start: 1, end: n } : undefined;
      } else if (a.startsWith('-')) {
        k++;
      } else {
        files.push(args[k]);
      }
    }
    return { files, range };
  }
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') {
      files.push(...args.slice(k + 1));
      break;
    }
    if ((name === 'head' || name === 'tail') && (a === '-n' || a === '-c')) {
      k++;
    } else if (name === 'nl' && /^-[bdfhilnpsvw]$/.test(a)) {
      k++;
    } else if (!a.startsWith('-') || a === '-') {
      files.push(a);
    }
  }
  if (name === 'head') {
    const n = headCount(args);
    range = n && n > 0 ? { start: 1, end: n } : undefined;
  }
  return { files, range };
}

/** Lines picked by the second command of `nl -ba file | sed -n '10,40p'` or `cat -n file | head -50`. */
function linePicker(words: string[]): { range?: LineRange } | undefined {
  const [name, ...args] = words;
  if (name === 'head') {
    const n = headCount(args);
    return { range: n && n > 0 ? { start: 1, end: n } : undefined };
  }
  if (name === 'tail') {
    return {};
  }
  if (name === 'sed') {
    const r = readerOperands(words);
    return r && r.files.length === 0 ? { range: r.range } : undefined;
  }
  return undefined;
}

/**
 * The one file a shell read prints (`cat src/app.py`, `sed -n '10,40p' src/app.py`,
 * `cd pkg && nl -ba util.py | sed -n '5,9p'`), resolved against the session's working directory,
 * with the lines when the command names them. Undefined when it reads several files or is unclear.
 */
export function shellReadTarget(command: string, cwd?: string): { filePath: string; readRange?: LineRange } | undefined {
  const { segments, unsafe } = parseShell(command);
  if (unsafe) {
    return undefined;
  }
  const segs = segments.map(commandWords).filter((w) => w.length);
  let dir = cwd;
  while (segs.length && segs[0][0] === 'cd') {
    const to = segs[0][1];
    if (!to || segs[0].length > 2 || to === '-' || GLOB_RE.test(to)) {
      return undefined;
    }
    dir = resolveAgentPath(to, dir);
    segs.shift();
  }
  if (segs.length === 0 || segs.length > 2) {
    return undefined;
  }
  const first = readerOperands(segs[0]);
  if (!first || first.files.length !== 1 || first.files[0] === '-' || GLOB_RE.test(first.files[0])) {
    return undefined;
  }
  let range = first.range;
  if (segs.length === 2) {
    const pick = linePicker(segs[1]);
    if (!pick) {
      return undefined;
    }
    range = pick.range;
  }
  return { filePath: resolveAgentPath(first.files[0], dir), readRange: range };
}

/**
 * Classify a shell command into read / search (it only looks at files) or run / test / build / git / install.
 * Looking comes first, so `grep pytest setup.cfg` or `cat test.py` is not mistaken for a test run.
 */
export function classifyCommand(command: string): StepKind {
  const c = command.trim();
  const look = shellLook(c);
  if (look) {
    return look;
  }
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
      const d: ToolDescription = { kind, verb: verbFor(kind), title: oneLine(command.split('\n')[0] || command, 70) };
      if (kind === 'read') {
        // `cat src/app.py` lands on the file, like the Read tool, so footprints and revisits see it.
        const target = shellReadTarget(command, cwd);
        if (target) {
          d.filePath = target.filePath;
          d.readRange = target.readRange;
        }
      }
      return d;
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
