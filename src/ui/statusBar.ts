import * as vscode from 'vscode';
import { oneLine } from '../model/describe';
import { statsFor } from '../model/trail';
import { cfg, formatDuration, Hub } from './hub';

/** Bottom-bar heartbeat: what Claude is doing right now, or a summary of the last prompt. */
export class TrailStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly ticker: NodeJS.Timeout;

  constructor(private readonly hub: Hub) {
    this.item = vscode.window.createStatusBarItem('haritrail.status', vscode.StatusBarAlignment.Left, 50);
    this.item.name = 'HariTrail';
    this.item.command = 'haritrail.openMap';
    this.disposables.push(this.item, hub.onDidChange(() => this.update()), hub.onDidSwitchSession(() => this.update()));
    // Keep the live timer ticking.
    this.ticker = setInterval(() => {
      const c = this.hub.model.current;
      if (c && this.hub.model.isLive(c)) {
        this.update();
      }
    }, 1000);
    this.update();
  }

  update(): void {
    if (!cfg().get<boolean>('statusBar.enabled', true)) {
      this.item.hide();
      return;
    }
    const m = this.hub.model;
    const session = this.hub.controller.session;
    if (!session) {
      this.item.text = '$(compass) HariTrail';
      this.item.tooltip = 'HariTrail: no Claude Code session for this workspace yet. Send a prompt from the Claude Code chat panel, or run `claude` in a terminal here.';
      this.item.backgroundColor = undefined;
      this.item.show();
      return;
    }
    const exp = m.current;
    if (!exp) {
      this.item.text = '$(compass) HariTrail · waiting';
      this.item.tooltip = 'Session found. Waiting for the first prompt.';
      this.item.show();
      return;
    }
    const live = m.isLive(exp);
    const steps = m.flatSteps(exp);
    if (live) {
      const running = [...steps].reverse().find((s) => s.status === 'running');
      const last = running ?? steps[steps.length - 1];
      const doing = last ? `${running ? verbIng(last.verb) : last.verb} ${oneLine(last.title, 32)}` : 'thinking...';
      this.item.text = `$(pulse) Claude · ${doing} · #${last?.label ?? 0}`;
      this.item.tooltip = new vscode.MarkdownString(
        `**HariTrail: live**\n\nPrompt #${exp.index}: ${escapeMd(oneLine(exp.prompt, 120))}\n\n${steps.length} moves · ${formatDuration(Date.now() - exp.startedAt)}\n\nClick to open the Trail Map.`,
      );
    } else {
      const st = statsFor(m, [exp]);
      this.item.text = `$(compass) HariTrail · ${st.steps} moves · ${st.filesEdited + st.filesCreated} changed`;
      this.item.tooltip = new vscode.MarkdownString(
        `**HariTrail**\n\nLast prompt #${exp.index}: ${escapeMd(oneLine(exp.prompt, 120))}\n\n` +
          `${st.filesRead} read · ${st.filesEdited} edited · ${st.filesCreated} created · ${st.commands} commands` +
          (st.testsPassed + st.testsFailed ? ` · tests ${st.testsPassed}✓ ${st.testsFailed}✗` : '') +
          `\n\nClick to open the Trail Map.`,
      );
    }
    this.item.show();
  }

  dispose(): void {
    clearInterval(this.ticker);
    this.disposables.forEach((d) => d.dispose());
  }
}

function escapeMd(t: string): string {
  return t.replace(/([\\`*_{}[\]<>|#])/g, '\\$1');
}

function verbIng(verb: string): string {
  const map: Record<string, string> = {
    Read: 'Reading',
    Edited: 'Editing',
    Created: 'Creating',
    Rewrote: 'Rewriting',
    Searched: 'Searching',
    Listed: 'Listing',
    Ran: 'Running',
    Tested: 'Testing',
    Built: 'Building',
    Git: 'Git',
    Installed: 'Installing',
    Delegated: 'Delegating',
    Fetched: 'Fetching',
    'Searched web': 'Searching web',
    Planned: 'Planning',
    Called: 'Calling',
    'Asked you': 'Asking you',
    'Used skill': 'Using skill',
  };
  return map[verb] ?? verb;
}
