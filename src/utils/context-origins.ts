import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';

export const CONTEXT_CATEGORIES = {
  base: 'Base instructions',
  instructions: 'Developer instructions',
  agents: 'AGENTS.md',
  skills: 'Skill catalog',
  memory: 'Memory',
  environment: 'Environment & plugins',
  tools: 'Built-in tool definitions',
  mcp: 'MCP tool definitions',
  conversation: 'Conversation',
  calls: 'Tool calls',
  results: 'Tool results',
  summary: 'Compaction summary'
} as const;

export type ContextCategory = keyof typeof CONTEXT_CATEGORIES;
type RecordValue = Record<string, unknown>;

export interface ContextSource {
  id: string;
  category: ContextCategory;
  title: string;
  origin: string;
  evidence: string;
  text: string;
  tokens: number;
  stateOnly: boolean;
}

export interface ContextCheckpoint {
  id: string;
  label: string;
  end: number;
  input: number | null;
  output: number | null;
  window: number | null;
}

export interface ContextReport {
  sources: ContextSource[];
  estimatedTokens: number;
  notices: string[];
  checkpoint: ContextCheckpoint;
}

const record = (value: unknown): RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
const string = (value: unknown): string =>
  typeof value === 'string' ? value : '';
const number = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;

/** Normalize string records without interpreting or executing their content. */
export function normalizeContextEvents(raw: unknown[]): RecordValue[] {
  return raw.flatMap(value => {
    try {
      const parsed: unknown =
        typeof value === 'string' ? JSON.parse(value) : value;
      const event = record(parsed);
      return typeof event.type === 'string' ? [event] : [];
    } catch {
      return [];
    }
  });
}

/** Locate per-request usage, never treating cumulative usage as current input.
 * The first assistant item starts the response being measured; it is excluded
 * from that request's input. Previous responses remain in subsequent inputs.
 */
export function getContextCheckpoints(raw: unknown[]): ContextCheckpoint[] {
  const events = normalizeContextEvents(raw);
  const checkpoints: ContextCheckpoint[] = [];
  let generationStart: number | null = null;
  let window: number | null = null;
  let previousUsageIndex = -2;
  for (const [index, event] of events.entries()) {
    const payload = record(event.payload);
    const info = record(payload.info);
    const candidateWindow =
      number(payload.model_context_window) ?? number(info.model_context_window);
    if (candidateWindow !== null) window = candidateWindow;
    if (event.type === 'response_item') {
      const isOutput =
        payload.role === 'assistant' ||
        ['reasoning', 'function_call', 'custom_tool_call'].includes(
          string(payload.type)
        );
      if (isOutput) generationStart ??= index;
    }
    const modern = event.type === 'token_usage_record';
    const legacy = event.type === 'event_msg' && payload.type === 'token_count';
    if (!modern && !legacy) continue;
    // Recent Codex writes both formats for the same completion.
    if (legacy && previousUsageIndex === index - 1) continue;
    const usage = record(modern ? payload.usage : info.last_token_usage);
    const input = number(usage.input_tokens);
    if (input === null) continue;
    checkpoints.push({
      id: `request-${index}`,
      label: `Request ${checkpoints.length + 1}`,
      end: generationStart ?? index,
      input,
      output: number(usage.output_tokens),
      window
    });
    previousUsageIndex = index;
    generationStart = null;
  }
  if (checkpoints.length === 0) {
    checkpoints.push({
      id: 'observed',
      label: 'Observed session',
      end: events.length,
      input: null,
      output: null,
      window
    });
  }
  return checkpoints;
}

function isImage(value: RecordValue): boolean {
  return (
    string(value.type).includes('image') || typeof value.image_url === 'string'
  );
}

/** Images and encrypted reasoning are not text. In particular, never tokenize
 * their base64 representation: that creates the misleading >100% reports.
 */
function visibleText(value: unknown, notices: Set<string>): string {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return visibleText(parsed, notices);
    } catch {
      /* Plain tool output is not necessarily JSON. */
    }
    if (value.includes('data:image/')) {
      const cleaned = value.replace(
        /data:image\/[^;,\s]+;base64,[A-Za-z0-9+/=]+/g,
        '[image data omitted]'
      );
      if (cleaned !== value)
        notices.add(
          'Image payloads are excluded; their visual token cost is not observable here.'
        );
      return cleaned;
    }
    return value;
  }
  if (Array.isArray(value))
    return value
      .map(v => visibleText(v, notices))
      .filter(Boolean)
      .join('\n');
  const item = record(value);
  if (isImage(item)) {
    notices.add(
      'Image payloads are excluded; their visual token cost is not observable here.'
    );
    return '';
  }
  for (const key of ['text', 'content', 'value']) {
    if (key in item) return visibleText(item[key], notices);
  }
  return '';
}

/** Estimate only recorded text with o200k_base, not the model's undisclosed
 * tokenizer, message framing, or server-side additions. Percentages use this
 * observable-text total rather than allocating exact usage by byte weights.
 */
export function analyzeContext(
  raw: unknown[],
  checkpoint: ContextCheckpoint
): ContextReport {
  const events = normalizeContextEvents(raw).slice(0, checkpoint.end);
  const sources: ContextSource[] = [];
  const notices = new Set<string>();
  const toolDefinitions = new Map<string, ContextSource>();
  const stateSources: { key: string; text: string; index: number }[] = [];
  const calls = new Map<string, { name: string; input: string }>();
  let nextSource = 0;
  let baseInstructions = '';
  const allMessageText = events
    .filter(e => e.type === 'response_item')
    .map(e => visibleText(record(e.payload).content, notices))
    .join('\n');
  let compacted = false;

  function add(
    category: ContextCategory,
    title: string,
    text: string,
    index: number,
    origin = '',
    stateOnly = false
  ): ContextSource | undefined {
    if (!text.trim()) return undefined;
    const source: ContextSource = {
      id: `source-${index}-${nextSource++}`,
      category,
      title,
      text,
      origin,
      evidence: `Record ${index + 1}`,
      stateOnly,
      tokens: stateOnly
        ? 0
        : countTokens(text, { disallowedSpecial: new Set() })
    };
    sources.push(source);
    return source;
  }

  function catalog(text: string, index: number, stateOnly: boolean): void {
    const roots = new Map<string, string>();
    for (const match of text.matchAll(/- `([^`]+)` = `([^`]+)`/g))
      roots.set(match[1], match[2]);
    const entries = [
      ...text.matchAll(/^- (.+?):\s+(.+?\(file:\s*([^\n]+?)\))\s*$/gm)
    ];
    for (const match of entries) {
      const path = match[3].replace(/^([^/]+)\//, (full, alias: string) =>
        roots.has(alias) ? `${roots.get(alias)}/` : full
      );
      add('skills', match[1], match[0], index, path, stateOnly);
    }
    // Keep catalog framing and routing instructions; never make their cost vanish.
    let remainder = text;
    for (const match of entries) remainder = remainder.replace(match[0], '');
    add(
      'skills',
      entries.length ? 'Skill catalog instructions' : 'Skill catalog',
      remainder,
      index,
      'Catalog metadata; availability does not prove invocation.',
      stateOnly
    );
  }

  function message(text: string, role: string, index: number): void {
    if (text.trim() && text.trim() === baseInstructions.trim()) {
      add(
        'base',
        'Codex base instructions',
        text,
        index,
        'session_meta.base_instructions, mirrored as a developer message'
      );
      return;
    }
    if (role === 'assistant') {
      add('conversation', 'Previous assistant response', text, index);
      return;
    }
    // Split known context blocks so one developer message is not an opaque bucket.
    const tags = [
      'skills_instructions',
      'INSTRUCTIONS',
      'environment_context',
      'permissions instructions',
      'collaboration_mode',
      'multi_agent_role',
      'multi_agent_mode'
    ].join('|');
    const blocks = new RegExp(
      String.raw`<(${tags})\b[^>]*>[\s\S]*?<\/\1>`,
      'g'
    );
    const matches = [...text.matchAll(blocks)];
    let rest = text;
    for (const match of matches) {
      const tag = match[1];
      if (tag === 'skills_instructions') catalog(match[0], index, false);
      else if (tag === 'INSTRUCTIONS' && /AGENTS\.md/i.test(text))
        add(
          'agents',
          'Project instructions',
          match[0],
          index,
          text.split('\n')[0]
        );
      else
        add(
          tag === 'environment_context' ? 'environment' : 'instructions',
          tag.replaceAll('_', ' '),
          match[0],
          index
        );
      rest = rest.replace(match[0], '');
    }
    if (!rest.trim()) return;
    // A filename mention is not an injection. Only established context markers
    // in a developer/system message identify a memory block here.
    if (
      ['developer', 'system'].includes(role) &&
      /<!--\s*ai-memory:|(?:^|\n)>[^\n]*ai-memory:|<memory(?:_context|_instructions)?>/i.test(
        rest
      )
    )
      add('memory', 'Injected memory', rest, index);
    else if (/^# AGENTS\.md instructions for /i.test(rest.trim()))
      add('agents', 'AGENTS.md envelope', rest, index);
    else if (
      ['developer', 'system'].includes(role) &&
      /## Skills|### Available skills/.test(rest)
    )
      catalog(rest, index, false);
    else if (role === 'developer' || role === 'system')
      add('instructions', 'Developer instructions', rest, index);
    else add('conversation', 'User message', rest, index);
  }

  function tools(definitions: unknown, index: number, namespace = ''): void {
    if (!Array.isArray(definitions)) return;
    for (const value of definitions) {
      const def = record(value);
      const name = string(def.name) || 'unnamed tool';
      const fullName = namespace ? `${namespace}.${name}` : name;
      if (def.type === 'namespace' && Array.isArray(def.tools)) {
        if (def.description)
          add('tools', `${fullName} namespace`, string(def.description), index);
        tools(def.tools, index, fullName);
        continue;
      }
      const serialized = JSON.stringify(def, null, 2);
      // A refreshed schema replaces its previous catalog entry, not an extra copy.
      const previous = toolDefinitions.get(fullName);
      if (previous) sources.splice(sources.indexOf(previous), 1);
      const item = add(
        /mcp[_.]|mcp__/i.test(fullName) ? 'mcp' : 'tools',
        fullName,
        serialized,
        index,
        'Recorded tool schema'
      );
      if (item) toolDefinitions.set(fullName, item);
    }
  }

  for (const [index, event] of events.entries()) {
    const payload = record(event.payload);
    if (event.type === 'session_meta') {
      const base = visibleText(payload.base_instructions, notices);
      baseInstructions = base;
      // Codex may repeat metadata instructions as an actual developer message.
      if (base && !allMessageText.includes(base))
        add('base', 'Codex base instructions', base, index);
      else if (base)
        notices.add(
          'Base instructions mirrored in a developer message are counted once.'
        );
    } else if (event.type === 'world_state') {
      const state = record(payload.state);
      for (const [key, text] of [
        ['Skill catalog', record(state.host_skills).body],
        ['AGENTS.md', record(state.agents_md).text]
      ]) {
        if (typeof text === 'string')
          stateSources.push({ key: String(key), text, index });
      }
      if (Object.keys(record(state.top_level_tools)).length > 0)
        notices.add(
          'world_state tool hashes are identifiers, not schemas; they are not tokenized.'
        );
    } else if (event.type === 'compacted') {
      compacted = true;
      // A compaction summary replaces earlier conversation evidence. Keep the
      // initial instruction/catalog sources, never add all archived outputs.
      for (let i = sources.length - 1; i >= 0; i--)
        if (
          ['conversation', 'calls', 'results', 'summary'].includes(
            sources[i].category
          )
        )
          sources.splice(i, 1);
      const replacement = Array.isArray(payload.replacement_history)
        ? payload.replacement_history
        : [];
      const summary =
        replacement
          .filter(
            v => !['developer', 'system'].includes(string(record(v).role))
          )
          .map(v => visibleText(record(v).content, notices))
          .join('\n') || string(payload.message);
      add('summary', 'Replacement history / summary', summary, index);
      notices.add(
        'A compaction occurred. This is an observed-text inventory, not an exact reconstruction of the active request.'
      );
    } else if (event.type === 'response_item') {
      if (payload.type === 'additional_tools') tools(payload.tools, index);
      else if (payload.type === 'message')
        message(
          visibleText(payload.content, notices),
          string(payload.role),
          index
        );
      else if (
        ['function_call', 'custom_tool_call'].includes(string(payload.type))
      ) {
        calls.set(string(payload.call_id), {
          name: string(payload.name),
          input: visibleText(payload.arguments ?? payload.input, notices)
        });
        add(
          'calls',
          string(payload.name) || 'Tool call',
          visibleText(payload.arguments ?? payload.input, notices),
          index
        );
      } else if (
        ['function_call_output', 'custom_tool_call_output'].includes(
          string(payload.type)
        )
      ) {
        const call = calls.get(string(payload.call_id));
        add(
          'results',
          (string(payload.name) || call?.name) ?? 'Tool result',
          visibleText(payload.output, notices),
          index,
          call ? `${call.name}: ${call.input}` : string(payload.call_id)
        );
      } else if (payload.type === 'reasoning' && payload.encrypted_content)
        notices.add('Encrypted reasoning is not decoded or estimated as text.');
    }
  }
  const snapshots = new Set<string>();
  for (const item of stateSources) {
    // Snapshot mirrors are evidence about configuration, not additional messages.
    const comparable = item.text.trim();
    if (allMessageText.includes(comparable) || snapshots.has(comparable))
      continue;
    snapshots.add(comparable);
    if (item.key === 'Skill catalog') catalog(item.text, item.index, true);
    else
      add(
        'agents',
        item.key,
        item.text,
        item.index,
        'world_state snapshot only',
        true
      );
    notices.add(
      'Snapshot-only sources are inspectable, not counted: request inclusion is not established.'
    );
  }
  if (!toolDefinitions.size)
    notices.add(
      'No full tool schemas were recorded. Missing MCP and built-in definitions cannot be measured from this file.'
    );
  notices.add(
    'Text uses o200k_base estimates. Recorded input includes framing and other unobservable content.'
  );
  if (compacted)
    notices.add(
      'Use the first request to inspect the initial context without compaction ambiguity.'
    );
  return {
    sources,
    checkpoint,
    estimatedTokens: sources.reduce((n, s) => n + s.tokens, 0),
    notices: [...notices]
  };
}
