// Builds a realistic Claude Code transcript (same record shapes Claude Code writes)
// for tests and demos: exploration, an edit, a failing test, a fix loop, a subagent,
// a new file, a mid-run message from the user, and an interrupted second prompt.
'use strict';
const fs = require('fs');
const path = require('path');

function encode(p) {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

function generate(claudeHome, workspace, opts = {}) {
  const sid = opts.sessionId || '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const dir = path.join(claudeHome, 'projects', encode(workspace));
  fs.mkdirSync(path.join(dir, sid, 'subagents'), { recursive: true });
  const t0 = opts.start || Date.parse('2026-10-07T10:00:00Z');
  let t = t0;
  let n = 0;
  const lines = [];
  const sub = [];
  let parent = null;
  const at = (dt) => new Date((t += dt)).toISOString();
  const base = (extra) => ({
    parentUuid: parent,
    isSidechain: false,
    userType: 'external',
    cwd: workspace,
    sessionId: sid,
    version: '2.1.0',
    gitBranch: 'main',
    entrypoint: opts.entrypoint || 'cli',
    ...extra,
  });
  const push = (rec, into = lines) => {
    rec.uuid = rec.uuid || `u-${++n}`;
    into.push(rec);
    if (into === lines) parent = rec.uuid;
    return rec;
  };
  const f = (rel) => path.join(workspace, rel);

  const prompt = (text, dt = 1000) =>
    push(base({ type: 'user', promptId: `p-${n}`, timestamp: at(dt), message: { role: 'user', content: text } }));
  let msg = 0;
  const assistant = (content, stop = 'tool_use', dt = 1500, into = lines, sideExtra = {}) =>
    push(
      {
        ...base(sideExtra),
        type: 'assistant',
        timestamp: at(dt),
        message: {
          id: `msg_${++msg}`,
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          content,
          stop_reason: stop,
          usage: { input_tokens: 1000, output_tokens: 120 },
        },
      },
      into,
    );
  let tu = 0;
  const tool = (name, input, text, toolUseResult, opt = {}) => {
    const id = `toolu_${String(++tu).padStart(3, '0')}`;
    const content = [];
    if (opt.thinking) content.push({ type: 'thinking', thinking: opt.thinking });
    if (opt.say) content.push({ type: 'text', text: opt.say });
    content.push({ type: 'tool_use', id, name, input });
    assistant(content, 'tool_use', opt.dt || 1500, opt.into || lines, opt.side || {});
    push(
      {
        ...base(opt.side || {}),
        type: 'user',
        timestamp: at(opt.run || 400),
        message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: text, is_error: opt.error || undefined }] },
        toolUseResult,
      },
      opt.into || lines,
    );
    return id;
  };

  const validateOld = "export function validatePassword(pw: string): boolean {\n  return pw.length <= 128;\n}\n";
  const validateNew1 = "export function validatePassword(pw: string): boolean {\n  if (pw.trim() === '') {\n    return false;\n  }\n  return pw.length <= 128;\n}\n";

  // ---- prompt 1
  prompt('The login form accepts empty passwords. Fix it and add a test');
  push(base({ type: 'attachment', timestamp: at(5), attachment: { type: 'date', content: 'today' } }));
  tool('Grep', { pattern: 'validatePassword', output_mode: 'files_with_matches' }, 'Found 2 files\nsrc/auth/validate.ts\nsrc/auth/login.ts', { mode: 'files_with_matches', numFiles: 2, filenames: ['src/auth/validate.ts', 'src/auth/login.ts'] }, {
    thinking: 'Need to find where passwords are validated before changing anything.',
    say: "I'll start by finding where the password is validated.",
  });
  tool('Read', { file_path: f('src/auth/validate.ts') }, '     1\texport function validatePassword', { type: 'text', file: { filePath: f('src/auth/validate.ts'), content: validateOld, numLines: 3, startLine: 1, totalLines: 3 } });
  tool('Read', { file_path: f('src/auth/login.ts') }, '     1\timport { validatePassword }', { type: 'text', file: { filePath: f('src/auth/login.ts'), content: '...', numLines: 40, startLine: 1, totalLines: 40 } });
  tool('Glob', { pattern: '**/*.test.ts' }, 'tests/auth/login.test.ts', { filenames: ['tests/auth/login.test.ts'], numFiles: 1 });
  tool('Read', { file_path: f('tests/auth/login.test.ts'), offset: 1, limit: 30 }, '     1\tdescribe(', { type: 'text', file: { filePath: f('tests/auth/login.test.ts'), content: '...', numLines: 30, startLine: 1, totalLines: 52 } });
  tool(
    'Edit',
    { file_path: f('src/auth/validate.ts'), old_string: '  return pw.length <= 128;', new_string: "  if (pw.trim() === '') {\n    return false;\n  }\n  return pw.length <= 128;" },
    'The file has been updated.',
    {
      filePath: f('src/auth/validate.ts'),
      oldString: '  return pw.length <= 128;',
      newString: "  if (pw.trim() === '') {\n    return false;\n  }\n  return pw.length <= 128;",
      originalFile: validateOld,
      structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 6, lines: [' export function validatePassword(pw: string): boolean {', "+  if (pw.trim() === '') {", '+    return false;', '+  }', '   return pw.length <= 128;', ' }'] }],
      userModified: false,
      replaceAll: false,
    },
    { say: 'The validator never rejects an empty string. Adding that check.' },
  );
  tool(
    'Edit',
    { file_path: f('tests/auth/login.test.ts'), old_string: '});\n', new_string: "  it('rejects empty passwords', () => {\n    expect(validatePassword('')).toBe(false);\n    expect(validatePassword('   ')).toBe(false);\n  });\n});\n" },
    'The file has been updated.',
    {
      filePath: f('tests/auth/login.test.ts'),
      structuredPatch: [{ oldStart: 50, oldLines: 3, newStart: 50, newLines: 7, lines: ['   });', ' ', "+  it('rejects empty passwords', () => {", "+    expect(validatePassword('')).toBe(false);", "+    expect(validatePassword('   ')).toBe(false);", '+  });', ' });'] }],
    },
  );
  tool('Bash', { command: 'npm test -- tests/auth', description: 'Run auth tests' }, "FAIL tests/auth/login.test.ts\n  ✕ rejects empty passwords (4 ms)\n\nTests: 1 failed, 11 passed, 12 total", { stdout: "FAIL tests/auth/login.test.ts\n  ✕ rejects empty passwords\nTests: 1 failed, 11 passed, 12 total", stderr: '', interrupted: false }, { error: true, run: 3200 });
  push(base({ type: 'attachment', timestamp: at(200), attachment: { type: 'queued_command', prompt: [{ type: 'text', text: 'also make sure the error message is friendly' }], timestamp: new Date(t).toISOString(), humanTurn: true } }));
  tool('Read', { file_path: f('src/auth/validate.ts') }, '     1\texport function', { type: 'text', file: { filePath: f('src/auth/validate.ts'), content: validateNew1, numLines: 6, startLine: 1, totalLines: 6 } }, {
    say: 'The whitespace case fails because trim is applied after a length check elsewhere. Looking again.',
  });
  tool(
    'Edit',
    { file_path: f('src/auth/validate.ts'), old_string: "  if (pw.trim() === '') {", new_string: "  if (pw.replace(/\\s/g, '') === '') {" },
    'The file has been updated.',
    {
      filePath: f('src/auth/validate.ts'),
      originalFile: validateNew1,
      structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' export function validatePassword(pw: string): boolean {', "-  if (pw.trim() === '') {", "+  if (pw.replace(/\\s/g, '') === '') {", '     return false;'] }],
    },
  );
  tool('Bash', { command: 'npm test -- tests/auth', description: 'Run auth tests' }, 'PASS tests/auth/login.test.ts\nTests: 12 passed, 12 total', { stdout: 'PASS tests/auth/login.test.ts\nTests: 12 passed, 12 total', stderr: '', interrupted: false }, { run: 2900 });
  const taskId = `toolu_${String(++tu).padStart(3, '0')}`;
  assistant([{ type: 'text', text: "Tests pass. I'll have a subagent check other forms for the same bug." }, { type: 'tool_use', id: taskId, name: 'Task', input: { description: 'Audit forms for empty input', subagent_type: 'general-purpose', prompt: 'Find other forms that accept empty required fields.' } }]);
  const taskStart = t;
  // subagent transcript
  const side = { isSidechain: true, agentId: 'a1b2c3' };
  push({ ...base(side), type: 'user', timestamp: new Date(taskStart + 300).toISOString(), message: { role: 'user', content: 'Find other forms that accept empty required fields.' } }, sub);
  t = taskStart + 300;
  tool('Grep', { pattern: 'required', glob: 'src/forms/**' }, 'src/forms/signup.ts\nsrc/forms/profile.ts', {}, { into: sub, side });
  tool('Read', { file_path: f('src/forms/signup.ts') }, '...', {}, { into: sub, side });
  tool('Read', { file_path: f('src/forms/profile.ts') }, '...', {}, { into: sub, side });
  assistant([{ type: 'text', text: 'signup.ts checks empties; profile.ts does not validate bio but it is optional.' }], 'end_turn', 800, sub, side);
  push(base({ type: 'user', timestamp: at(900), message: { role: 'user', content: [{ tool_use_id: taskId, type: 'tool_result', content: [{ type: 'text', text: 'No other forms accept empty required fields.' }] }] }, toolUseResult: { status: 'completed', agentId: 'a1b2c3', totalDurationMs: 6000 } }));
  tool('Write', { file_path: f('docs/SECURITY.md'), content: '# Password rules\n\n- Empty or whitespace-only passwords are rejected.\n' }, 'File created successfully', { type: 'create', filePath: f('docs/SECURITY.md'), content: '# Password rules\n', structuredPatch: [] });
  tool('TodoWrite', { todos: [{ content: 'Reject empty passwords', status: 'completed', activeForm: 'Rejecting empty passwords' }, { content: 'Friendly error message', status: 'completed', activeForm: 'Writing friendly error' }] }, 'Todos have been modified successfully', {});
  assistant([{ type: 'text', text: 'Fixed: `validatePassword` now rejects empty and whitespace-only passwords, with a test. A subagent confirmed no other forms have the same gap.' }], 'end_turn', 1200);

  // ---- prompt 2 (interrupted)
  prompt('<command-name>/review</command-name>\n<command-args>login.ts</command-args>', 30000);
  tool('Read', { file_path: f('src/auth/login.ts') }, '...', {}, { say: "I'll review login.ts." });
  const hangId = `toolu_${String(++tu).padStart(3, '0')}`;
  assistant([{ type: 'tool_use', id: hangId, name: 'Bash', input: { command: 'npx tsc --noEmit' } }]);
  push(base({ type: 'user', timestamp: at(4000), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }));

  const file = path.join(dir, sid + '.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const subFile = path.join(dir, sid, 'subagents', 'agent-a1b2c3.jsonl');
  fs.writeFileSync(subFile, sub.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { file, subFile, dir, sessionId: sid, lines, sub };
}

module.exports = { generate, encode };

if (require.main === module) {
  const [home, ws] = process.argv.slice(2);
  const r = generate(home, ws);
  console.log(r.file);
}
