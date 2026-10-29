import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { buildSync } from 'esbuild';

// Reuse the project's TypeScript bundler: no additional test runtime is needed.
const temp = mkdtempSync(join(tmpdir(), 'euphony-context-test-'));
after(() => rmSync(temp, { recursive: true, force: true }));
buildSync({
  entryPoints: ['src/utils/context-origins.ts', 'src/utils/codex-session.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: temp
});
const { analyzeContext, getContextCheckpoints } = await import(
  pathToFileURL(join(temp, 'context-origins.js'))
);
const { isCodexSessionJSONL } = await import(
  pathToFileURL(join(temp, 'codex-session.js'))
);

const event = (type, payload) => ({ type, payload });
const message = (role, text) =>
  event('response_item', {
    type: 'message',
    role,
    content: [{ type: 'input_text', text }]
  });
const usage = (input, output = 11) =>
  event('token_usage_record', {
    usage: { input_tokens: input, output_tokens: output }
  });
const report = events =>
  analyzeContext(events, getContextCheckpoints(events).at(-1));

test('detects a short modern session despite new event types dominating it', () => {
  const events = [
    event('session_meta', { id: 'synthetic' }),
    ...Array.from({ length: 20 }, () => event('world_state', { state: {} }))
  ];
  assert.equal(isCodexSessionJSONL(events), true);
  assert.equal(
    isCodexSessionJSONL([{ type: 'arbitrary-data', payload: {} }]),
    false
  );
});

test('separates exact request usage from estimates and excludes the current reply', () => {
  const events = [
    event('session_meta', { base_instructions: { text: 'Base prompt' } }),
    message('user', 'oi'),
    message('assistant', 'Hi there'),
    usage(19618)
  ];
  const r = report(events);
  assert.equal(r.checkpoint.input, 19618);
  assert.equal(r.checkpoint.output, 11);
  assert.ok(r.sources.some(s => s.category === 'base'));
  assert.ok(r.sources.some(s => s.text === 'oi'));
  assert.ok(!r.sources.some(s => s.text.includes('Hi there')));
  assert.equal(
    r.estimatedTokens,
    r.sources.reduce((sum, s) => sum + s.tokens, 0)
  );
  assert.ok(r.estimatedTokens < r.checkpoint.input);
});

test('does not count mirrored base instructions, skill catalogs or AGENTS twice', () => {
  const catalog =
    '## Skills\n- `r4` = `/home/test/plugins/cache/vendor`\n### Available skills\n- plugin:review: Review changes. (file: r4/review/SKILL.md)';
  const agents = 'Project rules for this fixture';
  const events = [
    event('session_meta', { base_instructions: { text: 'Base prompt' } }),
    message('developer', 'Base prompt'),
    message(
      'developer',
      `<skills_instructions>\n${catalog}\n</skills_instructions>`
    ),
    message(
      'user',
      `# AGENTS.md instructions for /project\n<INSTRUCTIONS>${agents}</INSTRUCTIONS>`
    ),
    event('world_state', {
      state: { host_skills: { body: catalog }, agents_md: { text: agents } }
    }),
    message('user', 'oi'),
    usage(1000)
  ];
  const r = report(events);
  assert.equal(r.sources.filter(s => s.category === 'base').length, 1);
  const skill = r.sources.filter(s => s.title === 'plugin:review');
  assert.equal(skill.length, 1);
  assert.equal(
    skill[0].origin,
    '/home/test/plugins/cache/vendor/review/SKILL.md'
  );
  assert.ok(!r.sources.some(s => s.stateOnly));
});

test('snapshot-only skills are inspectable without claiming request inclusion', () => {
  const catalog =
    '### Available skills\n- sample: Description. (file: /skills/sample/SKILL.md)';
  const events = [
    event('session_meta', {}),
    event('world_state', { state: { host_skills: { body: catalog } } }),
    message('user', 'oi'),
    usage(200)
  ];
  const r = report(events);
  const skill = r.sources.find(s => s.title === 'sample');
  assert.equal(skill.stateOnly, true);
  assert.equal(skill.tokens, 0);
  assert.ok(r.notices.some(n => n.includes('Snapshot-only')));
});

test('does not turn filename mentions in ordinary messages into injected context', () => {
  const events = [
    message('user', 'Where is MEMORY.md? Explain the AGENTS.md instructions.'),
    message('developer', 'Keep MEMORY.md updated when asked.'),
    message(
      'developer',
      '> ai-memory: project context\n<!-- ai-memory:untrusted-history:start -->\nPast decision'
    ),
    usage(500)
  ];
  const r = report(events);
  assert.equal(r.sources.filter(s => s.category === 'memory').length, 1);
  assert.ok(
    r.sources.some(
      s =>
        s.category === 'conversation' && s.text.includes('Where is MEMORY.md')
    )
  );
  assert.ok(
    r.sources.some(
      s => s.category === 'instructions' && s.text.includes('Keep MEMORY.md')
    )
  );
});

test('correlates explicit hook context with prompt text without counting stdout or duplicates', () => {
  const events = [
    event('hook_response', {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'Injected project knowledge'
      },
      stdout: 'Execution log is not prompt context'
    }),
    message('developer', 'Injected project knowledge'),
    message('user', 'Explain how hooks work'),
    usage(500)
  ];
  const result = report(events);
  const hooks = result.sources.filter(s => s.category === 'hooks');
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].stateOnly, false);
  assert.match(hooks[0].delivery, /correlated/);
  assert.equal(
    result.sources.some(s => s.text.includes('Execution log')),
    false
  );
  assert.equal(
    result.sources.find(s => s.text === 'Explain how hooks work').category,
    'conversation'
  );
});

test('shows uncorrelated hook output without claiming it entered the request', () => {
  const events = [
    event('hook_response', { additionalContext: 'Hook context only in logs' }),
    message('user', 'oi'),
    usage(100)
  ];
  const source = report(events).sources.find(s => s.category === 'hooks');
  assert.equal(source.stateOnly, true);
  assert.equal(source.tokens, 0);
  assert.match(source.delivery, /not established/);
});

test('keeps tool schemas distinct from MCP schemas and does not tokenize hashes', () => {
  const events = [
    event('session_meta', {}),
    event('world_state', {
      state: { top_level_tools: { exec: 'a'.repeat(40) } }
    }),
    event('response_item', {
      type: 'additional_tools',
      tools: [
        {
          type: 'namespace',
          name: 'functions',
          tools: [{ name: 'exec', description: 'Run code' }]
        },
        {
          name: 'mcp__git__read',
          description: 'Read repo',
          parameters: { type: 'object' }
        }
      ]
    }),
    usage(200)
  ];
  const r = report(events);
  assert.ok(
    r.sources.some(s => s.category === 'tools' && s.title === 'functions.exec')
  );
  assert.ok(r.sources.some(s => s.category === 'mcp'));
  assert.ok(!r.sources.some(s => s.text.includes('a'.repeat(40))));
});

test('does not inflate estimates by tokenizing image base64 payloads', () => {
  const events = [
    event('session_meta', {}),
    event('response_item', {
      type: 'custom_tool_call_output',
      output: JSON.stringify([
        { type: 'input_text', text: 'Image ready' },
        {
          type: 'input_image',
          image_url: `data:image/png;base64,${'abcd'.repeat(10000)}`
        }
      ])
    }),
    usage(5000)
  ];
  const r = report(events);
  assert.ok(r.estimatedTokens < 20);
  assert.ok(!r.sources.some(s => s.text.includes('base64')));
  assert.ok(r.notices.some(n => n.includes('Image payloads')));
});

test('deduplicates modern and legacy usage events for the same completion', () => {
  const events = [
    message('user', 'first'),
    message('assistant', 'first reply'),
    usage(100),
    event('event_msg', {
      type: 'token_count',
      info: { last_token_usage: { input_tokens: 100, output_tokens: 11 } }
    }),
    message('user', 'second'),
    message('assistant', 'second reply'),
    usage(200)
  ];
  const checkpoints = getContextCheckpoints(events);
  assert.equal(checkpoints.length, 2);
  assert.ok(
    !analyzeContext(events, checkpoints[0]).sources.some(s =>
      s.text.includes('reply')
    )
  );
  assert.ok(
    analyzeContext(events, checkpoints[1]).sources.some(
      s => s.text === 'first reply'
    )
  );
  assert.ok(
    !analyzeContext(events, checkpoints[1]).sources.some(
      s => s.text === 'second reply'
    )
  );
});

test('replaces pre-compaction outputs with the summary instead of summing archives', () => {
  const events = [
    event('session_meta', { base_instructions: { text: 'Base' } }),
    event('response_item', {
      type: 'function_call_output',
      output: 'Old enormous output '.repeat(100)
    }),
    event('compacted', { message: 'Summary of previous work' }),
    message('user', 'Continue'),
    usage(300)
  ];
  const r = report(events);
  assert.ok(!r.sources.some(s => s.text.includes('Old enormous')));
  assert.ok(r.sources.some(s => s.category === 'summary'));
  assert.ok(r.notices.some(n => n.includes('compaction occurred')));
});
