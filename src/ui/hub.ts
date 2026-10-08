import * as path from 'path';
import * as vscode from 'vscode';
import { LiveController } from '../live/controller';
import { claudeHome } from '../live/locator';
import { SessionModel } from '../model/session';
import { Expedition, Step } from '../model/types';

export type FootprintScope = 'prompt' | 'session';

/**
 * Shared state for every HariTrail view: the live controller, which prompt is in
 * focus, and helpers for turning absolute paths into workspace-relative ones.
 */
export class Hub implements vscode.Disposable {
  readonly controller: LiveController;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires when the model or the focused prompt changes. */
  readonly onDidChange = this._onDidChange.event;
  private readonly _onDidSwitchSession = new vscode.EventEmitter<void>();
  readonly onDidSwitchSession = this._onDidSwitchSession.event;
  /** Explicitly focused prompt; undefined means "the latest one". */
  private focusId?: string;
  readonly log: vscode.OutputChannel;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.log = vscode.window.createOutputChannel('HariTrail');
    this.controller = new LiveController({
      home: claudeHome(cfg().get<string>('claudeDirectory')),
      workspaceFolders: workspaceRoots(),
      pollMs: clampPoll(cfg().get<number>('pollIntervalMs')),
      log: (m) => this.log.appendLine(`[${new Date().toLocaleTimeString()}] ${m}`),
    });
    this.controller.on('change', () => this._onDidChange.fire());
    this.controller.on('session', () => {
      this.focusId = undefined;
      this._onDidSwitchSession.fire();
      void vscode.commands.executeCommand('setContext', 'haritrail.hasSession', !!this.controller.session);
      void vscode.commands.executeCommand('setContext', 'haritrail.pinned', this.controller.mode === 'pinned');
    });
    this.disposables.push(
      this.log,
      this._onDidChange,
      this._onDidSwitchSession,
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.controller.updateOptions({ workspaceFolders: workspaceRoots() })),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('haritrail.claudeDirectory') || e.affectsConfiguration('haritrail.pollIntervalMs')) {
          this.controller.updateOptions({
            home: claudeHome(cfg().get<string>('claudeDirectory')),
            pollMs: clampPoll(cfg().get<number>('pollIntervalMs')),
          });
        }
        if (e.affectsConfiguration('haritrail')) {
          this._onDidChange.fire();
        }
      }),
    );
    void vscode.commands.executeCommand('setContext', 'haritrail.hasSession', false);
    this.controller.start();
  }

  get model(): SessionModel {
    return this.controller.model;
  }

  /** The prompt the views are focused on (explicit pick, else the latest). */
  get focused(): Expedition | undefined {
    return (this.focusId && this.model.getExpedition(this.focusId)) || this.model.current;
  }

  get isFocusPinned(): boolean {
    return !!this.focusId && !!this.model.getExpedition(this.focusId) && this.focusId !== this.model.current?.id;
  }

  focus(expeditionId: string | undefined): void {
    const next = expeditionId && expeditionId === this.model.current?.id ? undefined : expeditionId;
    if (next !== this.focusId) {
      this.focusId = next;
      this._onDidChange.fire();
    }
  }

  footprintScope(): FootprintScope {
    return cfg().get<FootprintScope>('footprints.scope', 'prompt');
  }

  /** Steps that drive footprints and ink marks, according to the scope setting. */
  scopedSteps(): Step[] {
    if (this.footprintScope() === 'session') {
      return this.model.expeditions.flatMap((e) => this.model.flatSteps(e));
    }
    const f = this.focused;
    return f ? this.model.flatSteps(f) : [];
  }

  /** Workspace-relative display path; files outside the workspace keep a ~ or full path. */
  rel(p: string): string {
    const uri = vscode.Uri.file(p);
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder) {
      const r = path.relative(folder.uri.fsPath, p).split(path.sep).join('/');
      return (vscode.workspace.workspaceFolders?.length ?? 0) > 1 ? `${folder.name}/${r}` : r;
    }
    const cwd = this.model.cwd;
    if (cwd && isInsidePath(p, cwd)) {
      return path.relative(cwd, p).split(path.sep).join('/');
    }
    const home = process.env.HOME ?? process.env.USERPROFILE;
    if (home && isInsidePath(p, home)) {
      return '~/' + path.relative(home, p).split(path.sep).join('/');
    }
    return p;
  }

  /** Folder group used on the map: workspace-relative directory. */
  groupOf(p: string): string {
    const r = this.rel(p);
    const d = path.posix.dirname(r);
    return d === '.' ? '(root)' : d;
  }

  dispose(): void {
    this.controller.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

export function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('haritrail');
}

function clampPoll(v: number | undefined): number {
  return Math.min(5000, Math.max(150, v ?? 400));
}

export function workspaceRoots(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
}

function isInsidePath(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return '';
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const s = ms / 1000;
  if (s < 60) {
    return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  }
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  if (m < 60) {
    return `${m}m ${rs}s`;
  }
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
