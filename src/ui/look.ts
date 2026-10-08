import * as vscode from 'vscode';
import { Step, StepKind } from '../model/types';

const ICONS: Record<StepKind, string> = {
  read: 'eye',
  edit: 'edit',
  create: 'new-file',
  search: 'search',
  run: 'terminal',
  test: 'beaker',
  build: 'tools',
  git: 'git-commit',
  install: 'package',
  delegate: 'organization',
  web: 'globe',
  plan: 'checklist',
  mcp: 'plug',
  ask: 'comment-discussion',
  skill: 'sparkle',
  other: 'symbol-event',
};

/** Theme colors contributed in package.json, so every theme can restyle them. */
const COLORS: Record<StepKind, string> = {
  read: 'haritrail.read',
  edit: 'haritrail.edit',
  create: 'haritrail.create',
  search: 'haritrail.search',
  run: 'haritrail.run',
  test: 'haritrail.run',
  build: 'haritrail.run',
  git: 'haritrail.run',
  install: 'haritrail.run',
  delegate: 'haritrail.delegate',
  web: 'haritrail.search',
  plan: 'haritrail.plan',
  mcp: 'haritrail.delegate',
  ask: 'haritrail.plan',
  skill: 'haritrail.delegate',
  other: 'haritrail.plan',
};

export function kindIcon(kind: StepKind): string {
  return ICONS[kind];
}

export function stepIcon(step: Step): vscode.ThemeIcon {
  if (step.status === 'running') {
    return new vscode.ThemeIcon('loading~spin', new vscode.ThemeColor(COLORS[step.kind]));
  }
  if (step.kind === 'test' && step.outcome) {
    return step.outcome === 'pass'
      ? new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'))
      : new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
  }
  if (step.status === 'error') {
    return new vscode.ThemeIcon(ICONS[step.kind], new vscode.ThemeColor('haritrail.error'));
  }
  if (step.status === 'interrupted') {
    return new vscode.ThemeIcon('debug-pause', new vscode.ThemeColor('disabledForeground'));
  }
  return new vscode.ThemeIcon(ICONS[step.kind], new vscode.ThemeColor(COLORS[step.kind]));
}
