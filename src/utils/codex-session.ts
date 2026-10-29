import { config } from '../config/config';
import type { Conversation, Message } from '../types/harmony-types';
import { Role } from '../types/harmony-types';

interface CodexSessionEvent {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

interface CodexResponseItemPayload {
  type?: string;
  role?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  input?: string;
  status?: string;
  output?: unknown;
  content?: Record<string, unknown>[];
  summary?: Record<string, unknown>[];
  message?: string;
  text?: string;
}

export interface CodexSessionParseResult {
  conversation: Conversation;
  customLabels: string[][];
}

const KNOWN_TOP_LEVEL_TYPES = new Set([
  'session_meta',
  'response_item',
  'event_msg',
  'turn_context',
  'compacted'
]);

const KNOWN_RESPONSE_ITEM_TYPES = new Set([
  'message',
  'function_call',
  'function_call_output',
  'custom_tool_call',
  'custom_tool_call_output',
  'reasoning'
]);

const KNOWN_EVENT_MSG_TYPES = new Set([
  'user_message',
  'agent_message',
  'agent_reasoning',
  'context_compacted',
  'turn_aborted',
  'token_count'
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const safeParseJSON = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch (_error) {
    return null;
  }
};

const normalizeCodexEvents = (raw: unknown[]): CodexSessionEvent[] => {
  const events: CodexSessionEvent[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const parsed = safeParseJSON(item);
      if (isRecord(parsed)) {
        events.push(parsed as CodexSessionEvent);
      }
      continue;
    }
    if (isRecord(item)) {
      events.push(item as CodexSessionEvent);
    }
  }
  return events;
};

const looksLikeCodexEvent = (event: CodexSessionEvent): boolean => {
  if (typeof event.type !== 'string') {
    return false;
  }
  if (KNOWN_TOP_LEVEL_TYPES.has(event.type)) {
    if (event.type === 'response_item') {
      const payloadType =
        event.payload && typeof event.payload.type === 'string'
          ? event.payload.type
          : null;
      return payloadType ? KNOWN_RESPONSE_ITEM_TYPES.has(payloadType) : true;
    }
    if (event.type === 'event_msg') {
      const payloadType =
        event.payload && typeof event.payload.type === 'string'
          ? event.payload.type
          : null;
      return payloadType ? KNOWN_EVENT_MSG_TYPES.has(payloadType) : true;
    }
    return true;
  }
  return event.type.startsWith('response_') || event.type.startsWith('event_');
};

export const isCodexSessionJSONL = (raw: unknown[]): boolean => {
  if (!Array.isArray(raw) || raw.length === 0) {
    return false;
  }

  const events = normalizeCodexEvents(raw).filter(looksLikeCodexEvent);
  if (events.length === 0) {
    return false;
  }
  // session_meta is an explicit Codex marker. Unknown events introduced by
  // newer clients (world_state, token_usage_record, etc.) must not make a
  // valid session fall below the legacy heuristic threshold.
  if (events.some(event => event.type === 'session_meta')) {
    return true;
  }
  if (events.length / raw.length < 0.6) {
    return false;
  }

  const knownTopLevelCount = events.filter(event =>
    KNOWN_TOP_LEVEL_TYPES.has(event.type ?? '')
  ).length;
  return knownTopLevelCount / events.length >= 0.6;
};

const parseTimestampSeconds = (timestamp?: string): number | null => {
  if (!timestamp) {
    return null;
  }
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? null : parsed / 1000;
};

const sanitizeEventForMetadata = (
  event: CodexSessionEvent
): CodexSessionEvent => {
  try {
    const clone = JSON.parse(JSON.stringify(event)) as CodexSessionEvent;
    if (clone.payload && 'encrypted_content' in clone.payload) {
      clone.payload.encrypted_content = '[omitted]';
    }
    return clone;
  } catch (_error) {
    return event;
  }
};

const formatJSON = (value: unknown): string => JSON.stringify(value, null, 2);

const getDisplayString = (value: unknown): string | null => {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return String(value);
  }
  return null;
};

const getTextContent = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map(item => getTextContent(item))
      .filter(text => text !== '')
      .join('\n');
  }
  if (isRecord(value)) {
    for (const key of ['text', 'content', 'value']) {
      if (key in value) {
        return getTextContent(value[key]);
      }
    }
  }
  return '';
};

const getBaseInstructionsText = (value: unknown): string => {
  if (isRecord(value) && 'text' in value) {
    return getTextContent(value.text).trim();
  }
  return getTextContent(value).trim();
};

const formatMaybeJSON = (value: string): string => {
  const parsed = safeParseJSON(value);
  return parsed === null ? value : formatJSON(parsed);
};

const getExecCommandFromArguments = (value: unknown): string | null => {
  if (isRecord(value) && typeof value.cmd === 'string') {
    return value.cmd;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const parsed = safeParseJSON(value);
  if (parsed === null) {
    return value;
  }
  if (isRecord(parsed) && typeof parsed.cmd === 'string') {
    return parsed.cmd;
  }
  return null;
};

const coerceRole = (role?: string): Role => {
  switch (role) {
    case 'assistant':
      return Role.Assistant;
    case 'user':
      return Role.User;
    case 'system':
      return Role.System;
    case 'tool':
      return Role.Tool;
    case 'developer':
      return Role.Developer;
    default:
      return Role.System;
  }
};

const buildTextMessage = ({
  id,
  role,
  text,
  timestamp,
  metadata,
  name,
  recipient,
  channel
}: {
  id: string;
  role: Role;
  text: string;
  timestamp: number | null;
  metadata: Record<string, unknown>;
  name?: string;
  recipient?: string;
  channel?: string;
}): Message => ({
  id,
  role,
  name,
  content: [{ text }],
  create_time: timestamp ?? undefined,
  metadata,
  recipient,
  channel
});

const buildDeveloperMessage = ({
  id,
  instructions,
  timestamp,
  metadata,
  name,
  recipient,
  channel
}: {
  id: string;
  instructions: string;
  timestamp: number | null;
  metadata: Record<string, unknown>;
  name?: string;
  recipient?: string;
  channel?: string;
}): Message => ({
  id,
  role: Role.Developer,
  name,
  content: [{ instructions }],
  create_time: timestamp ?? undefined,
  metadata,
  recipient,
  channel
});

const buildCodeMessage = ({
  id,
  role,
  code,
  language,
  timestamp,
  metadata,
  name,
  recipient,
  channel
}: {
  id: string;
  role: Role;
  code: string;
  language: string;
  timestamp: number | null;
  metadata: Record<string, unknown>;
  name?: string;
  recipient?: string;
  channel?: string;
}): Message => ({
  id,
  role,
  name,
  content: [
    {
      content_type: 'code',
      text: code,
      language
    }
  ],
  create_time: timestamp ?? undefined,
  metadata,
  recipient,
  channel
});

export const parseCodexSession = (
  raw: unknown[]
): CodexSessionParseResult | null => {
  if (!isCodexSessionJSONL(raw)) {
    return null;
  }

  const events = normalizeCodexEvents(raw).filter(looksLikeCodexEvent);
  const messages: Message[] = [];
  const callIdToToolName = new Map<string, string>();

  const hasResponseItemUserMessages = events.some(
    event =>
      event.type === 'response_item' &&
      isRecord(event.payload) &&
      event.payload.type === 'message' &&
      event.payload.role === 'user'
  );
  const hasResponseItemAssistantMessages = events.some(
    event =>
      event.type === 'response_item' &&
      isRecord(event.payload) &&
      event.payload.type === 'message' &&
      event.payload.role === 'assistant'
  );
  const hasResponseItemReasoning = events.some(
    event =>
      event.type === 'response_item' &&
      isRecord(event.payload) &&
      event.payload.type === 'reasoning'
  );

  let messageCount = 0;
  let toolCallCount = 0;
  let toolOutputCount = 0;
  let reasoningCount = 0;

  const sessionMetaEvent = events.find(event => event.type === 'session_meta');
  const sessionMetaPayload: Record<string, unknown> =
    sessionMetaEvent?.payload ?? {};
  const turnContextEvent = events.find(event => event.type === 'turn_context');
  const turnContextPayload: Record<string, unknown> =
    turnContextEvent?.payload ?? {};
  const sessionId =
    (sessionMetaPayload.id as string | undefined) ??
    `codex-session-${Date.now()}`;
  const modelName =
    typeof turnContextPayload.model === 'string'
      ? turnContextPayload.model
      : null;
  const cliVersion =
    typeof sessionMetaPayload.cli_version === 'string'
      ? sessionMetaPayload.cli_version
      : null;
  const sessionTimestamp =
    typeof sessionMetaPayload.timestamp === 'string'
      ? sessionMetaPayload.timestamp
      : null;
  const baseInstructionsText = getBaseInstructionsText(
    sessionMetaPayload.base_instructions
  );

  const summaryLines: string[] = ['Codex session'];
  const sessionMetaId = getDisplayString(sessionMetaPayload.id);
  if (sessionMetaId) {
    summaryLines.push(`id: ${sessionMetaId}`);
  }
  if (sessionTimestamp) {
    summaryLines.push(`started: ${sessionTimestamp}`);
  }
  const sessionCwd = getDisplayString(sessionMetaPayload.cwd);
  if (sessionCwd) {
    summaryLines.push(`cwd: ${sessionCwd}`);
  }
  const sessionOriginator = getDisplayString(sessionMetaPayload.originator);
  if (sessionOriginator) {
    summaryLines.push(`originator: ${sessionOriginator}`);
  }
  if (cliVersion) {
    summaryLines.push(`cli_version: ${cliVersion}`);
  }
  if (modelName) {
    summaryLines.push(`model: ${modelName}`);
  }
  if (sessionMetaPayload.git && isRecord(sessionMetaPayload.git)) {
    const git = sessionMetaPayload.git;
    const gitBranch = getDisplayString(git.branch) ?? 'unknown';
    const gitCommitHash = getDisplayString(git.commit_hash) ?? 'unknown';
    if (gitBranch !== 'unknown' || gitCommitHash !== 'unknown') {
      summaryLines.push(`git: ${gitBranch}@${gitCommitHash}`);
    }
  }

  if (summaryLines.length > 1) {
    const summaryEvent: CodexSessionEvent = sessionMetaEvent ?? {
      type: 'session_meta',
      payload: sessionMetaPayload
    };
    messages.push(
      buildTextMessage({
        id: `${sessionId}-summary`,
        role: Role.System,
        text: summaryLines.join('\n'),
        timestamp: parseTimestampSeconds(sessionMetaEvent?.timestamp),
        metadata: {
          codex_event_type: 'session_meta',
          codex_event: sanitizeEventForMetadata(summaryEvent)
        },
        name: 'codex'
      })
    );
    messageCount += 1;
  }

  if (baseInstructionsText) {
    messages.push(
      buildDeveloperMessage({
        id: `${sessionId}-base-instructions`,
        instructions: baseInstructionsText,
        timestamp: parseTimestampSeconds(sessionMetaEvent?.timestamp),
        metadata: {
          codex_event_type: 'session_meta',
          codex_source: 'session_meta.base_instructions.text',
          codex_event: sanitizeEventForMetadata(
            sessionMetaEvent ?? {
              type: 'session_meta',
              payload: sessionMetaPayload
            }
          )
        }
      })
    );
    messageCount += 1;
  }

  for (const [index, event] of events.entries()) {
    const eventType = event.type ?? 'unknown';
    const payload = (event.payload ?? {}) as CodexResponseItemPayload;
    const timestamp = parseTimestampSeconds(event.timestamp);
    const metadata = {
      codex_event_type: eventType,
      codex_payload_type: payload.type ?? null,
      codex_event: sanitizeEventForMetadata(event),
      codex_function_name:
        typeof payload.name === 'string' ? payload.name : null
    };

    if (eventType === 'response_item') {
      const payloadType = payload.type ?? 'unknown';

      if (payloadType === 'message') {
        const textParts = (
          Array.isArray(payload.content) ? payload.content : []
        )
          .map(part => {
            if (typeof part.text === 'string') {
              return part.text;
            }
            if (typeof part.type === 'string') {
              return `[${part.type}]`;
            }
            return '';
          })
          .filter(Boolean);
        messages.push(
          buildTextMessage({
            id: `${sessionId}-message-${index}`,
            role: coerceRole(payload.role),
            text:
              textParts.length > 0 ? textParts.join('\n') : '[empty message]',
            timestamp,
            metadata
          })
        );
        messageCount += 1;
        continue;
      }

      if (payloadType === 'reasoning') {
        const summaryText = (
          Array.isArray(payload.summary) ? payload.summary : []
        )
          .map(part => (typeof part.text === 'string' ? part.text : ''))
          .filter(Boolean)
          .join('\n');
        if (summaryText) {
          messages.push(
            buildTextMessage({
              id: `${sessionId}-reasoning-${index}`,
              role: Role.Assistant,
              text: summaryText,
              timestamp,
              metadata,
              channel: 'analysis'
            })
          );
          reasoningCount += 1;
        }
        continue;
      }

      if (payloadType === 'function_call') {
        const toolName = payload.name ?? 'tool';
        const callId = payload.call_id ?? `${sessionId}-call-${index}`;
        callIdToToolName.set(callId, toolName);
        const execCommand =
          toolName === 'exec_command'
            ? getExecCommandFromArguments(payload.arguments)
            : null;

        if (execCommand !== null) {
          messages.push(
            buildCodeMessage({
              id: `${sessionId}-call-${callId}`,
              role: Role.Tool,
              code: execCommand,
              language: 'bash',
              timestamp,
              metadata,
              name: toolName,
              recipient: toolName,
              channel: 'call'
            })
          );
        } else {
          messages.push(
            buildCodeMessage({
              id: `${sessionId}-call-${callId}`,
              role: Role.Tool,
              code: formatJSON(payload),
              language: 'json',
              timestamp,
              metadata,
              name: toolName,
              recipient: toolName,
              channel: 'call'
            })
          );
        }
        toolCallCount += 1;
        continue;
      }

      if (payloadType === 'custom_tool_call') {
        const toolName = payload.name ?? 'tool';
        const callId = payload.call_id ?? `${sessionId}-call-${index}`;
        callIdToToolName.set(callId, toolName);

        if (typeof payload.input === 'string' && payload.input.includes('\n')) {
          messages.push(
            buildCodeMessage({
              id: `${sessionId}-call-${callId}`,
              role: Role.Tool,
              code: `tool: ${toolName}\ncall_id: ${callId}\n\n${payload.input}`,
              language: 'text',
              timestamp,
              metadata,
              name: toolName,
              recipient: toolName,
              channel: 'call'
            })
          );
          toolCallCount += 1;
          continue;
        }

        const displayPayload: Record<string, unknown> = {
          type: payloadType,
          name: toolName,
          call_id: callId
        };
        if (payload.input !== undefined) {
          displayPayload.input = payload.input;
        }
        if (payload.status) {
          displayPayload.status = payload.status;
        }

        messages.push(
          buildCodeMessage({
            id: `${sessionId}-call-${callId}`,
            role: Role.Tool,
            code: formatJSON(displayPayload),
            language: 'json',
            timestamp,
            metadata,
            name: toolName,
            recipient: toolName,
            channel: 'call'
          })
        );
        toolCallCount += 1;
        continue;
      }

      if (
        payloadType === 'function_call_output' ||
        payloadType === 'custom_tool_call_output'
      ) {
        const callId = payload.call_id ?? `${sessionId}-call-${index}`;
        const toolName = payload.name ?? callIdToToolName.get(callId) ?? 'tool';
        const outputText =
          typeof payload.output === 'string'
            ? formatMaybeJSON(payload.output)
            : payload.output !== undefined
              ? formatJSON(payload.output)
              : '[empty output]';
        messages.push(
          buildCodeMessage({
            id: `${sessionId}-output-${callId}`,
            role: Role.Tool,
            code: outputText,
            language: 'text',
            timestamp,
            metadata,
            name: toolName,
            recipient: toolName,
            channel: 'output'
          })
        );
        toolOutputCount += 1;
        continue;
      }

      messages.push(
        buildCodeMessage({
          id: `${sessionId}-response-${index}`,
          role: Role.System,
          code: formatJSON({
            type: payloadType,
            ...payload
          }),
          language: 'json',
          timestamp,
          metadata,
          name: 'codex',
          channel: 'response'
        })
      );
      continue;
    }

    if (eventType === 'event_msg') {
      const payloadType = payload.type ?? 'unknown';

      if (!hasResponseItemUserMessages && payloadType === 'user_message') {
        messages.push(
          buildTextMessage({
            id: `${sessionId}-user-${index}`,
            role: Role.User,
            text:
              typeof payload.message === 'string'
                ? payload.message
                : '[empty message]',
            timestamp,
            metadata
          })
        );
        messageCount += 1;
        continue;
      }

      if (
        !hasResponseItemAssistantMessages &&
        payloadType === 'agent_message'
      ) {
        messages.push(
          buildTextMessage({
            id: `${sessionId}-assistant-${index}`,
            role: Role.Assistant,
            text:
              typeof payload.message === 'string'
                ? payload.message
                : '[empty message]',
            timestamp,
            metadata
          })
        );
        messageCount += 1;
        continue;
      }

      if (!hasResponseItemReasoning && payloadType === 'agent_reasoning') {
        messages.push(
          buildTextMessage({
            id: `${sessionId}-reasoning-${index}`,
            role: Role.Assistant,
            text:
              typeof payload.text === 'string'
                ? payload.text
                : '[empty reasoning]',
            timestamp,
            metadata,
            channel: 'analysis'
          })
        );
        reasoningCount += 1;
        continue;
      }

      if (payloadType === 'context_compacted') {
        messages.push(
          buildTextMessage({
            id: `${sessionId}-compacted-${index}`,
            role: Role.System,
            text: 'Context compacted',
            timestamp,
            metadata,
            name: 'codex'
          })
        );
        messageCount += 1;
      }
    }
  }

  const firstTimestamp =
    events.length > 0 ? parseTimestampSeconds(events[0].timestamp) : null;

  const customLabels: string[][] = [];
  if (sessionId) {
    customLabels.push([
      'Session',
      sessionId.slice(0, 8),
      sessionId,
      config.colors['blue-700']
    ]);
  }
  if (modelName) {
    customLabels.push([
      'Model',
      modelName,
      'From turn_context',
      config.colors['purple-700']
    ]);
  }
  if (cliVersion) {
    customLabels.push([
      'CLI',
      cliVersion,
      'Codex CLI version',
      config.colors['gray-700']
    ]);
  }
  customLabels.push([
    'Events',
    String(events.length),
    'JSONL event count',
    config.colors['green-700']
  ]);

  return {
    conversation: {
      id: sessionId,
      create_time: firstTimestamp ?? Date.now() / 1000,
      messages,
      metadata: {
        codex_session_meta: sessionMetaPayload,
        codex_turn_context: turnContextPayload,
        codex_event_counts: {
          events: events.length,
          messages: messageCount,
          tool_calls: toolCallCount,
          tool_outputs: toolOutputCount,
          reasoning: reasoningCount
        },
        'euphony-custom-labels': customLabels
      }
    },
    customLabels
  };
};
