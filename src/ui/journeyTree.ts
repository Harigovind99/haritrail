import * as path from 'path';
import * as vscode from 'vscode';
import { oneLine } from '../model/describe';
import { statsFor } from '../model/trail';
import { Expedition, Step } from '../model/types';
import { cfg, formatDuration, Hub } from './hub';
import { stepIcon } from './look';

export type JNode =
  | { type: 'exp'; id: string; exp: Expedition }
  | { type: 'step'; id: string; step: Step; parentId: string }
  | { type: 'thought'; id: string; text: string; thinking: boolean; parentId: string; step: Step }
  | { type: 'interject'; id: string; text: string; at: number; parentId: string }
  | { type: 'answer'; id: string; exp: Expedition; parentId: string };

/**
 * "Journey" view: every prompt you sent, and under it each move Claude made, in order,
 * with what Claude said right before the move. Native tree, so it looks and behaves
 * like the rest of VS Code (keyboard nav, filtering, theming).
 */
export class JourneyTree implements vscode.TreeDataProvider<JNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<JNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private nodes = new Map<string, JNode>();
  private lastRevision = -1;
  private lastStepId?: string;
  view?: vscode.TreeView<JNode>;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly hub: Hub) {
    this.disposables.push(
      hub.onDidChange(() => this.refresh()),
      hub.onDidSwitchSession(() => {
        this.nodes.clear();
        this.lastRevision = -1;
        this.lastStepId = undefined;
        this.refresh(true);
      }),
    );
  }

  attach(view: vscode.TreeView<JNode>): void {
    this.view = view;
    this.disposables.push(
      view.onDidChangeSelection((e) => {
        const n = e.selection[0];
        if (!n) {
          return;
        }
        const expId = n.type === 'exp' ? n.exp.id : n.type === 'step' ? n.step.expeditionId : undefined;
        if (expId) {
          this.hub.focus(expId);
        }
      }),
      view.onDidChangeVisibility((e) => {
        if (e.visible) {
          this.refresh(true);
        }
      }),
    );
    this.updateHeader();
  }

  refresh(force = false): void {
    const rev = this.hub.model.revision;
    if (!force && rev === this.lastRevision) {
      this.updateHeader();
      return;
    }
    this.lastRevision = rev;
    this._onDidChangeTreeData.fire();
    this.updateHeader();
    this.autoReveal();
  }

  private updateHeader(): void {
    if (!this.view) {
      return;
    }
    const c = this.hub.controller;
    const m = this.hub.model;
    if (!c.session) {
      this.view.description = undefined;
      this.view.message = undefined;
      return;
    }
    const live = m.current && m.isLive(m.current);
    this.view.description = `${c.mode === 'pinned' ? '$(pin) ' : ''}${oneLine(m.title ?? c.session.id, 48)}${live ? ' · live' : ''}`;
    this.view.message = m.expeditions.length ? undefined : 'Session found. Waiting for the first prompt...';
    this.view.badge = undefined;
  }

  /** Keep the newest move in sight while Claude works (only when the view is visible). */
  private autoReveal(): void {
    if (!this.view?.visible || !cfg().get<boolean>('journey.autoReveal', true)) {
      return;
    }
    const exp = this.hub.model.current;
    if (!exp || !this.hub.model.isLive(exp)) {
      return;
    }
    const last = exp.steps[exp.steps.length - 1];
    if (!last || last.id === this.lastStepId) {
      return;
    }
    this.lastStepId = last.id;
    // Wait for VS Code to pick up the refresh, then make sure the node exists and reveal it.
    setTimeout(() => {
      const node = this.findStepNode(last);
      if (node && this.view?.visible) {
        void Promise.resolve(this.view.reveal(node, { select: false, focus: false, expand: false })).catch(() => {
          this.lastStepId = undefined; // try again on the next change
        });
      } else {
        this.lastStepId = undefined;
      }
    }, 80);
  }

  private node<T extends JNode>(n: T): T {
    const prev = this.nodes.get(n.id);
    if (prev) {
      Object.assign(prev, n);
      return prev as T;
    }
    this.nodes.set(n.id, n);
    return n;
  }

  /** Make sure the tree nodes on the way to a step exist, and return the step's node. */
  findStepNode(step: Step): JNode | undefined {
    const roots = this.getChildren();
    const expNode = roots.find((n) => n.type === 'exp' && n.exp.id === step.expeditionId);
    if (!expNode) {
      return undefined;
    }
    this.getChildren(expNode);
    if (step.parentStepId) {
      const parent = this.nodes.get('step:' + step.parentStepId);
      if (parent) {
        this.getChildren(parent);
      }
    }
    return this.nodes.get('step:' + step.id);
  }

  getParent(element: JNode): JNode | undefined {
    if (element.type === 'exp') {
      return undefined;
    }
    return this.nodes.get(element.parentId);
  }

  getChildren(element?: JNode): JNode[] {
    const m = this.hub.model;
    const showNarration = cfg().get<boolean>('journey.showNarration', true);
    const showThinking = cfg().get<boolean>('journey.showThinking', true);
    if (!element) {
      return m.expeditions.map((exp) => this.node({ type: 'exp', id: 'exp:' + exp.id, exp }));
    }
    if (element.type === 'exp') {
      const exp = element.exp;
      const out: JNode[] = [];
      const inter = exp.interjections.slice().sort((a, b) => a.at - b.at);
      let ii = 0;
      exp.steps.forEach((s) => {
        while (ii < inter.length && inter[ii].at <= s.startedAt) {
          out.push(this.node({ type: 'interject', id: `int:${exp.id}:${ii}`, text: inter[ii].text, at: inter[ii].at, parentId: element.id }));
          ii++;
        }
        out.push(...this.thoughts(s, element.id, showNarration, showThinking));
        out.push(this.node({ type: 'step', id: 'step:' + s.id, step: s, parentId: element.id }));
      });
      while (ii < inter.length) {
        out.push(this.node({ type: 'interject', id: `int:${exp.id}:${ii}`, text: inter[ii].text, at: inter[ii].at, parentId: element.id }));
        ii++;
      }
      if (exp.done && !exp.interrupted && exp.finalText) {
        out.push(this.node({ type: 'answer', id: 'ans:' + exp.id, exp, parentId: element.id }));
      }
      return out;
    }
    if (element.type === 'step') {
      const out: JNode[] = [];
      for (const c of element.step.children) {
        out.push(...this.thoughts(c, element.id, showNarration, false));
        out.push(this.node({ type: 'step', id: 'step:' + c.id, step: c, parentId: element.id }));
      }
      return out;
    }
    return [];
  }

  private thoughts(s: Step, parentId: string, narration: boolean, thinking: boolean): JNode[] {
    const out: JNode[] = [];
    if (thinking && s.thinking) {
      out.push(this.node({ type: 'thought', id: 'think:' + s.id, text: s.thinking, thinking: true, parentId, step: s }));
    }
    if (narration && s.narration) {
      out.push(this.node({ type: 'thought', id: 'say:' + s.id, text: s.narration, thinking: false, parentId, step: s }));
    }
    return out;
  }

  getTreeItem(n: JNode): vscode.TreeItem {
    switch (n.type) {
      case 'exp':
        return this.expItem(n.exp, n.id);
      case 'step':
        return this.stepItem(n.step, n.id);
      case 'thought': {
        const item = new vscode.TreeItem(oneLine(n.text, 140), vscode.TreeItemCollapsibleState.None);
        item.id = n.id;
        item.iconPath = new vscode.ThemeIcon(n.thinking ? 'lightbulb' : 'comment', new vscode.ThemeColor('descriptionForeground'));
        item.description = n.thinking ? 'thinking' : 'Claude';
        const md = new vscode.MarkdownString();
        md.appendMarkdown(n.thinking ? '**Claude was thinking**\n\n' : '**Claude said**\n\n');
        md.appendText(n.text.slice(0, 4000));
        item.tooltip = md;
        item.contextValue = 'thought';
        item.command = { command: 'haritrail.showText', title: 'Show', arguments: [n.thinking ? 'Thinking' : 'Claude said', n.text] };
        return item;
      }
      case 'interject': {
        const item = new vscode.TreeItem(oneLine(n.text, 140), vscode.TreeItemCollapsibleState.None);
        item.id = n.id;
        item.iconPath = new vscode.ThemeIcon('person', new vscode.ThemeColor('haritrail.you'));
        item.description = 'you, mid-run';
        const md = new vscode.MarkdownString('**You steered while Claude was working**\n\n');
        md.appendText(n.text);
        item.tooltip = md;
        item.contextValue = 'interjection';
        return item;
      }
      case 'answer': {
        const text = n.exp.finalText ?? '';
        const item = new vscode.TreeItem(oneLine(text, 140), vscode.TreeItemCollapsibleState.None);
        item.id = n.id;
        item.iconPath = new vscode.ThemeIcon('flag', new vscode.ThemeColor('haritrail.create'));
        item.description = 'final answer';
        const md = new vscode.MarkdownString("**Claude's final answer**\n\n");
        md.appendText(text.slice(0, 4000));
        item.tooltip = md;
        item.command = { command: 'haritrail.showText', title: 'Show', arguments: [`Answer to prompt #${n.exp.index}`, text, 'markdown'] };
        item.contextValue = 'answer';
        return item;
      }
    }
  }

  private expItem(exp: Expedition, id: string): vscode.TreeItem {
    const m = this.hub.model;
    const live = m.isLive(exp);
    const isFocused = this.hub.focused?.id === exp.id;
    const item = new vscode.TreeItem(
      `${exp.index}. ${oneLine(exp.prompt, 90)}`,
      exp === m.current || isFocused ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = id;
    const st = statsFor(m, [exp]);
    const parts: string[] = [];
    parts.push(`${st.steps} move${st.steps === 1 ? '' : 's'}`);
    const changed = st.filesEdited + st.filesCreated;
    if (changed) {
      parts.push(`${changed} file${changed === 1 ? '' : 's'} changed`);
    }
    if (st.testsPassed + st.testsFailed) {
      parts.push(`tests ${st.testsPassed}✓ ${st.testsFailed}✗`);
    }
    const dur = formatDuration((exp.endedAt ?? (live ? Date.now() : exp.lastActivity)) - exp.startedAt);
    if (dur) {
      parts.push(dur);
    }
    item.description = (live ? '● live · ' : isFocused && this.hub.isFocusPinned ? '◎ focused · ' : '') + parts.join(' · ');
    if (live) {
      item.iconPath = new vscode.ThemeIcon('loading~spin', new vscode.ThemeColor('haritrail.edit'));
    } else if (exp.interrupted) {
      item.iconPath = new vscode.ThemeIcon('debug-stop', new vscode.ThemeColor('disabledForeground'));
    } else if (st.testsFailed && !st.testsPassed) {
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('testing.iconFailed'));
    } else {
      item.iconPath = new vscode.ThemeIcon('milestone', new vscode.ThemeColor(isFocused ? 'haritrail.edit' : 'descriptionForeground'));
    }
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**Prompt #${exp.index}**${live ? ' · $(pulse) live' : exp.interrupted ? ' · interrupted' : ''}\n\n`);
    md.appendText(exp.prompt.slice(0, 2000));
    md.appendMarkdown('\n\n---\n\n');
    md.appendMarkdown(
      `$(eye) ${st.filesRead} read · $(edit) ${st.filesEdited} edited · $(new-file) ${st.filesCreated} created · $(terminal) ${st.commands} commands` +
        (st.linesAdded + st.linesRemoved ? ` · +${st.linesAdded} -${st.linesRemoved}` : '') +
        (st.loopBacks ? ` · $(sync) ${st.loopBacks} fix loop${st.loopBacks === 1 ? '' : 's'}` : '') +
        (st.subagentSteps ? ` · $(organization) ${st.subagentSteps} subagent moves` : '') +
        (exp.source ? `\n\n$(comment-discussion) Sent from the ${exp.source}` : '') +
        (exp.model ? `\n\n$(hubot) ${exp.model}${exp.outputTokens ? ` · ${exp.outputTokens.toLocaleString()} output tokens` : ''}` : ''),
    );
    item.tooltip = md;
    item.contextValue = live ? 'expedition.live' : 'expedition';
    return item;
  }

  private stepItem(s: Step, id: string): vscode.TreeItem {
    const item = new vscode.TreeItem(
      `${s.verb} ${s.title}`,
      s.children.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    item.id = id;
    item.iconPath = stepIcon(s);
    const desc: string[] = [`#${s.label}`];
    if (s.filePath) {
      const r = this.hub.rel(s.filePath);
      const dir = path.posix.dirname(r);
      if (dir && dir !== '.') {
        desc.push(dir);
      }
    }
    if ((s.added ?? 0) + (s.removed ?? 0) > 0 && (s.kind === 'edit' || s.kind === 'create')) {
      desc.push(`+${s.added ?? 0} -${s.removed ?? 0}`);
    }
    if (s.readRange) {
      desc.push(`L${s.readRange.start}-${s.readRange.end}`);
    }
    if (s.afterFailure) {
      desc.push('⟲ after failure');
    } else if (s.revisitOf) {
      desc.push(`↩ back from #${s.revisitOf}`);
    }
    if (s.children.length) {
      desc.push(`${s.children.length} subagent moves`);
    }
    if (s.endedAt && s.endedAt - s.startedAt >= 1500) {
      desc.push(formatDuration(s.endedAt - s.startedAt));
    }
    if (s.status === 'error') {
      desc.push('failed');
    } else if (s.status === 'interrupted') {
      desc.push('stopped');
    }
    item.description = desc.join(' · ');
    item.tooltip = this.stepTooltip(s);
    const tags = ['step', s.kind];
    if (s.filePath) {
      tags.push('file');
    }
    if (s.edits?.length || s.writtenContent !== undefined) {
      tags.push('diff');
    }
    if (s.fullOutput !== undefined || ['run', 'test', 'build', 'git', 'install'].includes(s.kind)) {
      tags.push('output');
    }
    item.contextValue = tags.join('.');
    item.command = { command: 'haritrail.openStep', title: 'Open', arguments: [s.id] };
    return item;
  }

  private stepTooltip(s: Step): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**#${s.label} · ${s.verb}** `);
    md.appendText(s.filePath ? this.hub.rel(s.filePath) : s.title);
    md.appendMarkdown(`  \n$(tools) \`${s.tool}\``);
    if (s.endedAt) {
      md.appendMarkdown(` · $(watch) ${formatDuration(s.endedAt - s.startedAt)}`);
    } else if (s.status === 'running') {
      md.appendMarkdown(' · $(loading~spin) running');
    }
    if (s.kind === 'test' && s.outcome) {
      md.appendMarkdown(s.outcome === 'pass' ? ' · $(pass) looks passing' : ' · $(error) looks failing');
    }
    if (s.afterFailure) {
      md.appendMarkdown('\n\n$(sync) Came back to change code right after a failing check.');
    } else if (s.revisitOf) {
      md.appendMarkdown(`\n\n$(reply) Back to a file first visited at #${s.revisitOf}.`);
    }
    if (s.narration) {
      md.appendMarkdown('\n\n**Claude said before this move**\n\n');
      md.appendText(s.narration.slice(0, 1200));
    }
    const i = s.input as Record<string, unknown>;
    if (typeof i.command === 'string') {
      md.appendCodeblock(i.command.slice(0, 1500), 'shellscript');
    } else if (typeof i.pattern === 'string') {
      md.appendCodeblock(String(i.pattern), 'text');
    } else if (s.edits?.length) {
      const e = s.edits[0];
      const diff = [...e.oldText.split('\n').slice(0, 8).map((l) => '- ' + l), ...e.newText.split('\n').slice(0, 8).map((l) => '+ ' + l)].join('\n');
      md.appendCodeblock(diff, 'diff');
      if (s.edits.length > 1) {
        md.appendMarkdown(`_...and ${s.edits.length - 1} more edit${s.edits.length > 2 ? 's' : ''}_`);
      }
    }
    const result = s.fullOutput ?? s.resultPreview;
    if (result && s.kind !== 'read' && s.kind !== 'edit' && s.kind !== 'create') {
      md.appendMarkdown('\n**Result**');
      md.appendCodeblock(result.slice(-900), 'text');
    }
    return md;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
