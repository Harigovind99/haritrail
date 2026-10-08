import * as path from 'path';
import { fileKey, isCheckKind, SessionModel } from './session';
import { Expedition, Step, StepKind } from './types';
import { oneLine } from './describe';

/** Where a step "lands" on the map: a file, or one of the fixed stations. */
export type StationId = 'terminal' | 'search' | 'web' | 'agents' | 'plan' | 'tools' | 'you';

export const STATIONS: Record<StationId, string> = {
  terminal: 'Terminal',
  search: 'Search',
  web: 'Web',
  agents: 'Subagents',
  plan: 'Plan',
  tools: 'Tools',
  you: 'You',
};

export function stationFor(kind: StepKind): StationId {
  switch (kind) {
    case 'run':
    case 'test':
    case 'build':
    case 'git':
    case 'install':
      return 'terminal';
    case 'search':
      return 'search';
    case 'web':
      return 'web';
    case 'delegate':
      return 'agents';
    case 'plan':
      return 'plan';
    case 'ask':
      return 'you';
    default:
      return 'tools';
  }
}

export type Phase = 'explore' | 'change' | 'verify' | 'other';

export function phaseOf(kind: StepKind): Phase {
  switch (kind) {
    case 'read':
    case 'search':
    case 'web':
      return 'explore';
    case 'edit':
    case 'create':
      return 'change';
    case 'run':
    case 'test':
    case 'build':
      return 'verify';
    default:
      return 'other';
  }
}

export interface ExpeditionStats {
  steps: number;
  subagentSteps: number;
  filesRead: number;
  filesEdited: number;
  filesCreated: number;
  commands: number;
  testsPassed: number;
  testsFailed: number;
  errors: number;
  loopBacks: number;
  revisits: number;
  linesAdded: number;
  linesRemoved: number;
  durationMs: number;
  outputTokens: number;
}

export interface FileTouch {
  path: string;
  key: string;
  reads: number;
  edits: number;
  created: boolean;
  added: number;
  removed: number;
  steps: Step[];
  firstAt: number;
}

/** Aggregate per-file activity for a set of steps. */
export function fileTouches(steps: Step[]): Map<string, FileTouch> {
  const map = new Map<string, FileTouch>();
  for (const s of steps) {
    if (!s.filePath) {
      continue;
    }
    const key = fileKey(s.filePath);
    let ft = map.get(key);
    if (!ft) {
      ft = { path: s.filePath, key, reads: 0, edits: 0, created: false, added: 0, removed: 0, steps: [], firstAt: s.startedAt };
      map.set(key, ft);
    }
    ft.steps.push(s);
    if (s.status === 'error' || s.status === 'interrupted') {
      continue;
    }
    if (s.kind === 'read') {
      ft.reads++;
    } else if (s.kind === 'create') {
      ft.created = true;
      ft.edits++;
      ft.added += s.added ?? 0;
    } else if (s.kind === 'edit') {
      ft.edits++;
      ft.added += s.added ?? 0;
      ft.removed += s.removed ?? 0;
    }
  }
  return map;
}

export function statsFor(model: SessionModel, exps: Expedition[]): ExpeditionStats {
  const st: ExpeditionStats = {
    steps: 0,
    subagentSteps: 0,
    filesRead: 0,
    filesEdited: 0,
    filesCreated: 0,
    commands: 0,
    testsPassed: 0,
    testsFailed: 0,
    errors: 0,
    loopBacks: 0,
    revisits: 0,
    linesAdded: 0,
    linesRemoved: 0,
    durationMs: 0,
    outputTokens: 0,
  };
  const all: Step[] = [];
  for (const e of exps) {
    const flat = model.flatSteps(e);
    all.push(...flat);
    st.steps += e.steps.length;
    st.subagentSteps += flat.length - e.steps.length;
    st.durationMs += Math.max(0, (e.endedAt ?? e.lastActivity) - e.startedAt);
    st.outputTokens += e.outputTokens;
  }
  for (const s of all) {
    if (['run', 'test', 'build', 'git', 'install'].includes(s.kind)) {
      st.commands++;
    }
    if (s.kind === 'test' && s.outcome) {
      if (s.outcome === 'pass') {
        st.testsPassed++;
      } else {
        st.testsFailed++;
      }
    }
    if (s.status === 'error') {
      st.errors++;
    }
    if (s.afterFailure) {
      st.loopBacks++;
    }
    if (s.revisitOf) {
      st.revisits++;
    }
  }
  for (const ft of fileTouches(all).values()) {
    if (ft.created) {
      st.filesCreated++;
    } else if (ft.edits > 0) {
      st.filesEdited++;
    } else if (ft.reads > 0) {
      st.filesRead++;
    }
    st.linesAdded += ft.added;
    st.linesRemoved += ft.removed;
  }
  return st;
}

export interface PhaseRun {
  phase: Phase;
  from: number; // index into flat step list
  to: number;
}

/** Collapse a step list into runs of Explore / Change / Verify ("other" joins its neighbour). */
export function phaseRuns(steps: Step[]): PhaseRun[] {
  const runs: PhaseRun[] = [];
  steps.forEach((s, i) => {
    let p = phaseOf(s.kind);
    if (p === 'other') {
      p = runs.length ? runs[runs.length - 1].phase : 'other';
    }
    const last = runs[runs.length - 1];
    if (last && last.phase === p) {
      last.to = i;
    } else {
      runs.push({ phase: p, from: i, to: i });
    }
  });
  // A leading "other" run takes the phase of what follows.
  if (runs.length > 1 && runs[0].phase === 'other') {
    runs[1].from = runs[0].from;
    runs.shift();
  }
  return runs;
}

export interface Insight {
  icon: string;
  text: string;
  stepIds: string[];
  tone: 'info' | 'warn' | 'good';
}

/** Plain-language observations about how the agent worked through the prompt. */
export function insightsFor(steps: Step[], rel: (p: string) => string): Insight[] {
  const out: Insight[] = [];
  if (!steps.length) {
    return out;
  }
  const firstChange = steps.findIndex((s) => s.kind === 'edit' || s.kind === 'create');
  if (firstChange > 0) {
    const explored = steps.slice(0, firstChange).filter((s) => phaseOf(s.kind) === 'explore');
    const files = new Set(explored.filter((s) => s.filePath).map((s) => fileKey(s.filePath!)));
    if (explored.length) {
      out.push({
        icon: 'compass',
        tone: 'info',
        text: `Scouted first: ${explored.length} look${explored.length === 1 ? '' : 's'} (${files.size} file${files.size === 1 ? '' : 's'}) before the first change at #${steps[firstChange].label}.`,
        stepIds: explored.map((s) => s.id),
      });
    }
  } else if (firstChange === 0) {
    out.push({ icon: 'zap', tone: 'info', text: 'Went straight to changing code without reading first.', stepIds: [steps[0].id] });
  }

  // Fix loops: change -> failing check -> change again (same file).
  const loopsByFile = new Map<string, Step[]>();
  for (const s of steps) {
    if (s.afterFailure && s.filePath) {
      const k = fileKey(s.filePath);
      loopsByFile.set(k, [...(loopsByFile.get(k) ?? []), s]);
    }
  }
  for (const [, list] of loopsByFile) {
    out.push({
      icon: 'sync',
      tone: 'warn',
      text: `Fix loop on ${rel(list[0].filePath!)}: came back ${list.length}× after a failing check (${list.map((s) => '#' + s.label).join(', ')}).`,
      stepIds: list.map((s) => s.id),
    });
  }

  // Test trend.
  const tests = steps.filter((s) => s.kind === 'test' && s.outcome);
  if (tests.length) {
    const trend = tests.map((s) => (s.outcome === 'pass' ? '✓' : '✗')).join(' ');
    const last = tests[tests.length - 1];
    out.push({
      icon: last.outcome === 'pass' ? 'pass' : 'error',
      tone: last.outcome === 'pass' ? 'good' : 'warn',
      text: `Test runs: ${trend}${last.outcome === 'pass' ? ', ended green.' : ', last run still failing.'}`,
      stepIds: tests.map((s) => s.id),
    });
  } else if (steps.some((s) => s.kind === 'edit' || s.kind === 'create')) {
    const checks = steps.filter((s) => isCheckKind(s.kind));
    if (!checks.length) {
      out.push({ icon: 'info', tone: 'info', text: 'Changed code without running any command to check it.', stepIds: [] });
    }
  }

  // Hotspots.
  const touches = [...fileTouches(steps).values()].filter((f) => f.steps.length >= 3).sort((a, b) => b.steps.length - a.steps.length);
  for (const f of touches.slice(0, 3)) {
    out.push({
      icon: 'flame',
      tone: 'info',
      text: `Hotspot: ${rel(f.path)} was visited ${f.steps.length}× (${f.reads} read, ${f.edits} change${f.edits === 1 ? '' : 's'}).`,
      stepIds: f.steps.map((s) => s.id),
    });
  }

  const delegates = steps.filter((s) => s.kind === 'delegate');
  if (delegates.length) {
    const subSteps = delegates.reduce((n, d) => n + d.children.length, 0);
    out.push({
      icon: 'organization',
      tone: 'info',
      text: `Handed work to ${delegates.length} subagent${delegates.length === 1 ? '' : 's'}${subSteps ? ` who made ${subSteps} move${subSteps === 1 ? '' : 's'}` : ''}.`,
      stepIds: delegates.map((s) => s.id),
    });
  }

  const errors = steps.filter((s) => s.status === 'error' && s.kind !== 'test');
  if (errors.length) {
    out.push({
      icon: 'warning',
      tone: 'warn',
      text: `${errors.length} move${errors.length === 1 ? '' : 's'} hit an error and Claude adjusted course.`,
      stepIds: errors.map((s) => s.id),
    });
  }
  return out;
}

// ------------------------------------------------------------------ webview payload

export interface TrailNode {
  id: string;
  kind: 'file' | 'station';
  label: string;
  /** Workspace-relative path for files, station name otherwise. */
  path: string;
  group: string;
  status: 'created' | 'edited' | 'read' | 'touched' | 'station';
  visits: number;
  firstIndex: number;
}

export interface TrailStep {
  id: string;
  label: string;
  index: number;
  node: string;
  kind: StepKind;
  verb: string;
  title: string;
  tool: string;
  status: Step['status'];
  outcome?: 'pass' | 'fail';
  phase: Phase;
  narration?: string;
  thinking?: string;
  detail?: string;
  result?: string;
  added?: number;
  removed?: number;
  startedAt: number;
  endedAt?: number;
  revisitOf?: string;
  afterFailure?: boolean;
  sub: boolean;
  hasFile: boolean;
  canDiff: boolean;
  expeditionIndex: number;
}

export interface TrailPayload {
  sessionTitle: string;
  scope: string;
  expeditions: { id: string; index: number; prompt: string; live: boolean; steps: number }[];
  prompt?: string;
  /** Where the prompt was sent from (terminal, VS Code chat panel...). */
  source?: string;
  live: boolean;
  nodes: TrailNode[];
  steps: TrailStep[];
  phases: PhaseRun[];
  insights: Insight[];
  stats: ExpeditionStats;
  interjections: { at: number; text: string }[];
  finalText?: string;
  generatedAt: number;
}

function detailFor(s: Step): string | undefined {
  const i = s.input as Record<string, unknown>;
  const pick = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : undefined);
  switch (s.tool) {
    case 'Bash':
    case 'PowerShell':
      return pick('command');
    case 'Grep':
      return [pick('pattern') && `pattern: ${pick('pattern')}`, pick('path') && `path: ${pick('path')}`, pick('glob') && `glob: ${pick('glob')}`]
        .filter(Boolean)
        .join('\n');
    case 'Glob':
      return [pick('pattern'), pick('path')].filter(Boolean).join('  in  ');
    case 'Task':
    case 'Agent':
      return pick('prompt')?.slice(0, 1500);
    case 'WebFetch':
      return pick('url');
    case 'WebSearch':
      return pick('query');
    case 'TodoWrite': {
      const todos = Array.isArray(i.todos) ? (i.todos as { content?: string; status?: string }[]) : [];
      return todos.map((t) => `${t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]'} ${t.content ?? ''}`).join('\n');
    }
    default:
      if (s.edits && s.edits.length) {
        return s.edits
          .slice(0, 3)
          .map((e) => `- ${oneLine(e.oldText, 160)}\n+ ${oneLine(e.newText, 160)}`)
          .join('\n');
      }
      return undefined;
  }
}

export function buildTrailPayload(
  model: SessionModel,
  scope: string,
  rel: (p: string) => string,
  groupOf: (p: string) => string,
): TrailPayload {
  const exps = scope === 'session' ? model.expeditions : [model.getExpedition(scope) ?? model.current].filter((e): e is Expedition => !!e);
  const flat: { step: Step; exp: Expedition }[] = [];
  for (const e of exps) {
    for (const s of model.flatSteps(e)) {
      flat.push({ step: s, exp: e });
    }
  }
  const nodes = new Map<string, TrailNode>();
  const touches = fileTouches(flat.map((f) => f.step));
  const steps: TrailStep[] = flat.map(({ step: s, exp }, index) => {
    let nodeId: string;
    if (s.filePath) {
      const key = fileKey(s.filePath);
      nodeId = 'file:' + key;
      if (!nodes.has(nodeId)) {
        const ft = touches.get(key);
        nodes.set(nodeId, {
          id: nodeId,
          kind: 'file',
          label: path.basename(s.filePath),
          path: rel(s.filePath),
          group: groupOf(s.filePath),
          status: ft?.created ? 'created' : ft && ft.edits > 0 ? 'edited' : ft && ft.reads > 0 ? 'read' : 'touched',
          visits: 0,
          firstIndex: index,
        });
      }
    } else {
      const st = stationFor(s.kind);
      nodeId = 'station:' + st;
      if (!nodes.has(nodeId)) {
        nodes.set(nodeId, { id: nodeId, kind: 'station', label: STATIONS[st], path: STATIONS[st], group: '', status: 'station', visits: 0, firstIndex: index });
      }
    }
    nodes.get(nodeId)!.visits++;
    const canDiff = !!(s.edits?.length || s.writtenContent !== undefined);
    return {
      id: s.id,
      label: s.label,
      index,
      node: nodeId,
      kind: s.kind,
      verb: s.verb,
      title: s.filePath ? rel(s.filePath) : s.title,
      tool: s.tool,
      status: s.status,
      outcome: s.outcome,
      phase: phaseOf(s.kind),
      narration: s.narration?.slice(0, 2000),
      thinking: s.thinking?.slice(0, 2000),
      detail: detailFor(s),
      result: (s.fullOutput ?? s.resultPreview)?.slice(-1500),
      added: s.added,
      removed: s.removed,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      revisitOf: s.revisitOf,
      afterFailure: s.afterFailure,
      sub: !!s.parentStepId,
      hasFile: !!s.filePath,
      canDiff,
      expeditionIndex: exp.index,
    };
  });
  const flatSteps = flat.map((f) => f.step);
  const single = exps.length === 1 ? exps[0] : undefined;
  return {
    sessionTitle: model.title ?? 'Claude Code session',
    scope: scope === 'session' ? 'session' : single?.id ?? '',
    expeditions: model.expeditions.map((e) => ({
      id: e.id,
      index: e.index,
      prompt: oneLine(e.prompt, 90),
      live: model.isLive(e),
      steps: e.steps.length,
    })),
    prompt: single?.prompt,
    source: single?.source,
    live: exps.some((e) => model.isLive(e)),
    nodes: [...nodes.values()],
    steps,
    phases: phaseRuns(flatSteps),
    insights: insightsFor(flatSteps, rel),
    stats: statsFor(model, exps),
    interjections: exps.flatMap((e) => e.interjections),
    finalText: single?.done && !single.interrupted ? single.finalText?.slice(0, 4000) : undefined,
    generatedAt: Date.now(),
  };
}
