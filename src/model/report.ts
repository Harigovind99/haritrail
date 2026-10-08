import { oneLine } from './describe';
import { SessionModel } from './session';
import { fileTouches, insightsFor, phaseRuns, statsFor, stationFor, STATIONS } from './trail';
import { Expedition, Step } from './types';

function dur(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function mdEscape(text: string): string {
  return text.replace(/([\\`*_{}[\]<>|])/g, '\\$1');
}

function quote(text: string): string {
  return text
    .split('\n')
    .map((l) => '> ' + l)
    .join('\n');
}

function mermaidLabel(text: string): string {
  return text.replace(/["\n\r]/g, ' ').replace(/[[\]{}()<>|#;]/g, ' ').slice(0, 40).trim() || 'step';
}

/** Mermaid flowchart of the path: one node per file/station, numbered arrows in order. */
function mermaid(steps: Step[], rel: (p: string) => string): string {
  const ids = new Map<string, string>();
  const lines: string[] = ['flowchart LR'];
  const nodeOf = (s: Step) => {
    const key = s.filePath ? 'f:' + s.filePath : 's:' + stationFor(s.kind);
    let id = ids.get(key);
    if (!id) {
      id = 'n' + ids.size;
      ids.set(key, id);
      const label = s.filePath ? rel(s.filePath) : STATIONS[stationFor(s.kind)];
      lines.push(s.filePath ? `  ${id}["${mermaidLabel(label)}"]` : `  ${id}(("${mermaidLabel(label)}"))`);
    }
    return id;
  };
  const shown = steps.slice(0, 60);
  let prev: string | undefined;
  shown.forEach((s) => {
    const id = nodeOf(s);
    if (prev && prev !== id) {
      lines.push(`  ${prev} -->|${s.label}| ${id}`);
    }
    prev = id;
  });
  if (steps.length > shown.length) {
    lines.push(`  %% ${steps.length - shown.length} more moves not drawn`);
  }
  return lines.join('\n');
}

export function buildReport(model: SessionModel, exps: Expedition[], rel: (p: string) => string): string {
  const out: string[] = [];
  const title = exps.length === 1 ? `Prompt #${exps[0].index}` : `${exps.length} prompts`;
  out.push(`# HariTrail journey: ${mdEscape(oneLine(model.title ?? 'Claude Code session', 80))}`);
  out.push('');
  out.push(`_${title}${model.gitBranch ? ` · branch \`${model.gitBranch}\`` : ''} · generated ${new Date().toLocaleString()}_`);
  out.push('');
  for (const exp of exps) {
    const steps = model.flatSteps(exp);
    const st = statsFor(model, [exp]);
    out.push(`## ${exp.index}. ${mdEscape(oneLine(exp.prompt, 100))}`);
    out.push('');
    out.push(quote(exp.prompt.slice(0, 3000)));
    out.push('');
    out.push(
      `**${st.steps} moves**${st.subagentSteps ? ` (+${st.subagentSteps} by subagents)` : ''} · ` +
        `${st.filesRead} read · ${st.filesEdited} edited · ${st.filesCreated} created · ${st.commands} commands · ` +
        `+${st.linesAdded} -${st.linesRemoved} lines · ${dur((exp.endedAt ?? exp.lastActivity) - exp.startedAt)}` +
        (exp.source ? ` · sent from the ${exp.source}` : '') +
        (exp.interrupted ? ' · **interrupted**' : ''),
    );
    out.push('');
    const runs = phaseRuns(steps);
    if (runs.length) {
      const names: Record<string, string> = { explore: 'Explore', change: 'Change', verify: 'Verify', other: 'Other' };
      out.push(`**Shape:** ${runs.map((r) => `${names[r.phase]} (${r.to - r.from + 1})`).join(' > ')}`);
      out.push('');
    }
    const insights = insightsFor(steps, rel);
    if (insights.length) {
      out.push('### What stood out');
      out.push('');
      for (const i of insights) {
        out.push(`- ${mdEscape(i.text)}`);
      }
      out.push('');
    }
    if (steps.length) {
      out.push('### The path');
      out.push('');
      out.push('```mermaid');
      out.push(mermaid(steps, rel));
      out.push('```');
      out.push('');
      out.push('### Step by step');
      out.push('');
      for (const s of steps) {
        const target = s.filePath ? `\`${rel(s.filePath)}\`` : mdEscape(s.title);
        const flags = [
          s.kind === 'edit' || s.kind === 'create' ? `+${s.added ?? 0} -${s.removed ?? 0}` : '',
          s.outcome ? (s.outcome === 'pass' ? 'passing' : 'failing') : '',
          s.status === 'error' ? 'error' : s.status === 'interrupted' ? 'stopped' : '',
          s.afterFailure ? 'after a failing check' : s.revisitOf ? `back from #${s.revisitOf}` : '',
        ].filter(Boolean);
        const indent = s.parentStepId ? '    ' : '';
        out.push(`${indent}${s.parentStepId ? '-' : '1.'} **#${s.label} ${s.verb}** ${target}${flags.length ? ` _(${flags.join(', ')})_` : ''}`);
        if (s.narration) {
          out.push(`${indent}   ${mdEscape(oneLine(s.narration, 240))}`);
        }
        if (typeof s.input.command === 'string') {
          out.push(`${indent}   \`${oneLine(String(s.input.command), 160).replace(/`/g, "'")}\``);
        }
      }
      out.push('');
      const touches = [...fileTouches(steps).values()].sort((a, b) => a.firstAt - b.firstAt);
      if (touches.length) {
        out.push('### Files touched');
        out.push('');
        out.push('| File | Read | Changed | Lines |');
        out.push('| --- | ---: | ---: | --- |');
        for (const ft of touches) {
          out.push(`| \`${rel(ft.path)}\`${ft.created ? ' (new)' : ''} | ${ft.reads} | ${ft.edits} | +${ft.added} -${ft.removed} |`);
        }
        out.push('');
      }
    }
    if (exp.interjections.length) {
      out.push('### You steered mid-run');
      out.push('');
      for (const i of exp.interjections) {
        out.push(`- ${mdEscape(oneLine(i.text, 200))}`);
      }
      out.push('');
    }
    if (exp.done && !exp.interrupted && exp.finalText) {
      out.push('### Final answer');
      out.push('');
      out.push(quote(exp.finalText.slice(0, 4000)));
      out.push('');
    }
  }
  return out.join('\n');
}
