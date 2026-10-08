import * as vscode from 'vscode';
import { buildTrailPayload } from '../model/trail';
import { Hub } from './hub';

type FromWebview =
  | { type: 'ready' }
  | { type: 'scope'; scope: string }
  | { type: 'openStep'; id: string }
  | { type: 'diff'; id: string }
  | { type: 'output'; id: string }
  | { type: 'reveal'; id: string }
  | { type: 'replayStep'; id: string }
  | { type: 'export' };

/**
 * The Trail Map: an editor tab that draws the journey as a map of your codebase
 * (files clustered by folder, the path between them) or as lanes over time, with
 * replay, phases and insights.
 */
export class TrailMapPanel implements vscode.Disposable {
  static readonly viewType = 'haritrail.map';
  private static current?: TrailMapPanel;

  private readonly disposables: vscode.Disposable[] = [];
  /** 'follow' = always the focused/latest prompt; otherwise an expedition id or 'session'. */
  private scope = 'follow';
  private ready = false;
  private timer?: NodeJS.Timeout;
  private lastSentKey = '';
  private disposed = false;

  static show(context: vscode.ExtensionContext, hub: Hub, opts?: { stepId?: string; scope?: string }): TrailMapPanel {
    if (TrailMapPanel.current) {
      TrailMapPanel.current.panel.reveal(TrailMapPanel.current.panel.viewColumn ?? vscode.ViewColumn.Active, false);
    } else {
      const panel = vscode.window.createWebviewPanel(TrailMapPanel.viewType, 'Trail Map', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      });
      TrailMapPanel.current = new TrailMapPanel(panel, context, hub);
    }
    const p = TrailMapPanel.current;
    if (opts?.scope) {
      p.scope = opts.scope;
    }
    p.push(true);
    if (opts?.stepId) {
      void p.panel.webview.postMessage({ type: 'select', id: opts.stepId });
    }
    return p;
  }

  static revive(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, hub: Hub): void {
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] };
    TrailMapPanel.current = new TrailMapPanel(panel, context, hub);
  }

  static get isOpen(): boolean {
    return !!TrailMapPanel.current;
  }

  private constructor(
    readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly hub: Hub,
  ) {
    panel.iconPath = {
      light: vscode.Uri.joinPath(context.extensionUri, 'media', 'map-light.svg'),
      dark: vscode.Uri.joinPath(context.extensionUri, 'media', 'map-dark.svg'),
    };
    panel.webview.html = this.html();
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m)),
      hub.onDidChange(() => this.push(false)),
      hub.onDidSwitchSession(() => {
        if (this.scope !== 'session') {
          this.scope = 'follow';
        }
        this.push(true);
      }),
    );
  }

  private onMessage(m: FromWebview): void {
    switch (m.type) {
      case 'ready':
        this.ready = true;
        this.push(true);
        break;
      case 'scope':
        if (m.scope === 'follow' || m.scope === 'session') {
          this.scope = m.scope;
        } else {
          this.scope = m.scope;
          this.hub.focus(m.scope);
        }
        this.push(true);
        break;
      case 'openStep':
        void vscode.commands.executeCommand('haritrail.openStep', m.id);
        break;
      case 'diff':
        void vscode.commands.executeCommand('haritrail.showDiff', m.id);
        break;
      case 'output':
        void vscode.commands.executeCommand('haritrail.showOutput', m.id);
        break;
      case 'reveal':
        void vscode.commands.executeCommand('haritrail.revealStep', m.id);
        break;
      case 'replayStep':
        void vscode.commands.executeCommand('haritrail.openStep', m.id, { preserveFocus: true, quiet: true });
        break;
      case 'export':
        void vscode.commands.executeCommand('haritrail.exportReport');
        break;
    }
  }

  /** Send fresh data to the page (throttled while Claude is streaming moves). */
  push(immediate: boolean): void {
    if (!this.ready) {
      return;
    }
    if (this.timer) {
      if (!immediate) {
        return;
      }
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.send();
      },
      immediate ? 0 : 200,
    );
  }

  private send(): void {
    const m = this.hub.model;
    const scope = this.scope === 'follow' ? this.hub.focused?.id ?? 'session' : this.scope === 'session' ? 'session' : m.getExpedition(this.scope) ? this.scope : 'session';
    const key = `${m.revision}|${scope}|${this.scope}|${this.hub.controller.session?.file}`;
    const payload = buildTrailPayload(
      m,
      scope,
      (p) => this.hub.rel(p),
      (p) => this.hub.groupOf(p),
    );
    const live = payload.live;
    // Re-send while live even without new records so durations keep ticking.
    if (key === this.lastSentKey && !live) {
      return;
    }
    this.lastSentKey = key;
    this.panel.title = payload.prompt ? `Trail Map · #${m.getExpedition(scope)?.index ?? ''}` : 'Trail Map · session';
    void this.panel.webview.postMessage({
      type: 'data',
      follow: this.scope === 'follow',
      hasSession: !!this.hub.controller.session,
      payload,
    });
  }

  private html(): string {
    const w = this.panel.webview;
    const media = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', f));
    const nonce = [...Array(32)].map(() => Math.floor(Math.random() * 36).toString(36)).join('');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${w.cspSource} data:; style-src ${w.cspSource}; font-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${media('trail.css')}" rel="stylesheet">
<title>Trail Map</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${media('trail.js')}"></script>
</body>
</html>`;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    TrailMapPanel.current = undefined;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.disposables.forEach((d) => d.dispose());
    this.panel.dispose();
  }
}
