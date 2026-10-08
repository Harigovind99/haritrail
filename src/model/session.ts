import * as path from 'path';
import {
  countLineChanges,
  describeTool,
  guessTestOutcome,
  isPatchHunks,
  oneLine,
  rangesFromPatch,
  verbFor,
} from './describe';
import { EditPiece, Expedition, Step } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Rec = Record<string, any>;

const MAX_PREVIEW = 4000;
const MAX_OUTPUT = 200_000;
const MAX_ORIGINAL = 1_500_000;
/** After this long with no activity, an unfinished prompt is treated as finished. */
const STALE_MS = 10 * 60 * 1000;

interface SubagentTrack {
  key: string;
  firstAt: number;
  steps: Step[];
  narration: string;
  thinking: string;
  parent?: Step;
  /** agentId found inside the records (newer Claude Code writes it on every line). */
  agentId?: string;
}

function ts(rec: Rec): number {
  const t = Date.parse(rec.timestamp ?? '');
  return Number.isFinite(t) ? t : Date.now();
}

/**
 * Tags Claude Code wraps around context it adds to a message (reminders, editor
 * selection, open file, hook output). Claude Code hides these when it shows a
 * prompt, so HariTrail does the same.
 */
const CONTEXT_TAGS = [
  'system-reminder',
  'system_reminder',
  'user-memory-input',
  'ide_selection',
  'ide_opened_file',
  'ide_diagnostics',
  'terminal',
  'browser',
  'browser_instruction',
  'post-tool-use-hook',
  'user-prompt-submit-hook',
  'total_tokens',
  'tick',
];
const CONTEXT_RE = new RegExp(`<(${CONTEXT_TAGS.join('|')})(\\s[^>]*)?>[\\s\\S]*?<\\/\\1>`, 'g');

/** Messages Claude Code writes on its own (background task finished, other agents, channels). */
const NOT_TYPED_RE =
  /^<(task-notification|teammate-message|cross-session-message|agent-message|channel|remote-review|remote-review-progress|slack-ping|slack-tag-message|fetched-web-content|coordinator-relay|mcp-resource-update|mcp-polling-update|fork-boilerplate)[\s>]/;

function stripReminders(text: string): string {
  return text.replace(CONTEXT_RE, '').trim();
}

/**
 * Same rule Claude Code uses to decide a message was typed by a person: no origin
 * recorded (older versions), or an origin of kind "human".
 */
export function typedByPerson(origin: unknown): boolean {
  if (origin === undefined || origin === null) {
    return true;
  }
  return typeof origin === 'object' && (origin as Rec).kind === 'human';
}

/** Where a prompt was sent from, from the transcript's `entrypoint` field. */
export function sourceLabel(entrypoint: unknown): string | undefined {
  if (typeof entrypoint !== 'string' || !entrypoint) {
    return undefined;
  }
  if (entrypoint === 'cli') {
    return 'terminal';
  }
  if (entrypoint.includes('vscode')) {
    return 'VS Code chat panel';
  }
  if (entrypoint.includes('desktop')) {
    return 'Claude desktop app';
  }
  if (entrypoint.includes('jetbrains') || entrypoint.includes('intellij')) {
    return 'JetBrains IDE';
  }
  if (entrypoint.startsWith('sdk')) {
    return 'Agent SDK';
  }
  return entrypoint;
}

function blockText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((b: Rec) => {
        if (!b || typeof b !== 'object') {
          return '';
        }
        if (b.type === 'text' && typeof b.text === 'string') {
          return b.text;
        }
        if (b.type === 'image') {
          return '[image]';
        }
        if (b.type === 'tool_reference') {
          return `[tool: ${b.tool_name ?? ''}]`;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * Turns the raw text of a user turn into the prompt people actually typed.
 * Returns undefined for transcript plumbing that is not a real prompt.
 */
export function cleanPrompt(raw: string): { kind: 'prompt' | 'interrupt' | 'skip'; text: string } {
  const text = stripReminders(raw);
  if (!text) {
    return { kind: 'skip', text: '' };
  }
  if (/^\[Request interrupted by user/.test(text)) {
    return { kind: 'interrupt', text };
  }
  if (NOT_TYPED_RE.test(text)) {
    return { kind: 'skip', text: '' };
  }
  if (/^<local-command-(stdout|stderr|caveat)>/.test(text) || /^Caveat: The messages below were generated/.test(text)) {
    return { kind: 'skip', text: '' };
  }
  const cmd = /<command-name>([\s\S]*?)<\/command-name>/.exec(text);
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
    const name = cmd[1].trim();
    return { kind: 'prompt', text: args ? `${name.startsWith('/') ? name : '/' + name} ${args}` : name.startsWith('/') ? name : '/' + name };
  }
  if (/^<(bash-input|bash-stdout|bash-stderr)>/.test(text)) {
    const input = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(text)?.[1];
    return input ? { kind: 'prompt', text: `! ${input.trim()}` } : { kind: 'skip', text: '' };
  }
  return { kind: 'prompt', text };
}

/**
 * Incrementally builds the story of a Claude Code session from transcript records.
 * Feed it records in file order with `ingest`; it is safe to feed the same record twice.
 */
export class SessionModel {
  readonly expeditions: Expedition[] = [];
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  title?: string;
  version?: string;
  /** Bumps on every change so views can cheaply skip identical renders. */
  revision = 0;

  private readonly seenUuids = new Set<string>();
  private readonly steps = new Map<string, Step>();
  private narration = '';
  private thinking = '';
  private readonly msgTokens = new Map<string, { exp: Expedition; tokens: number }>();
  private readonly subagents = new Map<string, SubagentTrack>();
  /** uuid -> subagent key, to follow sidechain chains written inline in the main transcript. */
  private readonly sidechainChain = new Map<string, string>();
  private readonly orphanResults = new Map<string, { rec: Rec; block: Rec }>();

  get current(): Expedition | undefined {
    return this.expeditions[this.expeditions.length - 1];
  }

  getStep(id: string): Step | undefined {
    return this.steps.get(id);
  }

  getExpedition(id: string): Expedition | undefined {
    return this.expeditions.find((e) => e.id === id);
  }

  /** All steps of an expedition in time order, subagent steps placed after the move that launched them. */
  flatSteps(exp: Expedition, includeSubagents = true): Step[] {
    if (!includeSubagents) {
      return exp.steps.slice();
    }
    const out: Step[] = [];
    const walk = (s: Step) => {
      out.push(s);
      for (const c of s.children) {
        walk(c);
      }
    };
    exp.steps.forEach(walk);
    return out;
  }

  isLive(exp: Expedition, now = Date.now()): boolean {
    return !exp.done && exp === this.current && now - exp.lastActivity < STALE_MS;
  }

  /** Feed records from the main transcript. */
  ingest(records: Rec[]): boolean {
    let changed = false;
    for (const rec of records) {
      if (!rec || typeof rec !== 'object') {
        continue;
      }
      if (rec.uuid) {
        if (this.seenUuids.has(rec.uuid)) {
          continue;
        }
        this.seenUuids.add(rec.uuid);
      }
      if (rec.isSidechain === true) {
        const key = this.sidechainKey(rec);
        changed = this.ingestAgentRecord(key, rec) || changed;
        continue;
      }
      changed = this.ingestMain(rec) || changed;
    }
    changed = this.resolveSubagents() || changed;
    if (changed) {
      this.revision++;
    }
    return changed;
  }

  /** Feed records from a separate subagent transcript file. */
  ingestSubagent(fileKey: string, records: Rec[]): boolean {
    let changed = false;
    for (const rec of records) {
      if (!rec || typeof rec !== 'object') {
        continue;
      }
      if (rec.uuid) {
        if (this.seenUuids.has(rec.uuid)) {
          continue;
        }
        this.seenUuids.add(rec.uuid);
      }
      changed = this.ingestAgentRecord(fileKey, rec) || changed;
    }
    changed = this.resolveSubagents() || changed;
    if (changed) {
      this.revision++;
    }
    return changed;
  }

  // ---------------------------------------------------------------- main agent

  private ingestMain(rec: Rec): boolean {
    const t = ts(rec);
    if (rec.sessionId && !this.sessionId) {
      this.sessionId = rec.sessionId;
    }
    if (typeof rec.cwd === 'string' && rec.cwd) {
      this.cwd = rec.cwd;
    }
    if (typeof rec.gitBranch === 'string' && rec.gitBranch) {
      this.gitBranch = rec.gitBranch;
    }
    if (typeof rec.version === 'string') {
      this.version = rec.version;
    }

    switch (rec.type) {
      case 'summary':
        if (typeof rec.summary === 'string') {
          this.title = rec.summary;
          return true;
        }
        return false;
      case 'custom-title':
        if (typeof rec.customTitle === 'string') {
          this.title = rec.customTitle;
          return true;
        }
        return false;
      case 'user':
        return this.onUser(rec, t);
      case 'assistant':
        return this.onAssistant(rec, t, undefined);
      case 'attachment':
        return this.onAttachment(rec, t);
      default:
        return false;
    }
  }

  private onAttachment(rec: Rec, t: number): boolean {
    const a = rec.attachment;
    if (!a || a.type !== 'queued_command') {
      return false;
    }
    if (a.isMeta === true || !typedByPerson(a.origin)) {
      return false;
    }
    const raw = typeof a.prompt === 'string' ? a.prompt : blockText(a.prompt);
    const cleaned = cleanPrompt(raw);
    const text = cleaned.kind === 'prompt' ? cleaned.text : '';
    const exp = this.current;
    if (!text || !exp) {
      return false;
    }
    exp.interjections.push({ at: Date.parse(a.timestamp ?? '') || t, text });
    exp.lastActivity = Math.max(exp.lastActivity, t);
    return true;
  }

  private onUser(rec: Rec, t: number): boolean {
    const msg = rec.message;
    if (!msg) {
      return false;
    }
    const content = msg.content;
    if (Array.isArray(content) && content.some((b: Rec) => b?.type === 'tool_result')) {
      let changed = false;
      const results = content.filter((b: Rec) => b?.type === 'tool_result');
      for (const block of results) {
        changed = this.onToolResult(block, rec, t, results.length === 1) || changed;
      }
      return changed;
    }
    if (rec.isMeta || rec.isCompactSummary || rec.isVisibleInTranscriptOnly) {
      return false;
    }
    const cleaned = cleanPrompt(blockText(content));
    if (cleaned.kind === 'skip') {
      return false;
    }
    // Background-task notices and other automatic messages continue the current
    // prompt instead of starting a new one.
    if (cleaned.kind === 'prompt' && !typedByPerson(rec.origin)) {
      return false;
    }
    if (cleaned.kind === 'interrupt') {
      const exp = this.current;
      if (exp && !exp.done) {
        this.closeExpedition(exp, t, true);
        return true;
      }
      return false;
    }
    this.startExpedition(rec, cleaned.text, t);
    return true;
  }

  private startExpedition(rec: Rec, prompt: string, t: number): void {
    const prev = this.current;
    if (prev && !prev.done) {
      this.closeExpedition(prev, prev.lastActivity, false);
    }
    const exp: Expedition = {
      id: String(rec.promptId ?? rec.uuid ?? `p${this.expeditions.length + 1}`) + `#${this.expeditions.length + 1}`,
      index: this.expeditions.length + 1,
      prompt,
      startedAt: t,
      lastActivity: t,
      steps: [],
      done: false,
      interrupted: false,
      interjections: [],
      outputTokens: 0,
      source: sourceLabel(rec.entrypoint),
    };
    this.expeditions.push(exp);
    this.narration = '';
    this.thinking = '';
    if (!this.title) {
      this.title = oneLine(prompt, 80);
    }
  }

  private closeExpedition(exp: Expedition, t: number, interrupted: boolean): void {
    exp.done = true;
    exp.interrupted = exp.interrupted || interrupted;
    exp.endedAt = Math.max(t, exp.lastActivity);
    const mark = (s: Step) => {
      if (s.status === 'running') {
        s.status = 'interrupted';
        s.endedAt = exp.endedAt;
      }
      s.children.forEach(mark);
    };
    exp.steps.forEach(mark);
  }

  /** Expedition that new assistant output belongs to; creates a placeholder if the transcript starts mid-way. */
  private ensureExpedition(rec: Rec, t: number): Expedition {
    let exp = this.current;
    if (!exp) {
      this.startExpedition(rec, '(conversation started before this transcript)', t);
      exp = this.current!;
    }
    return exp;
  }

  private onAssistant(rec: Rec, t: number, sub: SubagentTrack | undefined): boolean {
    const msg = rec.message;
    if (!msg || !Array.isArray(msg.content)) {
      return false;
    }
    if (msg.model === '<synthetic>') {
      // Claude Code writes synthetic assistant lines for API errors / interruptions.
      const text = blockText(msg.content);
      if (!sub && text && this.current) {
        this.current.finalText = text;
        this.current.lastActivity = t;
        return true;
      }
      return false;
    }
    const exp = sub ? undefined : this.ensureExpedition(rec, t);
    let changed = false;
    if (exp) {
      exp.lastActivity = Math.max(exp.lastActivity, t);
      if (typeof msg.model === 'string') {
        exp.model = msg.model;
      }
      const out = msg.usage?.output_tokens;
      if (typeof out === 'number' && typeof msg.id === 'string') {
        const prev = this.msgTokens.get(msg.id);
        if (!prev || out > prev.tokens) {
          exp.outputTokens += out - (prev && prev.exp === exp ? prev.tokens : 0);
          this.msgTokens.set(msg.id, { exp, tokens: out });
        }
      }
    }
    let hadToolUse = false;
    for (const block of msg.content as Rec[]) {
      if (!block || typeof block !== 'object') {
        continue;
      }
      if (block.type === 'text' && typeof block.text === 'string') {
        const text = block.text.trim();
        if (text) {
          if (sub) {
            sub.narration = sub.narration ? sub.narration + '\n\n' + text : text;
          } else {
            this.narration = this.narration ? this.narration + '\n\n' + text : text;
            exp!.finalText = text;
          }
          changed = true;
        }
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        const text = block.thinking.trim();
        if (text) {
          if (sub) {
            sub.thinking = sub.thinking ? sub.thinking + '\n' + text : text;
          } else {
            this.thinking = this.thinking ? this.thinking + '\n' + text : text;
          }
        }
      } else if (block.type === 'tool_use' && typeof block.id === 'string') {
        hadToolUse = true;
        if (this.steps.has(block.id)) {
          continue;
        }
        const step = this.createStep(block, rec, t, sub, exp);
        this.steps.set(step.id, step);
        const orphan = this.orphanResults.get(step.id);
        if (orphan) {
          this.orphanResults.delete(step.id);
          this.applyResult(step, orphan.block, orphan.rec, ts(orphan.rec), true);
        }
        changed = true;
      }
    }
    if (exp && !hadToolUse && (msg.stop_reason === 'end_turn' || msg.stop_reason === 'stop_sequence')) {
      const running = exp.steps.some((s) => s.status === 'running');
      if (!running) {
        exp.done = true;
        exp.endedAt = t;
        changed = true;
      }
    }
    return changed;
  }

  private createStep(block: Rec, rec: Rec, t: number, sub: SubagentTrack | undefined, exp: Expedition | undefined): Step {
    const input: Record<string, unknown> = block.input && typeof block.input === 'object' ? block.input : {};
    const cwd = typeof rec.cwd === 'string' ? rec.cwd : this.cwd;
    const d = describeTool(String(block.name ?? 'tool'), input, cwd);
    const step: Step = {
      id: block.id,
      label: '',
      seq: 0,
      tool: String(block.name ?? 'tool'),
      kind: d.kind,
      verb: d.verb,
      title: d.title,
      filePath: d.filePath,
      readRange: d.readRange,
      input,
      startedAt: t,
      status: 'running',
      children: [],
      expeditionId: '',
    };
    // Edits we can describe before the result arrives.
    if (step.tool === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
      step.edits = [{ oldText: input.old_string, newText: input.new_string, replaceAll: input.replace_all === true }];
    } else if (step.tool === 'MultiEdit' && Array.isArray(input.edits)) {
      step.edits = (input.edits as Rec[])
        .filter((e) => typeof e?.old_string === 'string' && typeof e?.new_string === 'string')
        .map((e) => ({ oldText: e.old_string, newText: e.new_string, replaceAll: e.replace_all === true }));
    } else if (step.tool === 'Write' && typeof input.content === 'string') {
      step.writtenContent = input.content;
    }
    if (step.edits) {
      let added = 0;
      let removed = 0;
      for (const e of step.edits) {
        const c = countLineChanges(e.oldText, e.newText);
        added += c.added;
        removed += c.removed;
      }
      step.added = added;
      step.removed = removed;
    } else if (step.writtenContent !== undefined) {
      step.added = step.writtenContent.length ? step.writtenContent.split('\n').length : 0;
      step.removed = 0;
    }

    if (sub) {
      step.agentKey = sub.key;
      step.narration = sub.narration || undefined;
      step.thinking = sub.thinking || undefined;
      sub.narration = '';
      sub.thinking = '';
      sub.steps.push(step);
      if (sub.parent) {
        this.attachToParent(step, sub.parent);
      }
      return step;
    }

    const e = exp!;
    // Text followed by a move was narration, not the answer.
    e.finalText = undefined;
    step.narration = this.narration || undefined;
    step.thinking = this.thinking || undefined;
    this.narration = '';
    this.thinking = '';
    step.seq = e.steps.length + 1;
    step.label = String(step.seq);
    step.expeditionId = e.id;
    this.markRevisit(step, e);
    e.steps.push(step);
    return step;
  }

  /** Flag returns to a file and changes that follow a failure (the "loops" of the journey). */
  private markRevisit(step: Step, exp: Expedition): void {
    const prior = exp.steps;
    if (step.filePath) {
      const key = fileKey(step.filePath);
      const prev = prior[prior.length - 1];
      const firstIdx = prior.findIndex((s) => s.filePath && fileKey(s.filePath) === key);
      if (firstIdx >= 0 && !(prev && prev.filePath && fileKey(prev.filePath) === key)) {
        step.revisitOf = prior[firstIdx].label;
      }
    }
    if (step.kind === 'edit' || step.kind === 'create') {
      for (let i = prior.length - 1; i >= 0; i--) {
        const s = prior[i];
        if (isCheckKind(s.kind)) {
          step.afterFailure = s.status === 'error' || s.outcome === 'fail';
          break;
        }
        if (s.kind === 'edit' || s.kind === 'create') {
          break;
        }
      }
    }
  }

  private onToolResult(block: Rec, rec: Rec, t: number, single: boolean): boolean {
    const id = block.tool_use_id;
    if (typeof id !== 'string') {
      return false;
    }
    const step = this.steps.get(id);
    if (!step) {
      // Result arrived before we saw the call (e.g. subagent file read later). Keep it for later.
      this.orphanResults.set(id, { rec, block });
      return false;
    }
    this.applyResult(step, block, rec, t, single);
    return true;
  }

  private applyResult(step: Step, block: Rec, rec: Rec, t: number, single: boolean): void {
    const text = blockText(block.content);
    const isError = block.is_error === true;
    step.endedAt = t;
    step.status = isError ? (/interrupted|rejected|doesn't want to proceed/i.test(text) ? 'interrupted' : 'error') : 'ok';
    step.resultPreview = text.length > MAX_PREVIEW ? text.slice(0, MAX_PREVIEW) + '\n...' : text;

    const tur: Rec | undefined = single && rec.toolUseResult && typeof rec.toolUseResult === 'object' ? rec.toolUseResult : undefined;

    if (['run', 'test', 'build', 'git', 'install'].includes(step.kind)) {
      let out = text;
      if (tur && (typeof tur.stdout === 'string' || typeof tur.stderr === 'string')) {
        out = [tur.stdout, tur.stderr].filter((x) => typeof x === 'string' && x.length).join('\n');
        if (tur.interrupted === true) {
          step.status = 'interrupted';
        }
      }
      step.fullOutput = out.length > MAX_OUTPUT ? out.slice(-MAX_OUTPUT) : out;
      if (step.kind === 'test') {
        step.outcome = guessTestOutcome(out, isError);
      }
    }

    if (tur) {
      if (step.tool === 'Write' && (tur.type === 'update' || tur.type === 'create')) {
        if (tur.type === 'update') {
          step.kind = 'edit';
          step.verb = 'Rewrote';
        }
      }
      if (typeof tur.originalFile === 'string' && tur.originalFile.length <= MAX_ORIGINAL) {
        step.originalFile = tur.originalFile;
      }
      if (isPatchHunks(tur.structuredPatch) && tur.structuredPatch.length) {
        const r = rangesFromPatch(tur.structuredPatch);
        step.ranges = r.ranges;
        step.added = r.added;
        step.removed = r.removed;
      }
      if (step.kind === 'delegate' && typeof tur.agentId === 'string') {
        step.agentId = tur.agentId;
      }
      if (step.tool === 'Read' && tur.file && typeof tur.file === 'object' && !step.readRange) {
        const f = tur.file as Rec;
        if (typeof f.startLine === 'number' && typeof f.numLines === 'number' && typeof f.totalLines === 'number') {
          if (f.numLines < f.totalLines) {
            step.readRange = { start: f.startLine, end: f.startLine + Math.max(1, f.numLines) - 1 };
          }
        }
      }
    }

    const exp = step.expeditionId ? this.getExpedition(step.expeditionId) : undefined;
    if (exp) {
      exp.lastActivity = Math.max(exp.lastActivity, t);
    }
  }

  // ---------------------------------------------------------------- subagents

  private sidechainKey(rec: Rec): string {
    if (typeof rec.agentId === 'string' && rec.agentId) {
      return 'agent:' + rec.agentId;
    }
    const parent = typeof rec.parentUuid === 'string' ? this.sidechainChain.get(rec.parentUuid) : undefined;
    const key = parent ?? 'chain:' + (rec.uuid ?? Math.random().toString(36).slice(2));
    if (rec.uuid) {
      this.sidechainChain.set(rec.uuid, key);
    }
    return key;
  }

  private track(key: string, t: number): SubagentTrack {
    let tr = this.subagents.get(key);
    if (!tr) {
      tr = { key, firstAt: t, steps: [], narration: '', thinking: '' };
      this.subagents.set(key, tr);
    }
    return tr;
  }

  private ingestAgentRecord(key: string, rec: Rec): boolean {
    const t = ts(rec);
    const tr = this.track(key, t);
    if (typeof rec.agentId === 'string') {
      tr.agentId = rec.agentId;
    }
    if (rec.type === 'assistant') {
      return this.onAssistant(rec, t, tr);
    }
    if (rec.type === 'user') {
      const content = rec.message?.content;
      if (Array.isArray(content)) {
        let changed = false;
        const results = content.filter((b: Rec) => b?.type === 'tool_result');
        for (const block of results) {
          changed = this.onToolResult(block, rec, t, results.length === 1) || changed;
        }
        return changed;
      }
    }
    return false;
  }

  private attachToParent(step: Step, parent: Step): void {
    step.parentStepId = parent.id;
    step.expeditionId = parent.expeditionId;
    step.seq = parent.seq;
    parent.children.push(step);
    step.label = `${parent.label}.${parent.children.length}`;
  }

  /** Match each subagent transcript to the Task/Agent step that launched it. */
  private resolveSubagents(): boolean {
    let changed = false;
    const claimed = new Set<string>();
    for (const tr of this.subagents.values()) {
      if (tr.parent) {
        claimed.add(tr.parent.id);
      }
    }
    for (const tr of this.subagents.values()) {
      if (tr.parent || tr.steps.length === 0) {
        continue;
      }
      const delegates = this.expeditions.flatMap((e) => e.steps.filter((s) => s.kind === 'delegate'));
      let parent: Step | undefined;
      const agentId = tr.agentId ?? (tr.key.startsWith('agent:') ? tr.key.slice(6) : tr.key.startsWith('file:') ? tr.key.replace(/^.*agent-/, '').replace(/\.jsonl$/, '') : undefined);
      if (agentId) {
        parent = delegates.find((d) => d.agentId === agentId);
      }
      if (!parent) {
        const candidates = delegates.filter(
          (d) => !claimed.has(d.id) && d.startedAt <= tr.firstAt + 5000 && (d.endedAt === undefined || d.endedAt >= tr.firstAt - 1000),
        );
        candidates.sort((a, b) => b.startedAt - a.startedAt);
        parent = candidates[0];
      }
      if (!parent) {
        continue;
      }
      tr.parent = parent;
      claimed.add(parent.id);
      for (const s of tr.steps) {
        this.attachToParent(s, parent);
      }
      changed = true;
    }
    return changed;
  }
}

export function fileKey(p: string): string {
  const n = path.normalize(p);
  return process.platform === 'win32' || /^[a-zA-Z]:\\/.test(n) ? n.toLowerCase() : n;
}

export function isCheckKind(kind: Step['kind']): boolean {
  return kind === 'run' || kind === 'test' || kind === 'build';
}

export { verbFor };
export type { EditPiece };
