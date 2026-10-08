'use strict';
// Run with: npm test   (compiles, then runs node --test on this folder)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const out = path.join(__dirname, '..', 'out');
const { SessionModel, cleanPrompt } = require(path.join(out, 'model/session'));
const { buildTrailPayload, statsFor, insightsFor, phaseRuns } = require(path.join(out, 'model/trail'));
const { buildReport } = require(path.join(out, 'model/report'));
const { diffSides } = require(path.join(out, 'model/diff'));
const { classifyCommand, rangesFromPatch, guessTestOutcome, describeTool } = require(path.join(out, 'model/describe'));
const { JsonlTailer } = require(path.join(out, 'live/tailer'));
const { SessionLocator, SubagentFinder, encodeProjectPath } = require(path.join(out, 'live/locator'));
const { LiveController } = require(path.join(out, 'live/controller'));
const { generate } = require('./fixtures/generate');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'haritrail-'));
}

function readJsonl(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function loadFixture() {
  const home = tmp();
  const ws = path.join(tmp(), 'demo-app');
  fs.mkdirSync(ws, { recursive: true });
  const g = generate(home, ws);
  const m = new SessionModel();
  m.ingest(readJsonl(g.file));
  m.ingestSubagent('file:' + g.subFile, readJsonl(g.subFile));
  return { m, g, ws, home };
}

test('prompts and moves are reconstructed in order', () => {
  const { m } = loadFixture();
  assert.equal(m.expeditions.length, 2);
  const [e1, e2] = m.expeditions;
  assert.equal(e1.prompt, 'The login form accepts empty passwords. Fix it and add a test');
  assert.deepEqual(
    e1.steps.map((s) => s.tool),
    ['Grep', 'Read', 'Read', 'Glob', 'Read', 'Edit', 'Edit', 'Bash', 'Read', 'Edit', 'Bash', 'Task', 'Write', 'TodoWrite'],
  );
  assert.equal(e1.done, true);
  assert.equal(e1.interrupted, false);
  assert.match(e1.finalText, /rejects empty/);
  assert.equal(e1.interjections.length, 1);
  assert.equal(e1.interjections[0].text, 'also make sure the error message is friendly');
  assert.ok(e1.outputTokens > 0);
  assert.equal(e1.steps[0].narration, "I'll start by finding where the password is validated.");
  assert.match(e1.steps[0].thinking, /find where passwords/);
  assert.equal(e2.prompt, '/review login.ts');
});

test('fix loops, revisits and test outcomes are detected', () => {
  const { m } = loadFixture();
  const s = m.expeditions[0].steps;
  assert.equal(s[7].kind, 'test');
  assert.equal(s[7].status, 'error');
  assert.equal(s[7].outcome, 'fail');
  assert.equal(s[8].revisitOf, '2', 'reading validate.ts again is a revisit of #2');
  assert.equal(s[9].afterFailure, true, 'edit right after a failing test is a fix loop');
  assert.ok(!s[6].afterFailure, 'no check ran before #7');
  assert.equal(s[10].outcome, 'pass');
  assert.equal(s[12].kind, 'create');
  assert.equal(s[4].readRange.start, 1);
  assert.equal(s[4].readRange.end, 30);
});

test('edits carry exact line ranges and full-file diffs', () => {
  const { m } = loadFixture();
  const edit = m.expeditions[0].steps[5];
  assert.deepEqual(edit.ranges, [{ start: 2, end: 4 }]);
  assert.equal(edit.added, 3);
  assert.equal(edit.removed, 0);
  const d = diffSides(edit);
  assert.equal(d.full, true);
  assert.match(d.after, /pw\.trim\(\) === ''/);
  assert.doesNotMatch(d.before, /trim/);
  const snippet = diffSides(m.expeditions[0].steps[6]);
  assert.equal(snippet.full, false);
});

test('subagent moves attach under the Task that launched them', () => {
  const { m } = loadFixture();
  const task = m.expeditions[0].steps[11];
  assert.equal(task.kind, 'delegate');
  assert.deepEqual(
    task.children.map((c) => c.label),
    ['12.1', '12.2', '12.3'],
  );
  assert.equal(task.children[1].tool, 'Read');
  assert.equal(task.children[1].expeditionId, m.expeditions[0].id);
  assert.equal(m.flatSteps(m.expeditions[0]).length, 17);
});

test('interruptions close the prompt and stop running moves', () => {
  const { m } = loadFixture();
  const e2 = m.expeditions[1];
  assert.equal(e2.interrupted, true);
  assert.equal(e2.done, true);
  assert.equal(e2.steps[1].status, 'interrupted');
  assert.equal(e2.steps[1].kind, 'build');
});

test('stats, phases, insights and report', () => {
  const { m } = loadFixture();
  const e1 = m.expeditions[0];
  const st = statsFor(m, [e1]);
  assert.equal(st.filesCreated, 1);
  assert.equal(st.filesEdited, 2);
  assert.equal(st.testsFailed, 1);
  assert.equal(st.testsPassed, 1);
  assert.equal(st.loopBacks, 1);
  assert.equal(st.subagentSteps, 3);
  const runs = phaseRuns(m.flatSteps(e1)).map((r) => r.phase);
  assert.deepEqual(runs.slice(0, 4), ['explore', 'change', 'verify', 'explore']);
  const rel = (p) => path.basename(p);
  const ins = insightsFor(m.flatSteps(e1), rel).map((i) => i.text);
  assert.ok(ins.some((t) => t.startsWith('Fix loop on validate.ts')), ins.join('\n'));
  assert.ok(ins.some((t) => t.includes('✗ ✓')), ins.join('\n'));
  assert.ok(ins.some((t) => t.startsWith('Scouted first')));
  const report = buildReport(m, [e1], rel);
  assert.match(report, /```mermaid/);
  assert.match(report, /#10 Edited/);
  assert.match(report, /You steered mid-run/);
  const payload = buildTrailPayload(m, e1.id, rel, () => 'src');
  assert.equal(payload.steps.length, 17);
  assert.ok(payload.nodes.some((n) => n.id === 'station:terminal'));
  assert.equal(payload.nodes.find((n) => n.label === 'SECURITY.md').status, 'created');
  const session = buildTrailPayload(m, 'session', rel, () => 'src');
  assert.equal(session.steps.length, 19);
});

test('ingesting the same records twice changes nothing', () => {
  const { m, g } = loadFixture();
  const before = m.flatSteps(m.expeditions[0]).length;
  m.ingest(readJsonl(g.file));
  m.ingestSubagent('file:' + g.subFile, readJsonl(g.subFile));
  assert.equal(m.expeditions.length, 2);
  assert.equal(m.flatSteps(m.expeditions[0]).length, before);
});

test('records arriving one by one give the same result as all at once', () => {
  const { g } = loadFixture();
  const m = new SessionModel();
  for (const r of readJsonl(g.file)) m.ingest([r]);
  for (const r of readJsonl(g.subFile)) m.ingestSubagent('file:' + g.subFile, [r]);
  assert.equal(m.expeditions[0].steps[11].children.length, 3);
  assert.equal(m.expeditions[0].steps[9].afterFailure, true);
});

test('prompt cleaning', () => {
  assert.equal(cleanPrompt('<system-reminder>x</system-reminder>hello').text, 'hello');
  assert.equal(cleanPrompt('[Request interrupted by user]').kind, 'interrupt');
  assert.equal(cleanPrompt('<local-command-stdout>ok</local-command-stdout>').kind, 'skip');
  assert.equal(cleanPrompt('<command-name>/clear</command-name><command-args></command-args>').text, '/clear');
});

test('command classification', () => {
  assert.equal(classifyCommand('npm test'), 'test');
  assert.equal(classifyCommand('cd app && npx vitest run'), 'test');
  assert.equal(classifyCommand('pytest -q tests/'), 'test');
  assert.equal(classifyCommand('go test ./...'), 'test');
  assert.equal(classifyCommand('npm install zod'), 'install');
  assert.equal(classifyCommand('npx tsc --noEmit'), 'build');
  assert.equal(classifyCommand('git status'), 'git');
  assert.equal(classifyCommand('ls -la'), 'run');
  assert.equal(guessTestOutcome('Tests: 12 passed, 12 total', false), 'pass');
  assert.equal(guessTestOutcome('2 failed, 10 passed', false), 'fail');
  assert.equal(guessTestOutcome('0 failed, 10 passed', false), 'pass');
  assert.equal(describeTool('mcp__github__create_issue', {}).title, 'github · create_issue');
  assert.equal(describeTool('Read', { file_path: 'src/a.ts' }, '/w').filePath, path.normalize('/w/src/a.ts'));
});

test('patch ranges handle pure deletions', () => {
  const r = rangesFromPatch([{ oldStart: 5, oldLines: 3, newStart: 5, newLines: 2, lines: [' a', '-b', ' c'] }]);
  assert.equal(r.removed, 1);
  assert.equal(r.added, 0);
  assert.deepEqual(r.ranges, [{ start: 5, end: 5, deletionOnly: true }]);
});

test('tailer reads only complete lines and detects rewrites', async () => {
  const dir = tmp();
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, '{"a":1}\n{"b":');
  const t = new JsonlTailer(file);
  assert.deepEqual(await t.poll(), [{ a: 1 }]);
  assert.equal(await t.poll(), null);
  fs.appendFileSync(file, '2}\n{"c":"é✓"}\n');
  assert.deepEqual(await t.poll(), [{ b: 2 }, { c: 'é✓' }]);
  fs.writeFileSync(file, '{"z":0}\n');
  assert.equal(await t.poll(), 'reset');
  assert.deepEqual(await t.poll(), [{ z: 0 }]);
});

test('tailer survives a multi-byte character split across reads', async () => {
  const dir = tmp();
  const file = path.join(dir, 's.jsonl');
  const line = Buffer.from('{"t":"héllo"}\n');
  const cut = line.indexOf(0xc3) + 1; // in the middle of "é"
  fs.writeFileSync(file, line.subarray(0, cut));
  const t = new JsonlTailer(file);
  assert.equal(await t.poll(), null);
  fs.appendFileSync(file, line.subarray(cut));
  assert.deepEqual(await t.poll(), [{ t: 'héllo' }]);
});

test('locator finds sessions by folder name and by recorded cwd', async () => {
  const home = tmp();
  const ws = path.join(tmp(), 'my.app');
  fs.mkdirSync(path.join(ws, 'packages', 'api'), { recursive: true });
  generate(home, ws, { sessionId: 'aaaa' });
  // A session started in a sub-folder of the workspace.
  generate(home, path.join(ws, 'packages', 'api'), { sessionId: 'bbbb', start: Date.parse('2026-10-08T10:00:00Z') });
  const loc = new SessionLocator(home, [ws]);
  const dirs = await loc.projectDirs();
  assert.equal(dirs.length, 2, dirs.join(','));
  assert.ok(dirs.some((d) => path.basename(d) === encodeProjectPath(ws)));
  const sessions = await loc.listSessions();
  assert.deepEqual(sessions.map((s) => s.id).sort(), ['aaaa', 'bbbb']);
  const other = new SessionLocator(home, [path.join(tmp(), 'unrelated')]);
  assert.equal((await other.projectDirs()).length, 0);
  const subs = await new SubagentFinder().find(sessions.find((s) => s.id === 'aaaa').file, 'aaaa');
  assert.equal(subs.length, 1);
});

test('live controller follows a session as it is written', async () => {
  const home = tmp();
  const ws = path.join(tmp(), 'live-app');
  fs.mkdirSync(ws, { recursive: true });
  const g = generate(home, ws);
  const c = new LiveController({ home, workspaceFolders: [ws], pollMs: 150 });
  let changes = 0;
  c.on('change', () => changes++);
  c.start();
  try {
    await waitFor(() => c.model.expeditions.length === 2 && c.model.expeditions[0].steps[11].children.length === 3);
    // Append a new prompt and a move, like Claude Code would.
    const rec = (o) => JSON.stringify({ sessionId: g.sessionId, cwd: ws, isSidechain: false, ...o }) + '\n';
    fs.appendFileSync(g.file, rec({ type: 'user', uuid: 'n1', timestamp: new Date().toISOString(), message: { role: 'user', content: 'add a README' } }));
    await waitFor(() => c.model.expeditions.length === 3);
    fs.appendFileSync(
      g.file,
      rec({
        type: 'assistant',
        uuid: 'n2',
        timestamp: new Date().toISOString(),
        message: { id: 'm-new', role: 'assistant', content: [{ type: 'tool_use', id: 'tu-new', name: 'Write', input: { file_path: path.join(ws, 'README.md'), content: '# hi\n' } }] },
      }),
    );
    await waitFor(() => c.model.expeditions[2].steps.length === 1);
    const exp = c.model.expeditions[2];
    assert.equal(c.model.isLive(exp), true);
    assert.equal(exp.steps[0].status, 'running');
    assert.ok(changes >= 2);
    // A brand-new session in the same workspace is followed automatically.
    generate(home, ws, { sessionId: 'second-session' });
    await waitFor(() => c.session && c.session.id === 'second-session', 5000);
  } finally {
    c.dispose();
  }
});

test('real Claude Code transcripts on this machine parse without errors', () => {
  const root = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(root)) return;
  let files = 0;
  for (const d of fs.readdirSync(root)) {
    const dir = path.join(root, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const m = new SessionModel();
      m.ingest(readJsonl(path.join(dir, f)));
      for (const e of m.expeditions) {
        buildTrailPayload(m, e.id, (p) => p, () => 'x');
        buildReport(m, [e], (p) => p);
      }
      files++;
    }
  }
  assert.ok(files >= 0);
});

function waitFor(cond, ms = 4000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      let ok = false;
      try {
        ok = !!cond();
      } catch (_) {
        ok = false;
      }
      if (ok) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - start > ms) {
        clearInterval(iv);
        reject(new Error('timed out waiting'));
      }
    }, 50);
  });
}

test('narration before a move is not mistaken for the final answer', () => {
  const { m } = loadFixture();
  assert.equal(m.expeditions[1].finalText, undefined);
  assert.match(m.expeditions[0].finalText, /^Fixed:/);
});

test('sessions from the VS Code chat panel: editor context and automatic messages', () => {
  const ws = '/w/panel-app';
  const base = { sessionId: 's-panel', cwd: ws, isSidechain: false, entrypoint: 'claude-vscode', version: '2.1.293' };
  let n = 0;
  const at = (s) => new Date(Date.parse('2026-10-08T09:00:00Z') + s * 1000).toISOString();
  const rec = (o) => ({ ...base, uuid: 'v' + ++n, ...o });
  const records = [
    rec({ type: 'attachment', timestamp: at(0), attachment: { type: 'opened_file_in_ide', filename: ws + '/src/app.ts' } }),
    rec({
      type: 'user',
      timestamp: at(1),
      origin: { kind: 'human' },
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '<ide_opened_file>The user opened the file /w/panel-app/src/app.ts in the IDE. This may or may not be related to the current task.</ide_opened_file>' },
          { type: 'text', text: 'rename getUser to fetchUser' },
        ],
      },
    }),
    rec({ type: 'user', timestamp: at(1), isMeta: true, message: { role: 'user', content: 'The user selected the lines 3 to 9 from /w/panel-app/src/app.ts:' } }),
    rec({ type: 'assistant', timestamp: at(2), message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm run build', run_in_background: true } }] } }),
    rec({ type: 'user', timestamp: at(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Command running in background with ID: b1' }] } }),
    rec({ type: 'assistant', timestamp: at(4), message: { id: 'm2', role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: ws + '/src/app.ts', old_string: 'getUser(', new_string: 'fetchUser(' } }] } }),
    rec({ type: 'user', timestamp: at(5), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'The file has been updated.' }] } }),
    // Claude Code tells the agent the background build finished. Not something the person typed.
    rec({ type: 'user', timestamp: at(6), origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>' } }),
    rec({ type: 'attachment', timestamp: at(6), attachment: { type: 'queued_command', prompt: '<task-notification>done</task-notification>', origin: { kind: 'task-notification' } } }),
    // Older versions write the same notice without an origin.
    rec({ type: 'user', timestamp: at(7), message: { role: 'user', content: '<task-notification><status>completed</status></task-notification>' } }),
    rec({ type: 'assistant', timestamp: at(8), message: { id: 'm3', role: 'assistant', content: [{ type: 'tool_use', id: 't3', name: 'Read', input: { file_path: ws + '/src/app.ts' } }] } }),
    rec({ type: 'user', timestamp: at(9), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', content: '...' }] } }),
    rec({ type: 'attachment', timestamp: at(9), attachment: { type: 'queued_command', prompt: 'keep the old name as an alias', origin: { kind: 'human' } } }),
    rec({ type: 'assistant', timestamp: at(10), message: { id: 'm4', role: 'assistant', content: [{ type: 'text', text: 'Renamed.' }], stop_reason: 'end_turn' } }),
  ];
  const m = new SessionModel();
  m.ingest(records);
  assert.equal(m.expeditions.length, 1, m.expeditions.map((e) => e.prompt).join(' | '));
  const e = m.expeditions[0];
  assert.equal(e.prompt, 'rename getUser to fetchUser');
  assert.equal(e.source, 'VS Code chat panel');
  assert.deepEqual(
    e.steps.map((s) => s.tool),
    ['Bash', 'Edit', 'Read'],
  );
  assert.deepEqual(
    e.interjections.map((i) => i.text),
    ['keep the old name as an alias'],
  );
  assert.equal(e.done, true);
  assert.equal(e.finalText, 'Renamed.');
});

test('terminal sessions are labelled as such', () => {
  const { m } = loadFixture();
  assert.equal(m.expeditions[0].source, 'terminal');
});
