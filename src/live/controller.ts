import { EventEmitter } from 'events';
import * as path from 'path';
import { SessionModel } from '../model/session';
import { SessionSummary } from '../model/types';
import { listTranscripts, SessionLocator, SubagentFinder } from './locator';
import { JsonlTailer } from './tailer';

export interface ControllerOptions {
  home: string;
  workspaceFolders: string[];
  pollMs: number;
  log?: (msg: string) => void;
}

/**
 * Keeps a SessionModel in sync with Claude Code's transcript on disk.
 *
 * - "follow" mode (default) always shows the newest session for the workspace and
 *   switches automatically when a new `claude` session starts.
 * - "pinned" mode stays on a session the person picked.
 *
 * Emits 'change' (debounced) whenever the model changed and 'session' when the
 * followed session file switched.
 */
export class LiveController extends EventEmitter {
  model = new SessionModel();
  session?: SessionSummary;
  mode: 'follow' | 'pinned' = 'follow';

  private locator: SessionLocator;
  private readonly subFinder = new SubagentFinder();
  private tailer?: JsonlTailer;
  private readonly subTailers = new Map<string, JsonlTailer>();
  private timer?: NodeJS.Timeout;
  private ticks = 0;
  private disposed = false;
  private changeTimer?: NodeJS.Timeout;
  private projectDirs: string[] = [];
  private readonly knownFiles = new Set<string>();

  constructor(private opts: ControllerOptions) {
    super();
    this.locator = new SessionLocator(opts.home, opts.workspaceFolders);
  }

  get home(): string {
    return this.opts.home;
  }

  get locatorRef(): SessionLocator {
    return this.locator;
  }

  updateOptions(opts: Partial<ControllerOptions>): void {
    const needsRelocate = (opts.home && opts.home !== this.opts.home) || (opts.workspaceFolders && opts.workspaceFolders.join('|') !== this.opts.workspaceFolders.join('|'));
    this.opts = { ...this.opts, ...opts };
    if (needsRelocate) {
      this.locator = new SessionLocator(this.opts.home, this.opts.workspaceFolders);
      this.projectDirs = [];
      if (this.mode === 'follow') {
        void this.refreshSessionChoice(true);
      }
    }
  }

  start(): void {
    void this.loop();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    if (this.changeTimer) {
      clearTimeout(this.changeTimer);
    }
    this.removeAllListeners();
  }

  /** Switch to an explicit session file (pins it). */
  async pin(session: SessionSummary): Promise<void> {
    this.mode = 'pinned';
    await this.open(session);
  }

  async follow(): Promise<void> {
    this.mode = 'follow';
    await this.refreshSessionChoice(true);
  }

  /** Re-read the current session from scratch. */
  async reload(): Promise<void> {
    if (this.session) {
      await this.open(this.session);
    } else {
      await this.refreshSessionChoice(true);
    }
  }

  private async loop(): Promise<void> {
    if (this.disposed) {
      return;
    }
    try {
      // Look for a newer session every ~2s; tail the active one every tick.
      const every = Math.max(1, Math.round(2000 / this.opts.pollMs));
      if (this.mode === 'follow' && this.ticks % every === 0) {
        await this.refreshSessionChoice(false);
      }
      await this.pollActive();
      if (this.ticks % Math.max(1, Math.round(1500 / this.opts.pollMs)) === 0) {
        await this.discoverSubagents();
      }
    } catch (err) {
      this.opts.log?.(`poll error: ${(err as Error).message}`);
    }
    this.ticks++;
    if (!this.disposed) {
      this.timer = setTimeout(() => void this.loop(), this.opts.pollMs);
    }
  }

  private async refreshSessionChoice(force: boolean): Promise<void> {
    if (!this.projectDirs.length || force || this.ticks % 15 === 0) {
      this.projectDirs = await this.locator.projectDirs();
    }
    let newest: SessionSummary | undefined;
    let currentMtime = 0;
    const firstScan = this.knownFiles.size === 0;
    let brandNew: SessionSummary | undefined;
    for (const dir of this.projectDirs) {
      for (const t of await listTranscripts(dir)) {
        const s: SessionSummary = { id: path.basename(t.file, '.jsonl'), file: t.file, dir, mtime: t.mtime, size: t.size };
        if (!newest || t.mtime > newest.mtime) {
          newest = s;
        }
        if (this.session && t.file === this.session.file) {
          currentMtime = t.mtime;
        }
        if (!this.knownFiles.has(t.file)) {
          this.knownFiles.add(t.file);
          if (!firstScan && (!brandNew || t.mtime > brandNew.mtime)) {
            brandNew = s;
          }
        }
      }
    }
    // Two `claude` sessions running side by side would make "newest" flip back and forth.
    // Only jump when a brand-new session appears, or the current one has gone quiet.
    if (!force && this.session && newest && newest.file !== this.session.file) {
      if (brandNew) {
        newest = brandNew;
      } else if (Date.now() - currentMtime < 20_000) {
        return;
      }
    }
    if (!newest) {
      if (force && this.session) {
        this.session = undefined;
        this.model = new SessionModel();
        this.tailer = undefined;
        this.subTailers.clear();
        this.emit('session', undefined);
        this.scheduleChange(true);
      }
      return;
    }
    if (force || !this.session || newest.file !== this.session.file) {
      if (!force && this.session && newest.file !== this.session.file) {
        this.opts.log?.(`newer session detected: ${newest.id}`);
      }
      await this.open(newest);
    }
  }

  private async open(session: SessionSummary): Promise<void> {
    this.session = session;
    this.model = new SessionModel();
    this.tailer = new JsonlTailer(session.file);
    this.subTailers.clear();
    this.opts.log?.(`opened session ${session.id} (${session.file})`);
    await this.pollActive();
    await this.discoverSubagents();
    this.emit('session', session);
    this.scheduleChange(true);
  }

  private async pollActive(): Promise<void> {
    const tailer = this.tailer;
    if (!tailer) {
      return;
    }
    const res = await tailer.poll();
    if (tailer !== this.tailer) {
      return; // switched while reading
    }
    if (res === 'reset') {
      this.opts.log?.('transcript was rewritten; reloading');
      this.model = new SessionModel();
      this.subTailers.clear();
      const again = await tailer.poll();
      if (Array.isArray(again)) {
        this.model.ingest(again);
      }
      this.scheduleChange(true);
      return;
    }
    if (res && this.model.ingest(res)) {
      this.scheduleChange(false);
    }
    for (const [key, sub] of this.subTailers) {
      const recs = await sub.poll();
      if (Array.isArray(recs) && this.model.ingestSubagent('file:' + key, recs)) {
        this.scheduleChange(false);
      }
    }
  }

  private async discoverSubagents(): Promise<void> {
    if (!this.session) {
      return;
    }
    const sid = this.model.sessionId ?? this.session.id;
    const files = await this.subFinder.find(this.session.file, sid);
    for (const f of files) {
      if (!this.subTailers.has(f)) {
        const t = new JsonlTailer(f);
        this.subTailers.set(f, t);
        const recs = await t.poll();
        if (Array.isArray(recs) && this.model.ingestSubagent('file:' + f, recs)) {
          this.scheduleChange(false);
        }
      }
    }
  }

  /** Coalesce bursts of transcript lines into one UI refresh. */
  private scheduleChange(immediate: boolean): void {
    if (this.changeTimer) {
      if (!immediate) {
        return;
      }
      clearTimeout(this.changeTimer);
    }
    this.changeTimer = setTimeout(
      () => {
        this.changeTimer = undefined;
        this.emit('change');
      },
      immediate ? 0 : 120,
    );
  }
}
