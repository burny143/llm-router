// tool-calling-translator.js
// Bidirectional translator between OpenAI-style tool calling and plain-text
// instructions for upstream LLMs that don't natively support tool calls.
//
// Conversion strategy:
//   Client → Upstream:  tools become a text instruction; tool results become
//                       [TOOL_RESULT ...] blocks; system prompt is injected.
//   Upstream → Client:  plain-text tool call blocks are parsed and returned
//                       as proper OpenAI tool_calls with finish_reason set.

// ---------------------------------------------------------------------------
// Forced system prompt injected into every proxied request
// ---------------------------------------------------------------------------
const { FINISH_REASON_TOOL_CALLS, FINISH_REASON_STOP } = require('./shared-constants');

const FORCED_SYSTEM_PROMPT = [
  'You are a powerful AI assistant running behind a tool-calling proxy.',
  'If you need to use a tool, your ENTIRE reply MUST be ONLY one or more fenced JSON code blocks.',
  'Use exactly this format:',
  '```',
  '{"name": "exact_tool_name", "arguments": { ... }}',
  '```',
  'Rules:',
  '- Do not write any text before, between, or after tool-call code blocks.',
  '- Do not greet, explain, apologize, or ask questions when calling a tool.',
  '- Use the exact tool names that were provided.',
  '- Arguments must be a valid JSON object.',
  '- Use one separate code block per tool call.',
  '- If no tool is needed, reply with normal helpful text and no code blocks.',
  '- Never output raw JSON outside a code fence.',
].join('\n');

// ---------------------------------------------------------------------------
// Regex for parsing tool-call blocks from upstream plain-text responses.
// Matches code fences (``` or ```json) containing a JSON object with
// "name" and "arguments" keys. The capture group is lazy but anchored to the
// closing fence, so the regex engine backtracks/expands until it finds the
// "}" that is immediately followed by "```" — this correctly spans nested
// JSON objects in `arguments`, not just the first "}" encountered.
// ---------------------------------------------------------------------------
const TOOL_CALL_BLOCK_REGEX = /```(?:json)?\s*\n?(\{[\s\S]+?\})\s*\n?```/gi;

// ---------------------------------------------------------------------------
// tools → text instruction
// ---------------------------------------------------------------------------
function toolsToTextInstruction(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return null;

  const toolDescriptions = tools
    .map(t => {
      const name = t.function?.name || 'unknown';
      const desc = t.function?.description || 'No description';
      const params = t.function?.parameters || {};
      const props = params.properties || {};
      const required = params.required || [];

      const paramLines = Object.entries(props)
        .map(([key, schema]) => {
          const type = schema.type || 'string';
          const desc = schema.description || '';
          const req = required.includes(key) ? ' (required)' : '';
          return `  - ${key} (${type}): ${desc}${req}`;
        })
        .join('\n');

      return `- ${name}: ${desc}\n${paramLines}`;
    })
    .join('\n');

  return [
    'The following tools are available for you to use.',
    '',
    'When you need to call a tool, your ENTIRE reply MUST be ONLY fenced JSON code blocks.',
    'Use this exact format, one code block per tool call:',
    '',
    '```',
    '{"name": "tool_name", "arguments": {"param1": "value1"}}',
    '```',
    '',
    'Available tools:',
    toolDescriptions,
    '',
    'If none of the tools are needed, reply with normal helpful text and no code blocks.',
    '',
    'Reminder:',
    '- No greetings before tool calls.',
    '- No explanations before tool calls.',
    '- No raw JSON outside code fences.',
    '- Tool-call replies must contain ONLY the fenced JSON tool-call blocks.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Safely append text to a message's content, regardless of whether content
// is a plain string, an OpenAI-style multi-part array (e.g. text + image
// parts), or null/undefined. Using `content += text` directly breaks array
// content (it gets coerced to the string "[object Object]"), silently
// destroying any prior text/image parts.
// ---------------------------------------------------------------------------
function appendTextToMessageContent(msg, text) {
  if (typeof msg.content === 'string') {
    msg.content = msg.content ? msg.content + '\n\n' + text : text;
  } else if (Array.isArray(msg.content)) {
    msg.content = [...msg.content, { type: 'text', text }];
  } else if (msg.content == null) {
    msg.content = text;
  } else {
    // Unknown/unexpected shape — fall back to an explicit string conversion
    // rather than relying on implicit `+=` coercion.
    msg.content = String(msg.content) + '\n\n' + text;
  }
  return msg;
}

// ---------------------------------------------------------------------------
// Convert assistant messages that used native tool_calls → text blocks in
// the same fenced-JSON format the upstream model was instructed to use.
// Without this, prior tool calls in the conversation history are sent to
// the (text-only) upstream as `content: null` with a `tool_calls` field it
// doesn't understand — the upstream loses all context about what tool it
// previously "called" and with what arguments, and some APIs reject
// `content: null` outright.
// ---------------------------------------------------------------------------
function convertAssistantToolCallsToText(messages) {
  if (!Array.isArray(messages)) return messages;

  return messages.map(msg => {
    if (msg.role !== 'assistant' || !Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) {
      return msg;
    }

    const blocks = msg.tool_calls.map(tc => {
      let argsObj;

      try {
        argsObj = JSON.parse(tc.function?.arguments ?? '{}');
      } catch (e) {
        argsObj = { _raw: tc.function?.arguments };
      }

      return '```\n' + JSON.stringify({ name: tc.function?.name, arguments: argsObj }) + '\n```';
    }).join('\n\n');

    const existingText = typeof msg.content === 'string' && msg.content ? msg.content + '\n\n' : '';
    const { tool_calls, ...rest } = msg;

    return { ...rest, content: existingText + blocks };
  });
}

// ---------------------------------------------------------------------------
// Convert role:"tool" messages → text blocks for upstream
// ---------------------------------------------------------------------------
function convertToolResultsToText(messages) {
  if (!Array.isArray(messages)) return messages;

  return messages.map(msg => {
    if (msg.role === 'tool') {
      const callId = msg.tool_call_id || 'unknown';
      const name = msg.name || 'unknown_tool';
      const result = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');

      return {
        role: 'user',
        content: [
          `[TOOL_RESULT id="${callId}" name="${name}"]`,
          result,
          `[/TOOL_RESULT]`,
        ].join('\n'),
      };
    }
    return msg;
  });
}

// ---------------------------------------------------------------------------
// Inject forced system prompt into messages
// If a system message already exists, prepend the forced prompt to it.
// Otherwise, insert a system message at the beginning.
// ---------------------------------------------------------------------------
function injectSystemPrompt(messages) {
  if (!Array.isArray(messages)) return messages;

  const systemMsg = messages.find(m => m.role === 'system');
  if (systemMsg) {
    // Prepend forced prompt to existing system message
    systemMsg.content = FORCED_SYSTEM_PROMPT + '\n\n' + systemMsg.content;
  } else {
    // Insert system message at the beginning
    messages.unshift({ role: 'system', content: FORCED_SYSTEM_PROMPT });
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Apply all client→upstream conversions
// ---------------------------------------------------------------------------
function translateRequest(messages, tools) {
  if (!Array.isArray(messages)) return { messages, tools: undefined };

  let workingMessages = messages.map(m => ({ ...m }));

  // 1. Inject forced system prompt
  workingMessages = injectSystemPrompt(workingMessages);

  // 2. Convert prior assistant tool_calls to text blocks (so upstream sees
  //    its own previous "calls" in the format it's instructed to use)
  workingMessages = convertAssistantToolCallsToText(workingMessages);

  // 3. Convert tool results to text blocks
  workingMessages = convertToolResultsToText(workingMessages);

  // 4. Convert tools array to text instruction (remove from upstream payload)
  const instruction = toolsToTextInstruction(tools);
  if (instruction) {
    // Append the tool instruction to the last user message or create one
    const lastUserMsg = workingMessages
      .slice()
      .reverse()
      .find(m => m.role === 'user');

    if (lastUserMsg) {
      appendTextToMessageContent(lastUserMsg, instruction);
    } else {
      workingMessages.push({ role: 'user', content: instruction });
    }
  }

  return { messages: workingMessages, tools: undefined };
}

// ---------------------------------------------------------------------------
// Helpers for robust tool-call parsing
// ---------------------------------------------------------------------------
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeToolCallArguments(args) {
  // Preferred shape:
  //   "arguments": { ... }
  if (isPlainObject(args)) return args;

  // Some models incorrectly emit:
  //   "arguments": "{\"path\":\".\"}"
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args);
      if (isPlainObject(parsed)) return parsed;
    } catch (e) {
      return null;
    }
  }

  return null;
}

function normalizeToolCallObject(parsed) {
  if (!isPlainObject(parsed)) return null;

  const name = parsed.name;
  if (typeof name !== 'string' || name.trim().length === 0) return null;

  const args = normalizeToolCallArguments(parsed.arguments);
  if (!args) return null;

  return {
    name: name.trim(),
    arguments: args,
  };
}

function createToolCall(normalized, index) {
  return {
    id: `call_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 8)}`,
    type: 'function',
    function: {
      name: normalized.name,
      arguments: JSON.stringify(normalized.arguments),
    },
  };
}

function isStandaloneJsonCandidate(text, start, end) {
  const before = text.slice(0, start).replace(/[ \t\r]+$/, '');
  const after = text.slice(end + 1).replace(/^[ \t\r]+/, '');

  const beforeChar = before.slice(-1);
  const afterChar = after.slice(0, 1);

  // Accept raw JSON only when it is reasonably isolated from normal prose.
  // This helps avoid treating arbitrary embedded JSON examples as tool calls.
  const allowedBefore = ['', '\n', ':', '>', '`', '-', '*', '{', '['];
  const allowedAfter = ['', '\n', '.', ':', ';', ',', '`', '-', '*', '}', ']'];

  return allowedBefore.includes(beforeChar) && allowedAfter.includes(afterChar);
}

function extractStandaloneToolCallJsonCandidates(text) {
  const candidates = [];
  let cursor = 0;

  while (cursor < text.length) {
    const start = text.indexOf('{', cursor);
    if (start === -1) break;

    // Cheap prefilter before doing balanced-brace scanning.
    const lookahead = text.slice(start, Math.min(text.length, start + 5000));
    if (!/"name"\s*:/.test(lookahead) || !/"arguments"\s*:/.test(lookahead)) {
      cursor = start + 1;
      continue;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
      } else {
        if (ch === '"') {
          inString = true;
        } else if (ch === '{') {
          depth += 1;
        } else if (ch === '}') {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
    }

    if (end === -1) {
      cursor = start + 1;
      continue;
    }

    if (isStandaloneJsonCandidate(text, start, end)) {
      candidates.push(text.slice(start, end + 1));
    }

    cursor = end + 1;
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Parse tool calls from upstream plain-text response
// Returns an array of parsed tool call objects or null if none found.
//
// Parsing order:
//   1. Preferred fenced blocks:
//        ```json
//        {"name": "...", "arguments": {...}}
//        ```
//   2. Fallback standalone raw JSON tool calls:
//        {"name": "...", "arguments": {...}}
// ---------------------------------------------------------------------------
function parseToolCallsFromText(text) {
  if (typeof text !== 'string' || !text.trim()) return null;

  const toolCalls = [];
  const seen = new Set();

  const addParsed = (parsed) => {
    const normalized = normalizeToolCallObject(parsed);
    if (!normalized) return false;

    const key = `${normalized.name}::${JSON.stringify(normalized.arguments)}`;
    if (seen.has(key)) return true;

    seen.add(key);
    toolCalls.push(createToolCall(normalized, toolCalls.length));
    return true;
  };

  // 1. Preferred fenced blocks.
  const fencedMatches = [...text.matchAll(TOOL_CALL_BLOCK_REGEX)];

  for (const match of fencedMatches) {
    const jsonStr = match[1];

    try {
      const parsed = JSON.parse(jsonStr);
      addParsed(parsed);
    } catch (e) {
      console.warn(`[tool-calling-translator] Skipped fenced tool-call block — invalid JSON: ${e.message}`);
    }
  }

  if (toolCalls.length > 0) return toolCalls;

  // 2. Fallback: recover standalone raw JSON tool calls.
  const rawCandidates = extractStandaloneToolCallJsonCandidates(text);

  for (const candidate of rawCandidates) {
    try {
      const parsed = JSON.parse(candidate);
      addParsed(parsed);
    } catch (e) {
      // Ignore invalid raw candidates silently. They may just be normal JSON-like text.
    }
  }

  return toolCalls.length > 0 ? toolCalls : null;
}

// ---------------------------------------------------------------------------
// Strip tool call blocks from text, returning clean content
// ---------------------------------------------------------------------------
function stripToolCallBlocks(text) {
  if (typeof text !== 'string') return text;

  let cleaned = text.replace(TOOL_CALL_BLOCK_REGEX, '');

  const rawCandidates = extractStandaloneToolCallJsonCandidates(cleaned);

  for (const candidate of rawCandidates) {
    try {
      const parsed = JSON.parse(candidate);
      const normalized = normalizeToolCallObject(parsed);

      if (normalized) {
        cleaned = cleaned.split(candidate).join('');
      }
    } catch (e) {
      // Ignore invalid candidates.
    }
  }

  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------------------
// Build a proper OpenAI chat completion response with tool_calls
// ---------------------------------------------------------------------------
function buildToolCallResponse(toolCalls, requestId, model) {
  return {
    id: requestId || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || 'unknown',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: toolCalls,
      },
      finish_reason: FINISH_REASON_TOOL_CALLS,
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// ---------------------------------------------------------------------------
// Build a normal text response (no tool calls detected)
// ---------------------------------------------------------------------------
function buildTextResponse(content, requestId, model) {
  return {
    id: requestId || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || 'unknown',
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: FINISH_REASON_STOP,
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// ---------------------------------------------------------------------------
// Translate upstream response: detect tool calls in text, return proper
// OpenAI response format with finish_reason "tool_calls".
// Preserves extra properties (e.g. _meta) from the original data.
// Also handles upstream models that natively return tool_calls.
// ---------------------------------------------------------------------------
function translateResponse(data, requestId, model) {
  // If upstream already returned native tool_calls, pass through as-is
  const choices = data && data.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const msg = choices[0].message;
    if (msg && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      // Native tool_calls — preserve everything, just ensure finish_reason is set
      const result = { ...data };
      if (result.choices && result.choices[0]) {
        result.choices[0].finish_reason = result.choices[0].finish_reason || FINISH_REASON_TOOL_CALLS;
      }
      return result;
    }
  }

  const content = extractContentFromData(data);
  if (content === null) return data; // Pass through if no content found

  const toolCalls = parseToolCallsFromText(content);
  if (toolCalls) {
    // Upstream returned tool calls in text — build proper OpenAI response
    const result = buildToolCallResponse(toolCalls, requestId, model);

    // Preserve extra properties like _meta from the original data
    if (data && typeof data === 'object') {
      for (const key of Object.keys(data)) {
        if (key !== 'choices' && key !== 'id' && key !== 'object' && key !== 'created' && key !== 'model' && key !== 'usage') {
          result[key] = data[key];
        }
      }
    }

    return result;
  }

  // No tool calls — return normal text response
  const result = buildTextResponse(content, requestId, model);

  // Preserve extra properties
  if (data && typeof data === 'object') {
    for (const key of Object.keys(data)) {
      if (key !== 'choices' && key !== 'id' && key !== 'object' && key !== 'created' && key !== 'model' && key !== 'usage') {
        result[key] = data[key];
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Extract content from various response formats (mirrors proxy-server.js logic)
// ---------------------------------------------------------------------------
function extractContentFromData(data) {
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (!trimmed) return null;

    if (trimmed[0] === '{' || trimmed[0] === '[') {
      try { return extractContentFromData(JSON.parse(trimmed)); } catch (e) {}
    }

    return trimmed;
  }

  if (!data || typeof data !== 'object') return null;

  const choices = data.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const msg = choices[0].message;
    if (msg && typeof msg.content === 'string') return msg.content;
    if (msg && Array.isArray(msg.content)) {
      const text = msg.content.filter(b => b && b.type === 'text').map(b => b.text).join('');
      if (text) return text;
    }

    const delta = choices[0].delta;
    if (delta && typeof delta.content === 'string') return delta.content;

    if (typeof choices[0].text === 'string') return choices[0].text;
  }

  if (typeof data.content === 'string') return data.content;
  if (typeof data.output_text === 'string') return data.output_text;
  if (typeof data.text === 'string') return data.text;
  if (typeof data.answer === 'string') return data.answer;
  if (typeof data.result === 'string') return data.result;
  if (typeof data.reply === 'string') return data.reply;

  return null;
}

// ---------------------------------------------------------------------------
// Streaming variant: process SSE chunks, detect tool calls in accumulated
// text, and emit proper OpenAI SSE chunks with finish_reason "tool_calls"
// ---------------------------------------------------------------------------
function createStreamingToolCallTranslator(res, requestId, model) {
  let headerWritten = false;
  const id = requestId || `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  // `pending` holds text we haven't decided how to handle yet. We only ever
  // emit text to the client once we're sure it isn't part of a fenced tool
  // call block — otherwise a streamed tool call would show up to the client
  // both as raw ```json {...}``` text *and* as a translated tool_calls
  // delta. `state` tracks whether `pending` currently starts mid-fence.
  let pending = '';
  let state = 'NORMAL'; // 'NORMAL' | 'BUFFERING'
  const collectedToolCalls = [];
  let toolCallIndex = 0;

  const writeChunk = (delta, finishReason) => {
    if (!headerWritten) {
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      headerWritten = true;
    }

    const payload = {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason || null }],
    };

    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const emitToolCall = (toolCall) => {
    collectedToolCalls.push(toolCall);
    writeChunk({
      role: 'assistant',
      tool_calls: [{
        index: toolCallIndex++,
        id: toolCall.id,
        type: 'function',
        function: { name: toolCall.function.name, arguments: toolCall.function.arguments },
      }],
    }, null);
  };

  const emitText = (text) => {
    if (text) writeChunk({ content: text }, null);
  };

  // Process as much of `pending` as we currently can, given `state`.
  // Anything left in `pending` afterward is genuinely undecidable until
  // more data (or end-of-stream) arrives.
  const drain = () => {
    for (;;) {
      if (state === 'NORMAL') {
        const fenceIdx = pending.indexOf('```');
        if (fenceIdx === -1) {
          // No fence in sight — everything so far is safe to stream as-is.
          emitText(pending);
          pending = '';
          return;
        }

        // Emit the safe prefix, then start buffering from the fence.
        emitText(pending.slice(0, fenceIdx));
        pending = pending.slice(fenceIdx);
        state = 'BUFFERING';
        // fall through to BUFFERING handling in the next loop iteration
      } else {
        const closeIdx = pending.indexOf('```', 3);
        if (closeIdx === -1) {
          // Fence not closed yet — keep buffering, wait for more chunks.
          return;
        }

        const block = pending.slice(0, closeIdx + 3);
        pending = pending.slice(closeIdx + 3);
        state = 'NORMAL';

        const toolCalls = parseToolCallsFromText(block);
        if (toolCalls && toolCalls.length > 0) {
          toolCalls.forEach(emitToolCall);
        } else {
          // Looked like a fence but wasn't a valid tool call (e.g. a normal
          // code snippet in the reply) — release it as ordinary text.
          emitText(block);
        }

        // loop again in case more fences follow in the remaining `pending`
      }
    }
  };

  return {
    processChunk(chunkData) {
      const text = extractContentFromData(chunkData);
      if (text) {
        pending += text;
        drain();
      }
    },

    finalize() {
      // Stream ended. If we're still sitting on a partial/unclosed fence,
      // give it one last chance to parse as a complete tool call (some
      // upstreams omit a trailing newline before the final [DONE]); if it
      // doesn't parse, release it as plain text rather than dropping it.
      if (pending) {
        if (state === 'BUFFERING') {
          const toolCalls = parseToolCallsFromText(pending);
          if (toolCalls && toolCalls.length > 0) {
            toolCalls.forEach(emitToolCall);
          } else {
            emitText(pending);
          }
        } else {
          emitText(pending);
        }
        pending = '';
      }

      if (collectedToolCalls.length > 0) {
        writeChunk({}, FINISH_REASON_TOOL_CALLS);
      } else {
        writeChunk({}, FINISH_REASON_STOP);
      }

      // Emit usage chunk
      writeChunk({}, null);
      res.write('data: [DONE]\n\n');
      res.end();
    },
  };
}

module.exports = {
  FORCED_SYSTEM_PROMPT,
  toolsToTextInstruction,
  appendTextToMessageContent,
  convertAssistantToolCallsToText,
  convertToolResultsToText,
  injectSystemPrompt,
  translateRequest,
  parseToolCallsFromText,
  stripToolCallBlocks,
  buildToolCallResponse,
  buildTextResponse,
  translateResponse,
  extractContentFromData,
  createStreamingToolCallTranslator,
};