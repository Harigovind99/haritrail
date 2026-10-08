/**
 * Core data model for HariTrail.
 *
 * Everything in src/model is deliberately free of any `vscode` import so it can be
 * unit-tested in plain Node and reused later for other agents (Codex, Copilot, ...).
 */

/** What kind of move the agent made. Drives icons, colors and phase detection. */
export type StepKind =
  | 'read'
  | 'edit'
  | 'create'
  | 'search'
  | 'run'
  | 'test'
  | 'build'
  | 'git'
  | 'install'
  | 'delegate'
  | 'web'
  | 'plan'
  | 'mcp'
  | 'ask'
  | 'skill'
  | 'other';

export type StepStatus = 'running' | 'ok' | 'error' | 'interrupted';

/** 1-based, inclusive line range in the file *after* the change. */
export interface LineRange {
  start: number;
  end: number;
  /** true when the hunk only removed lines; the range marks where they used to be. */
  deletionOnly?: boolean;
}

/** One concrete edit Claude made, kept so we can rebuild diffs and locate ink marks. */
export interface EditPiece {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

export interface Step {
  /** tool_use id from the transcript, globally unique. */
  id: string;
  /** Position label shown to people: "7" for main agent, "7.3" for a subagent's 3rd move. */
  label: string;
  /** Numeric order inside its expedition (main-agent steps only; subagent steps reuse parent seq). */
  seq: number;
  tool: string;
  kind: StepKind;
  /** Past-tense verb for display, e.g. "Read", "Edited", "Ran". */
  verb: string;
  /** Short target text: file base name, command, pattern... */
  title: string;
  /** Absolute path when the step targets a file. */
  filePath?: string;
  /** Raw tool input (kept for tooltips / details). */
  input: Record<string, unknown>;
  /** What Claude said right before this move ("I'll check how auth is wired..."). */
  narration?: string;
  /** Claude's visible thinking summary right before this move, when the transcript has it. */
  thinking?: string;
  startedAt: number;
  endedAt?: number;
  status: StepStatus;
  /** For test runs: did the output look like a pass or a fail? */
  outcome?: 'pass' | 'fail';
  resultPreview?: string;
  /** Larger output kept for run-type steps so "Show Output" can display it. */
  fullOutput?: string;
  added?: number;
  removed?: number;
  /** Changed line ranges (new-file coordinates) from the structured patch, if known. */
  ranges?: LineRange[];
  /** Lines that were read, if the Read was partial. */
  readRange?: LineRange;
  /** Edit pieces in order (Edit / MultiEdit / Write). */
  edits?: EditPiece[];
  /** Full file contents before the change, when the transcript recorded it. */
  originalFile?: string;
  /** For Write: full new content. */
  writtenContent?: string;
  /** Set when this file was visited earlier in the same expedition with other moves in between. */
  revisitOf?: string;
  /** Set when this change came right after a failed command or test (a "loop back"). */
  afterFailure?: boolean;
  /** Steps done by a subagent this step launched (Task / Agent tool). */
  children: Step[];
  parentStepId?: string;
  /** Present on steps made by a subagent. */
  agentKey?: string;
  /** Subagent id reported in the delegate step's result (newer Claude Code versions). */
  agentId?: string;
  expeditionId: string;
}

/** A message the person typed while Claude was already working (steering mid-turn). */
export interface Interjection {
  at: number;
  text: string;
}

/** One prompt and everything Claude did to answer it. */
export interface Expedition {
  id: string;
  /** 1-based index in the session. */
  index: number;
  prompt: string;
  startedAt: number;
  lastActivity: number;
  endedAt?: number;
  steps: Step[];
  /** True once Claude finished its answer (or the person moved on / interrupted). */
  done: boolean;
  interrupted: boolean;
  finalText?: string;
  interjections: Interjection[];
  model?: string;
  outputTokens: number;
  /** Where the prompt was sent from: terminal, VS Code chat panel, desktop app... */
  source?: string;
}

export interface SessionSummary {
  id: string;
  file: string;
  dir: string;
  mtime: number;
  size: number;
  cwd?: string;
  firstPrompt?: string;
  source?: string;
}
