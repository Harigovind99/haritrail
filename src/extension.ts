import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { peekSession } from './live/locator';
import { oneLine } from './model/describe';
import { buildReport } from './model/report';
import { SessionSummary, Step } from './model/types';
import { TrailDocs } from './ui/docs';
import { FootprintDecorations, FootprintsTree } from './ui/footprints';
import { cfg, Hub } from './ui/hub';
import { InkMarks } from './ui/ink';
import { JNode, JourneyTree } from './ui/journeyTree';
import { TrailMapPanel } from './ui/mapPanel';
import { TrailStatusBar } from './ui/statusBar';

let hub: Hub | undefined;

export function activate(context: vscode.ExtensionContext): void {
  hub = new Hub();
  const h = hub;
  const docs = new TrailDocs(h);
  const journey = new JourneyTree(h);
  const journeyView = vscode.window.createTreeView('haritrail.journey', { treeDataProvider: journey, showCollapseAll: true });
  journey.attach(journeyView);
  const footprints = new FootprintsTree(h);
  const footprintsView = vscode.window.createTreeView('haritrail.footprints', { treeDataProvider: footprints, showCollapseAll: true });
  footprints.attach(footprintsView);

  context.subscriptions.push(
    h,
    docs,
    journey,
    journeyView,
    footprints,
    footprintsView,
    new FootprintDecorations(h),
    new InkMarks(h),
    new TrailStatusBar(h),
    new RideAlong(h),
    vscode.window.registerWebviewPanelSerializer(TrailMapPanel.viewType, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        TrailMapPanel.revive(panel, context, h);
      },
    }),
  );

  const stepFrom = (arg: unknown): Step | undefined => {
    if (typeof arg === 'string') {
      return h.model.getStep(arg);
    }
    if (arg && typeof arg === 'object') {
      const n = arg as Partial<JNode> & { ft?: { steps: Step[] } };
      if (n.type === 'step' && 'step' in n && n.step) {
        return n.step;
      }
      if (n.type === 'thought' && 'step' in n && n.step) {
        return n.step;
      }
      if (n.ft) {
        return n.ft.steps[n.ft.steps.length - 1];
      }
    }
    return undefined;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const register = (id: string, fn: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  register('haritrail.openMap', () => TrailMapPanel.show(context, h));

  register('haritrail.showOnMap', (arg: unknown) => {
    const step = stepFrom(arg);
    if (arg && typeof arg === 'object' && (arg as JNode).type === 'exp') {
      const exp = (arg as Extract<JNode, { type: 'exp' }>).exp;
      h.focus(exp.id);
      TrailMapPanel.show(context, h, { scope: 'follow' });
      return;
    }
    if (step) {
      h.focus(step.expeditionId);
    }
    TrailMapPanel.show(context, h, { stepId: step?.id, scope: 'follow' });
  });

  register('haritrail.openStep', async (arg: unknown, opts?: { preserveFocus?: boolean; quiet?: boolean }) => {
    const step = stepFrom(arg);
    if (!step) {
      return;
    }
    await openStep(step, docs, opts?.preserveFocus ?? false, opts?.quiet ?? false);
  });

  register('haritrail.showDiff', async (arg: unknown) => {
    const step = stepFrom(arg);
    if (!step) {
      return;
    }
    if (!step.edits?.length && step.writtenContent === undefined) {
      void vscode.window.showInformationMessage('HariTrail: this move did not change a file.');
      return;
    }
    await docs.showDiff(step);
  });

  register('haritrail.showOutput', async (arg: unknown) => {
    const step = stepFrom(arg);
    if (step) {
      await docs.showOutput(step);
    }
  });

  register('haritrail.showText', async (title: unknown, text: unknown, lang: unknown) => {
    if (typeof text === 'string') {
      await docs.showText(String(title ?? 'Text'), text, lang === 'markdown' ? 'markdown' : 'plaintext');
    }
  });

  register('haritrail.revealStep', async (arg: unknown) => {
    const step = stepFrom(arg);
    if (!step) {
      return;
    }
    await vscode.commands.executeCommand('haritrail.journey.focus');
    const node = journey.findStepNode(step);
    if (node) {
      await journeyView.reveal(node, { select: true, focus: true, expand: true });
    }
  });

  register('haritrail.focusExpedition', (arg: unknown) => {
    if (arg && typeof arg === 'object' && (arg as JNode).type === 'exp') {
      h.focus((arg as Extract<JNode, { type: 'exp' }>).exp.id);
    }
  });

  register('haritrail.focusLatest', () => h.focus(undefined));

  register('haritrail.pickSession', () => pickSession(h));

  register('haritrail.followLatest', async () => {
    await h.controller.follow();
    void vscode.commands.executeCommand('setContext', 'haritrail.pinned', false);
    if (!h.controller.session) {
      void vscode.window.showInformationMessage('HariTrail: no Claude Code session found for this workspace yet. Send a prompt from the Claude Code chat panel, or run `claude` in a terminal in this folder.');
    }
  });

  register('haritrail.refresh', () => h.controller.reload());

  register('haritrail.exportReport', async (arg: unknown) => {
    const m = h.model;
    if (!m.expeditions.length) {
      void vscode.window.showInformationMessage('HariTrail: nothing to export yet.');
      return;
    }
    let exps = m.expeditions;
    if (arg && typeof arg === 'object' && (arg as JNode).type === 'exp') {
      exps = [(arg as Extract<JNode, { type: 'exp' }>).exp];
    } else {
      const focused = h.focused;
      const pick = await vscode.window.showQuickPick(
        [
          { label: `$(milestone) Prompt #${focused?.index}`, description: oneLine(focused?.prompt ?? '', 70), value: 'one' },
          { label: '$(history) Whole session', description: `${m.expeditions.length} prompts`, value: 'all' },
        ],
        { title: 'HariTrail: export journey report', placeHolder: 'What should the report cover?' },
      );
      if (!pick) {
        return;
      }
      exps = pick.value === 'one' && focused ? [focused] : m.expeditions;
    }
    const content = buildReport(m, exps, (p) => h.rel(p));
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content });
    await vscode.window.showTextDocument(doc, { preview: false });
  });

  const toggle = (key: string, value: unknown) => cfg().update(key, value, vscode.ConfigurationTarget.Global);
  register('haritrail.rideAlongOn', () => toggle('rideAlong', true));
  register('haritrail.rideAlongOff', () => toggle('rideAlong', false));
  register('haritrail.inkOn', () => toggle('inkMarks.enabled', true));
  register('haritrail.inkOff', () => toggle('inkMarks.enabled', false));
  register('haritrail.scopePrompt', () => toggle('footprints.scope', 'prompt'));
  register('haritrail.scopeSession', () => toggle('footprints.scope', 'session'));
  register('haritrail.showLog', () => h.log.show());
  register('haritrail.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:harigovind99.haritrail'));

  const syncContexts = () => {
    void vscode.commands.executeCommand('setContext', 'haritrail.rideAlong', cfg().get<boolean>('rideAlong', false));
    void vscode.commands.executeCommand('setContext', 'haritrail.ink', cfg().get<boolean>('inkMarks.enabled', true));
    void vscode.commands.executeCommand('setContext', 'haritrail.scopeSession', cfg().get<string>('footprints.scope', 'prompt') === 'session');
  };
  syncContexts();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('haritrail')) {
        syncContexts();
      }
    }),
  );
}

export function deactivate(): void {
  hub = undefined;
}

/** Open the file a move touched, at the lines it touched. */
async function openStep(step: Step, docs: TrailDocs, preserveFocus: boolean, quiet: boolean): Promise<void> {
  if (!step.filePath) {
    if (['run', 'test', 'build', 'git', 'install'].includes(step.kind)) {
      await docs.showOutput(step);
    } else if (!quiet) {
      const lines = [
        `#${step.label} ${step.verb} ${step.title}`,
        `Tool: ${step.tool}`,
        '',
        step.narration ? `Claude said:\n${step.narration}\n` : '',
        'Input:',
        JSON.stringify(step.input, null, 2),
        '',
        step.resultPreview ? `Result:\n${step.resultPreview}` : '',
      ];
      await docs.showText(`step-${step.label}`, lines.filter((l) => l !== undefined).join('\n'));
    }
    return;
  }
  const uri = vscode.Uri.file(step.filePath);
  if (!fs.existsSync(step.filePath)) {
    if (quiet) {
      return; // Ride-Along / replay: the file may not be written yet, so don't pop up a diff.
    }
    if (step.edits?.length || step.writtenContent !== undefined) {
      await docs.showDiff(step);
    } else {
      void vscode.window.showWarningMessage(`HariTrail: ${path.basename(step.filePath)} no longer exists.`);
    }
    return;
  }
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch {
    // Binary or too large: let VS Code decide how to show it.
    await vscode.commands.executeCommand('vscode.open', uri, { preserveFocus, preview: true });
    return;
  }
  let range: vscode.Range | undefined;
  const lineRange = (a: number, b: number) =>
    new vscode.Range(Math.max(0, Math.min(doc.lineCount - 1, a - 1)), 0, Math.max(0, Math.min(doc.lineCount - 1, b - 1)), 0);
  if (step.edits?.length) {
    const text = doc.getText();
    const e = step.edits.find((x) => x.newText.trim().length > 0);
    const at = e ? text.indexOf(e.newText) : -1;
    if (at >= 0 && e) {
      range = new vscode.Range(doc.positionAt(at), doc.positionAt(at + e.newText.length));
    }
  }
  if (!range && step.ranges?.length) {
    range = lineRange(step.ranges[0].start, step.ranges[0].end);
  }
  if (!range && step.readRange) {
    range = lineRange(step.readRange.start, step.readRange.end);
  }
  const editor = await vscode.window.showTextDocument(doc, { preview: true, preserveFocus, selection: range ? new vscode.Selection(range.start, range.start) : undefined });
  if (range) {
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
}

/** Follow Claude through your files: each new file it touches opens in a preview tab. */
class RideAlong implements vscode.Disposable {
  private lastId?: string;
  private lastOpen = 0;
  private pending?: NodeJS.Timeout;
  private readonly sub: vscode.Disposable;

  constructor(private readonly h: Hub) {
    this.sub = h.onDidChange(() => this.check());
  }

  private check(): void {
    if (!cfg().get<boolean>('rideAlong', false)) {
      return;
    }
    const exp = this.h.model.current;
    if (!exp || !this.h.model.isLive(exp)) {
      return;
    }
    const steps = this.h.model.flatSteps(exp);
    const last = [...steps].reverse().find((s) => s.filePath);
    if (!last || last.id === this.lastId) {
      return;
    }
    this.lastId = last.id;
    const wait = Math.max(0, 700 - (Date.now() - this.lastOpen));
    if (this.pending) {
      clearTimeout(this.pending);
    }
    this.pending = setTimeout(() => {
      this.lastOpen = Date.now();
      void vscode.commands.executeCommand('haritrail.openStep', last.id, { preserveFocus: true, quiet: true });
    }, wait);
  }

  dispose(): void {
    if (this.pending) {
      clearTimeout(this.pending);
    }
    this.sub.dispose();
  }
}

async function pickSession(h: Hub): Promise<void> {
  const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { session?: SessionSummary }>();
  qp.title = 'HariTrail: choose a Claude Code session';
  qp.placeholder = 'Sessions for this workspace, newest first';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  const allBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('globe'), tooltip: 'Show sessions from every project' };
  qp.buttons = [allBtn];
  let all = false;
  const load = async () => {
    qp.busy = true;
    let sessions = await h.controller.locatorRef.listSessions(all);
    if (!sessions.length && !all) {
      all = true;
      qp.placeholder = 'No sessions for this workspace. Showing every project.';
      sessions = await h.controller.locatorRef.listSessions(true);
    }
    const items: (vscode.QuickPickItem & { session?: SessionSummary })[] = [];
    items.push({ label: '$(pulse) Follow the latest session automatically', description: h.controller.mode === 'follow' ? 'current' : '' });
    for (const s of sessions.slice(0, 60)) {
      const peek = await peekSession(s.file, 256 * 1024);
      const isCurrent = h.controller.session?.file === s.file;
      items.push({
        label: `${isCurrent ? '$(eye) ' : '$(history) '}${oneLine(peek.firstPrompt ?? s.id, 80)}`,
        description: [peek.source, relativeTime(s.mtime), `${(s.size / 1024).toFixed(0)} KB`].filter(Boolean).join(' · '),
        detail: all ? peek.cwd ?? s.dir : undefined,
        session: s,
      });
    }
    qp.items = items;
    qp.busy = false;
  };
  qp.onDidTriggerButton(() => {
    all = !all;
    void load();
  });
  qp.onDidAccept(async () => {
    const it = qp.selectedItems[0];
    qp.hide();
    if (!it) {
      return;
    }
    if (!it.session) {
      await h.controller.follow();
      void vscode.commands.executeCommand('setContext', 'haritrail.pinned', false);
    } else {
      await h.controller.pin(it.session);
      void vscode.commands.executeCommand('setContext', 'haritrail.pinned', true);
    }
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
  await load();
}

function relativeTime(t: number): string {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) {
    return 'just now';
  }
  if (s < 3600) {
    return `${Math.round(s / 60)} min ago`;
  }
  if (s < 86400) {
    return `${Math.round(s / 3600)} h ago`;
  }
  return new Date(t).toLocaleDateString();
}
