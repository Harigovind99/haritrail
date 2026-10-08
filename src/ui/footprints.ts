import * as path from 'path';
import * as vscode from 'vscode';
import { fileKey } from '../model/session';
import { FileTouch, fileTouches } from '../model/trail';
import { Step } from '../model/types';
import { cfg, Hub } from './hub';

function touchStatus(ft: FileTouch): 'created' | 'edited' | 'read' | 'touched' {
  return ft.created ? 'created' : ft.edits > 0 ? 'edited' : ft.reads > 0 ? 'read' : 'touched';
}

function touchSummary(ft: FileTouch): string {
  const parts: string[] = [];
  if (ft.created) {
    parts.push('created');
  }
  const changes = ft.created ? ft.edits - 1 : ft.edits;
  if (changes > 0) {
    parts.push(`edited ${changes}×`);
  }
  if (ft.reads) {
    parts.push(`read ${ft.reads}×`);
  }
  if (ft.added + ft.removed) {
    parts.push(`+${ft.added} -${ft.removed}`);
  }
  return parts.join(' · ') || 'touched';
}

/**
 * Footprints in the Explorer: a small badge on every file Claude read (R), edited (E)
 * or created (N) in the focused prompt. The count tells how many times.
 */
export class FootprintDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;
  private current = new Map<string, { uri: vscode.Uri; ft: FileTouch }>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly hub: Hub) {
    this.disposables.push(hub.onDidChange(() => this.update()), vscode.window.registerFileDecorationProvider(this));
    this.update();
  }

  update(): void {
    const enabled = cfg().get<boolean>('footprints.enabled', true);
    const next = new Map<string, { uri: vscode.Uri; ft: FileTouch }>();
    if (enabled) {
      for (const ft of fileTouches(this.hub.scopedSteps()).values()) {
        next.set(ft.key, { uri: vscode.Uri.file(ft.path), ft });
      }
    }
    const changed: vscode.Uri[] = [];
    for (const [k, v] of this.current) {
      const n = next.get(k);
      if (!n || touchSummary(n.ft) !== touchSummary(v.ft)) {
        changed.push(v.uri);
      }
    }
    for (const [k, v] of next) {
      if (!this.current.has(k)) {
        changed.push(v.uri);
      }
    }
    this.current = next;
    if (changed.length) {
      this._onDidChange.fire(changed);
    }
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file') {
      return undefined;
    }
    const hit = this.current.get(fileKey(uri.fsPath));
    if (!hit) {
      return undefined;
    }
    const ft = hit.ft;
    const st = touchStatus(ft);
    const n = st === 'read' ? ft.reads : ft.created ? 0 : ft.edits;
    const letter = st === 'created' ? 'N' : st === 'edited' ? 'E' : st === 'read' ? 'R' : '•';
    const badge = n > 1 && n < 10 ? letter + n : n >= 10 ? letter + '+' : letter;
    const color = st === 'created' ? 'haritrail.create' : st === 'edited' ? 'haritrail.edit' : 'haritrail.read';
    return {
      badge,
      color: new vscode.ThemeColor(color),
      tooltip: `HariTrail: Claude ${touchSummary(ft)}`,
      propagate: false,
    };
  }

  dispose(): void {
    this._onDidChange.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

export type FNode = { type: 'dir'; id: string; dir: string; files: FileTouch[] } | { type: 'file'; id: string; ft: FileTouch; parentId: string };

/** "Footprints" view: the files Claude touched, grouped by folder, in visiting order. */
export class FootprintsTree implements vscode.TreeDataProvider<FNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly disposables: vscode.Disposable[] = [];
  view?: vscode.TreeView<FNode>;
  private lastKey = '';

  constructor(private readonly hub: Hub) {
    this.disposables.push(hub.onDidChange(() => this.refresh()), hub.onDidSwitchSession(() => this.refresh(true)));
  }

  attach(view: vscode.TreeView<FNode>): void {
    this.view = view;
    this.refresh(true);
  }

  private refresh(force = false): void {
    const key = `${this.hub.model.revision}|${this.hub.focused?.id}|${this.hub.footprintScope()}`;
    if (!force && key === this.lastKey) {
      return;
    }
    this.lastKey = key;
    this._onDidChangeTreeData.fire();
    if (this.view) {
      const f = this.hub.focused;
      this.view.description = this.hub.footprintScope() === 'session' ? 'whole session' : f ? `prompt #${f.index}` : undefined;
    }
  }

  getChildren(element?: FNode): FNode[] {
    if (!element) {
      const steps: Step[] = this.hub.scopedSteps();
      const touches = [...fileTouches(steps).values()].sort((a, b) => a.firstAt - b.firstAt);
      const groups = new Map<string, FileTouch[]>();
      for (const ft of touches) {
        const r = this.hub.rel(ft.path);
        const d = path.posix.dirname(r);
        const dir = d === '.' ? '' : d;
        groups.set(dir, [...(groups.get(dir) ?? []), ft]);
      }
      if (groups.size === 1 && groups.has('')) {
        return touches.map((ft) => ({ type: 'file', id: 'f:' + ft.key, ft, parentId: '' }));
      }
      return [...groups.entries()].map(([dir, files]) => ({ type: 'dir', id: 'd:' + dir, dir, files }));
    }
    if (element.type === 'dir') {
      return element.files.map((ft) => ({ type: 'file', id: 'f:' + ft.key, ft, parentId: element.id }));
    }
    return [];
  }

  getTreeItem(n: FNode): vscode.TreeItem {
    if (n.type === 'dir') {
      const item = new vscode.TreeItem(n.dir || '(workspace root)', vscode.TreeItemCollapsibleState.Expanded);
      item.id = n.id;
      item.iconPath = vscode.ThemeIcon.Folder;
      const edited = n.files.filter((f) => f.edits > 0).length;
      item.description = `${n.files.length} file${n.files.length === 1 ? '' : 's'}${edited ? ` · ${edited} changed` : ''}`;
      item.contextValue = 'footprintDir';
      return item;
    }
    const ft = n.ft;
    const item = new vscode.TreeItem(vscode.Uri.file(ft.path), vscode.TreeItemCollapsibleState.None);
    item.id = n.id;
    item.label = path.basename(ft.path);
    item.iconPath = vscode.ThemeIcon.File;
    item.description = touchSummary(ft);
    const md = new vscode.MarkdownString(undefined, true);
    md.appendText(this.hub.rel(ft.path));
    md.appendMarkdown('\n\n');
    md.appendMarkdown(
      ft.steps
        .map((s) => `#${s.label} ${s.verb}${s.kind === 'edit' || s.kind === 'create' ? ` (+${s.added ?? 0} -${s.removed ?? 0})` : ''}`)
        .join('  \n'),
    );
    item.tooltip = md;
    item.contextValue = 'footprintFile';
    item.command = { command: 'haritrail.openStep', title: 'Open', arguments: [ft.steps[ft.steps.length - 1].id] };
    return item;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
