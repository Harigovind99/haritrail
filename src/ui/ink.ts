import * as vscode from 'vscode';
import { oneLine } from '../model/describe';
import { fileKey } from '../model/session';
import { Step } from '../model/types';
import { cfg, Hub } from './hub';

interface Mark {
  startLine: number; // 0-based
  endLine: number;
  step: Step;
  deletion?: boolean;
  created?: boolean;
}

/**
 * Ink marks: lines Claude changed get a soft highlight, a mark in the scrollbar and a
 * faint signature ("◆ #7 Claude edited") at the end of the first changed line.
 * Hovering explains which move made the change and links to its diff.
 */
export class InkMarks implements vscode.Disposable {
  private readonly line: vscode.TextEditorDecorationType;
  private readonly deletion: vscode.TextEditorDecorationType;
  private readonly signature: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];
  private timer?: NodeJS.Timeout;

  constructor(private readonly hub: Hub) {
    this.line = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('haritrail.inkBackground'),
      borderColor: new vscode.ThemeColor('haritrail.edit'),
      borderStyle: 'solid',
      borderWidth: '0 0 0 2px',
      overviewRulerColor: new vscode.ThemeColor('haritrail.edit'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.deletion = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderColor: new vscode.ThemeColor('haritrail.edit'),
      borderStyle: 'dashed',
      borderWidth: '0 0 1px 0',
      overviewRulerColor: new vscode.ThemeColor('haritrail.edit'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.signature = vscode.window.createTextEditorDecorationType({
      after: {
        color: new vscode.ThemeColor('haritrail.signature'),
        margin: '0 0 0 2.5em',
        fontStyle: 'italic',
      },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    this.disposables.push(
      this.line,
      this.deletion,
      this.signature,
      hub.onDidChange(() => this.schedule(50)),
      vscode.window.onDidChangeVisibleTextEditors(() => this.schedule(0)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (vscode.window.visibleTextEditors.some((ed) => ed.document === e.document)) {
          this.schedule(400);
        }
      }),
    );
    this.schedule(0);
  }

  private schedule(ms: number): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => this.render(), ms);
  }

  render(): void {
    const enabled = cfg().get<boolean>('inkMarks.enabled', true);
    const showSignature = cfg().get<boolean>('inkMarks.signatures', true);
    const byFile = new Map<string, Step[]>();
    if (enabled) {
      for (const s of this.hub.scopedSteps()) {
        if (s.filePath && (s.kind === 'edit' || s.kind === 'create') && s.status === 'ok') {
          const k = fileKey(s.filePath);
          byFile.set(k, [...(byFile.get(k) ?? []), s]);
        }
      }
    }
    for (const editor of vscode.window.visibleTextEditors) {
      const doc = editor.document;
      const steps = doc.uri.scheme === 'file' ? byFile.get(fileKey(doc.uri.fsPath)) : undefined;
      if (!steps?.length) {
        editor.setDecorations(this.line, []);
        editor.setDecorations(this.deletion, []);
        editor.setDecorations(this.signature, []);
        continue;
      }
      const marks = this.marksFor(doc, steps);
      // Latest move wins each line.
      const owner = new Map<number, Mark>();
      for (const m of marks) {
        for (let l = m.startLine; l <= m.endLine; l++) {
          owner.set(l, m);
        }
      }
      const lineOpts: vscode.DecorationOptions[] = [];
      const delOpts: vscode.DecorationOptions[] = [];
      const sigOpts: vscode.DecorationOptions[] = [];
      const signed = new Set<string>();
      const sigHover = new Map<number, vscode.MarkdownString>();
      const sorted = [...owner.entries()].sort((a, b) => a[0] - b[0]);
      for (const [l, m] of sorted) {
        if (l >= doc.lineCount) {
          continue;
        }
        const range = doc.lineAt(l).range;
        const hover = this.hover(m.step);
        // New files are not painted line by line. They are only signed at the top.
        if (m.created) {
          sigHover.set(l, hover);
        } else if (m.deletion) {
          delOpts.push({ range, hoverMessage: hover });
        } else {
          lineOpts.push({ range, hoverMessage: hover });
        }
        const prev = owner.get(l - 1);
        if (showSignature && (!prev || prev.step !== m.step) && !signed.has(m.step.id + ':' + m.startLine)) {
          signed.add(m.step.id + ':' + m.startLine);
          const verb = m.created ? 'created' : m.deletion ? 'removed lines' : m.step.kind === 'create' ? 'wrote' : 'edited';
          sigOpts.push({
            range: new vscode.Range(range.end, range.end),
            renderOptions: { after: { contentText: `◆ #${m.step.label} Claude ${verb}` } },
          });
        }
      }
      // A created file has no painted lines, so its signature carries the hover instead.
      for (const o of sigOpts) {
        const hv = sigHover.get(o.range.start.line);
        if (hv) {
          o.hoverMessage = hv;
        }
      }
      editor.setDecorations(this.line, lineOpts);
      editor.setDecorations(this.deletion, delOpts);
      editor.setDecorations(this.signature, sigOpts);
    }
  }

  private marksFor(doc: vscode.TextDocument, steps: Step[]): Mark[] {
    const marks: Mark[] = [];
    let text: string | undefined;
    for (const s of steps) {
      if (s.kind === 'create' && s.tool === 'Write') {
        marks.push({ startLine: 0, endLine: 0, step: s, created: true });
        continue;
      }
      let placed = false;
      if (s.edits?.length) {
        text ??= doc.getText();
        for (const e of s.edits) {
          const m = locateEdit(doc, text, e.oldText, e.newText, s);
          if (m) {
            marks.push(m);
            placed = true;
          }
        }
      }
      if (!placed && s.ranges?.length) {
        for (const r of s.ranges) {
          marks.push({ startLine: r.start - 1, endLine: r.end - 1, step: s, deletion: r.deletionOnly });
        }
      }
    }
    return marks.filter((m) => m.startLine >= 0);
  }

  private hover(s: Step): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = { enabledCommands: ['haritrail.showDiff', 'haritrail.showOnMap', 'haritrail.revealStep'] };
    const exp = this.hub.model.getExpedition(s.expeditionId);
    md.appendMarkdown(`**$(sparkle) HariTrail · #${s.label} ${s.verb}**`);
    if (exp) {
      md.appendMarkdown(` in prompt #${exp.index}: `);
      md.appendText(oneLine(exp.prompt, 80));
    }
    if (s.narration) {
      md.appendMarkdown('\n\n');
      md.appendText(oneLine(s.narration, 300));
    }
    const arg = encodeURIComponent(JSON.stringify([s.id]));
    md.appendMarkdown(
      `\n\n[$(diff) Show this change](command:haritrail.showDiff?${arg}) · [$(list-tree) Find in Journey](command:haritrail.revealStep?${arg}) · [$(graph) Show on map](command:haritrail.showOnMap?${arg})`,
    );
    return md;
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.disposables.forEach((d) => d.dispose());
  }
}

/**
 * Find where an edit's new text lives in the current document and return only the
 * lines that actually differ from the old text. Falls back to undefined if the text
 * moved on (the patch ranges are used instead).
 */
function locateEdit(doc: vscode.TextDocument, text: string, oldText: string, newText: string, s: Step): Mark | undefined {
  if (!newText.trim()) {
    return undefined;
  }
  // Very short snippets ("}" or "x") would match in many places, so trust the patch ranges instead.
  if (newText.length < 12 && !newText.includes('\n')) {
    return undefined;
  }
  const hint = s.ranges?.[0] ? doc.offsetAt(new vscode.Position(Math.max(0, s.ranges[0].start - 1), 0)) : -1;
  let best = -1;
  let from = 0;
  let guard = 0;
  while (guard++ < 200) {
    const at = text.indexOf(newText, from);
    if (at < 0) {
      break;
    }
    if (best < 0 || (hint >= 0 && Math.abs(at - hint) < Math.abs(best - hint))) {
      best = at;
    }
    if (hint < 0) {
      break;
    }
    from = at + 1;
  }
  if (best < 0) {
    return undefined;
  }
  const startLine = doc.positionAt(best).line;
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  let pre = 0;
  while (pre < oldLines.length && pre < newLines.length && oldLines[pre] === newLines[pre]) {
    pre++;
  }
  let post = 0;
  while (
    post < oldLines.length - pre &&
    post < newLines.length - pre &&
    oldLines[oldLines.length - 1 - post] === newLines[newLines.length - 1 - post]
  ) {
    post++;
  }
  const changedNew = newLines.length - pre - post;
  if (changedNew <= 0) {
    const l = startLine + Math.max(0, pre - 1);
    return { startLine: l, endLine: l, step: s, deletion: true };
  }
  return { startLine: startLine + pre, endLine: startLine + pre + changedNew - 1, step: s };
}
