import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionSummary } from '../model/types';
import { cleanPrompt, sourceLabel, typedByPerson } from '../model/session';

/** Where Claude Code keeps its data: setting > CLAUDE_CONFIG_DIR > ~/.claude */
export function claudeHome(override?: string): string {
  const o = override?.trim();
  if (o) {
    return o.startsWith('~') ? path.join(os.homedir(), o.slice(1)) : o;
  }
  const env = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (env) {
    return env;
  }
  return path.join(os.homedir(), '.claude');
}

/** Claude Code names each project folder after its path with every non-alphanumeric char turned into "-". */
export function encodeProjectPath(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

function samePath(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

export function isInside(child: string, parent: string): boolean {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  const [cc, pp] = process.platform === 'win32' ? [c.toLowerCase(), p.toLowerCase()] : [c, p];
  return cc === pp || cc.startsWith(pp.endsWith(path.sep) ? pp : pp + path.sep);
}

async function readHead(file: string, bytes: number): Promise<string> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    const text = buf.toString('utf8', 0, bytesRead);
    // Drop a possibly cut-off last line.
    return bytesRead === bytes ? text.slice(0, text.lastIndexOf('\n') + 1) : text;
  } finally {
    await fh.close();
  }
}

/** Peek the first lines of a transcript for its cwd, session id and first real prompt. */
export async function peekSession(
  file: string,
  bytes = 512 * 1024,
): Promise<{ cwd?: string; sessionId?: string; firstPrompt?: string; source?: string }> {
  const out: { cwd?: string; sessionId?: string; firstPrompt?: string; source?: string } = {};
  let head = '';
  try {
    head = await readHead(file, bytes);
  } catch {
    return out;
  }
  for (const line of head.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!out.source && typeof rec.entrypoint === 'string') {
      out.source = sourceLabel(rec.entrypoint);
    }
    if (!out.cwd && typeof rec.cwd === 'string') {
      out.cwd = rec.cwd;
    }
    if (!out.sessionId && typeof rec.sessionId === 'string') {
      out.sessionId = rec.sessionId;
    }
    if (!out.firstPrompt && rec.type === 'user' && !rec.isMeta && !rec.isSidechain && typedByPerson(rec.origin)) {
      const msg = rec.message as { content?: unknown } | undefined;
      const c = msg?.content;
      let text = '';
      if (typeof c === 'string') {
        text = c;
      } else if (Array.isArray(c) && !c.some((b) => b?.type === 'tool_result')) {
        text = c.map((b) => (b?.type === 'text' ? b.text : '')).join('\n');
      }
      const cleaned = cleanPrompt(text);
      if (cleaned.kind === 'prompt') {
        out.firstPrompt = cleaned.text;
      }
    }
    if (out.cwd && out.sessionId && out.firstPrompt && out.source) {
      break;
    }
  }
  return out;
}

/**
 * Finds the Claude Code transcripts that belong to the open workspace folders.
 * Fast path: the encoded folder name. Slow path (cached): read the `cwd` recorded
 * inside each project's newest transcript, which also catches sessions started in
 * a sub-folder of the workspace and names Claude Code shortened.
 */
export class SessionLocator {
  private readonly cwdCache = new Map<string, string>();

  constructor(
    private readonly home: string,
    private readonly workspaceFolders: string[],
  ) {}

  get projectsRoot(): string {
    return path.join(this.home, 'projects');
  }

  async projectDirs(): Promise<string[]> {
    let names: string[];
    try {
      names = (await fs.promises.readdir(this.projectsRoot, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return [];
    }
    const wanted = new Set(this.workspaceFolders.map(encodeProjectPath));
    const wantedLower = new Set([...wanted].map((w) => w.toLowerCase()));
    const result: string[] = [];
    for (const name of names) {
      const dir = path.join(this.projectsRoot, name);
      if (wanted.has(name) || (process.platform === 'win32' && wantedLower.has(name.toLowerCase()))) {
        result.push(dir);
        continue;
      }
      // Cheap pre-filter: the encoded name of a sub-folder starts with the encoded workspace name.
      const prefixMatch = [...wanted].some((w) => name.toLowerCase().startsWith(w.toLowerCase() + '-'));
      const longName = name.length >= 200;
      if (!prefixMatch && !longName) {
        continue;
      }
      let cwd = this.cwdCache.get(dir);
      if (cwd === undefined) {
        const newest = await this.newestTranscript(dir);
        if (!newest) {
          continue;
        }
        cwd = (await peekSession(newest, 64 * 1024)).cwd;
        if (!cwd) {
          continue;
        }
        this.cwdCache.set(dir, cwd);
      }
      if (this.workspaceFolders.some((ws) => samePath(cwd!, ws) || isInside(cwd!, ws))) {
        result.push(dir);
      }
    }
    return result;
  }

  private async newestTranscript(dir: string): Promise<string | undefined> {
    const list = await listTranscripts(dir);
    list.sort((a, b) => b.mtime - a.mtime);
    return list[0]?.file;
  }

  /** Sessions for the workspace, newest first. With `all`, every project on this machine. */
  async listSessions(all = false): Promise<SessionSummary[]> {
    let dirs: string[];
    if (all) {
      try {
        dirs = (await fs.promises.readdir(this.projectsRoot, { withFileTypes: true }))
          .filter((d) => d.isDirectory())
          .map((d) => path.join(this.projectsRoot, d.name));
      } catch {
        dirs = [];
      }
    } else {
      dirs = await this.projectDirs();
    }
    const out: SessionSummary[] = [];
    for (const dir of dirs) {
      for (const t of await listTranscripts(dir)) {
        out.push({ id: path.basename(t.file, '.jsonl'), file: t.file, dir, mtime: t.mtime, size: t.size });
      }
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
  }
}

/** Main-session transcripts in a project folder (subagent files excluded). */
export async function listTranscripts(dir: string): Promise<{ file: string; mtime: number; size: number }[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: { file: string; mtime: number; size: number }[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl') || e.name.startsWith('agent-')) {
      continue;
    }
    const file = path.join(dir, e.name);
    try {
      const st = await fs.promises.stat(file);
      if (st.size > 0) {
        out.push({ file, mtime: st.mtimeMs, size: st.size });
      }
    } catch {
      /* file vanished */
    }
  }
  return out;
}

/**
 * Subagent transcripts for a session. Newer Claude Code writes them to
 * `<project>/<sessionId>/subagents/agent-*.jsonl`; older builds wrote
 * `<project>/agent-*.jsonl` with the parent sessionId inside.
 */
export class SubagentFinder {
  private readonly ownerCache = new Map<string, string | null>();

  async find(sessionFile: string, sessionId: string): Promise<string[]> {
    const dir = path.dirname(sessionFile);
    const out: string[] = [];
    const nested = path.join(dir, path.basename(sessionFile, '.jsonl'), 'subagents');
    try {
      for (const name of await fs.promises.readdir(nested)) {
        if (name.endsWith('.jsonl')) {
          out.push(path.join(nested, name));
        }
      }
    } catch {
      /* none */
    }
    try {
      for (const name of await fs.promises.readdir(dir)) {
        if (!name.startsWith('agent-') || !name.endsWith('.jsonl')) {
          continue;
        }
        const file = path.join(dir, name);
        let owner = this.ownerCache.get(file);
        if (owner === undefined) {
          owner = (await peekSession(file, 16 * 1024)).sessionId ?? null;
          if (owner) {
            this.ownerCache.set(file, owner);
          }
        }
        if (owner === sessionId) {
          out.push(file);
        }
      }
    } catch {
      /* none */
    }
    return out;
  }
}
