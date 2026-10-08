import * as path from 'path';
import * as vscode from 'vscode';
import { diffSides } from '../model/diff';
import { Step } from '../model/types';
import { Hub } from './hub';

export const SCHEME = 'haritrail';

/**
 * Read-only documents HariTrail opens: before/after of a change, command output,
 * and longer texts (Claude's narration or final answer).
 */
export class TrailDocs implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly texts = new Map<string, string>();
  private counter = 0;
  private readonly registration: vscode.Disposable;

  constructor(private readonly hub: Hub) {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(SCHEME, this);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const parts = uri.path.split('/').filter(Boolean);
    const [kind, id, side] = parts;
    if (kind === 'text') {
      return this.texts.get(id) ?? '';
    }
    const step = this.hub.model.getStep(decodeURIComponent(id ?? ''));
    if (!step) {
      return '(This move is no longer loaded. The session may have changed.)';
    }
    if (kind === 'diff') {
      const d = diffSides(step);
      return side === 'before' ? d.before : d.after;
    }
    if (kind === 'output') {
      const cmd = typeof step.input.command === 'string' ? step.input.command : step.title;
      const body = step.fullOutput ?? step.resultPreview ?? '(no output recorded yet)';
      return `$ ${cmd}\n\n${body}\n`;
    }
    return '';
  }

  async showDiff(step: Step): Promise<void> {
    const base = step.filePath ? path.basename(step.filePath) : 'change.txt';
    const id = encodeURIComponent(step.id);
    const left = vscode.Uri.from({ scheme: SCHEME, path: `/diff/${id}/before/${base}` });
    const right = vscode.Uri.from({ scheme: SCHEME, path: `/diff/${id}/after/${base}` });
    const d = diffSides(step);
    const title = `${base} · #${step.label} ${step.verb} by Claude${d.full ? '' : ' (changed snippets)'}`;
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
  }

  async showOutput(step: Step): Promise<void> {
    const uri = vscode.Uri.from({ scheme: SCHEME, path: `/output/${encodeURIComponent(step.id)}/step-${step.label}.log` });
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  async showText(title: string, text: string, language: 'markdown' | 'plaintext' = 'plaintext'): Promise<void> {
    const key = String(++this.counter);
    this.texts.set(key, text);
    if (this.texts.size > 50) {
      const first = this.texts.keys().next().value;
      if (first !== undefined) {
        this.texts.delete(first);
      }
    }
    const safe = title.replace(/[^\w .#-]+/g, '').slice(0, 60) || 'text';
    const uri = vscode.Uri.from({ scheme: SCHEME, path: `/text/${key}/${safe}.${language === 'markdown' ? 'md' : 'txt'}` });
    const doc = await vscode.workspace.openTextDocument(uri);
    if (language === 'markdown') {
      await vscode.commands.executeCommand('markdown.showPreview', doc.uri).then(undefined, () => vscode.window.showTextDocument(doc, { preview: true }));
    } else {
      await vscode.window.showTextDocument(doc, { preview: true });
    }
  }

  dispose(): void {
    this.registration.dispose();
  }
}
