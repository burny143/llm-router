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
const FORCED_SYSTEM_PROMPT = [
  'You are a powerful AI assistant running behind a tool-calling proxy.',
  'When you need to use a tool, you MUST reply ONLY with one or more of these blocks and nothing else:',
  '```',
  '{"name": "exact_tool_name", "arguments": { ... }}',
  '```',
  'Rules:',
  '- Use the exact tool names that were provided to you.',
  '- Arguments must be valid JSON.',
  '- You can output multiple code blocks if you need several tools.',
  '- If you do not need any tool, reply with normal helpful text (no code blocks).',
  '- Never invent tools that were not given to you.',
].join('\n');

// ---------------------------------------------------------------------------
// Regex for parsing tool-call blocks from upstream plain-text responses.
// Matches code fences (``` or ```json) containing a JSON object with
// "name" and "arguments" keys.
// Uses a two-pass approach: first extract the JSON string from the code block,
// then parse it to avoid brace-matching issues.
// ---------------------------------------------------------------------------
const TOOL_CALL_BLOCK_REGEX = /```(?:json)?\s*\n?(\{[\s\S]*?\})\s*\n?```/gi;
const TOOL_CALL_INNER_REGEX = /\s*"name"\s*:\s*"([^"]+)"\s*,\s*"arguments"\s*:\s*(\{[\s\S]*?\})\s*$/;

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
    'The following tools are available for you to use. When you need to call a tool,',
    'output the tool call in this exact format (one code block per tool):',
    '',
    '```',
    '{"name": "tool_name", "arguments": {"param1": "value1", ...}}',
    '```',
    '',
    'Available tools:',
    toolDescriptions,
    '',
    'If none of the tools are needed, reply with normal helpful text.',
  ].join('\n');
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

  // 2. Convert tool results to text blocks
  workingMessages = convertToolResultsToText(workingMessages);

  // 3. Convert tools array to text instruction (remove from upstream payload)
  const instruction = toolsToTextInstruction(tools);
  if (instruction) {
    // Append the tool instruction to the last user message or create one
    const lastUserMsg = workingMessages
      .slice()
      .reverse()
      .find(m => m.role === 'user');
    if (lastUserMsg) {
      lastUserMsg.content += '\n\n' + instruction;
    } else {
      workingMessages.push({ role: 'user', content: instruction });
    }
  }

  return { messages: workingMessages, tools: undefined };
}

// ---------------------------------------------------------------------------
// Parse tool calls from upstream plain-text response
// Returns an array of parsed tool call objects or null if none found.
// ---------------------------------------------------------------------------
function parseToolCallsFromText(text) {
  if (typeof text !== 'string' || !text.trim()) return null;

  const blockMatches = [...text.matchAll(TOOL_CALL_BLOCK_REGEX)];
  if (blockMatches.length === 0) return null;

  const toolCalls = [];
  for (const blockMatch of blockMatches) {
    const jsonStr = blockMatch[1];
    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      console.warn(`[tool-calling-translator] Skipped tool call block — invalid JSON: ${e.message}`);
      continue;
    }

    const name = parsed.name;
    const args = parsed.arguments;
    if (typeof name !== 'string' || !name) {
      console.warn('[tool-calling-translator] Skipped tool call block — missing or invalid "name"');
      continue;
    }
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      console.warn(`[tool-calling-translator] Skipped tool call "${name}" — arguments is not a JSON object`);
      continue;
    }

    toolCalls.push({
      id: `call_${Date.now()}_${toolCalls.length}`,
      type: 'function',
      function: {
        name,
        arguments: JSON.stringify(args),
      },
    });
  }

  return toolCalls.length > 0 ? toolCalls : null;
}

// ---------------------------------------------------------------------------
// Strip tool call blocks from text, returning clean content
// ---------------------------------------------------------------------------
function stripToolCallBlocks(text) {
  if (typeof text !== 'string') return text;
  return text.replace(TOOL_CALL_BLOCK_REGEX, '').trim();
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
      finish_reason: 'tool_calls',
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
      finish_reason: 'stop',
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
        result.choices[0].finish_reason = result.choices[0].finish_reason || 'tool_calls';
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
  let accumulatedText = '';
  let headerWritten = false;
  const id = requestId || `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

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

  return {
    processChunk(chunkData) {
      const text = extractContentFromData(chunkData);
      if (text) {
        accumulatedText += text;
        // Stream the raw text to the client as it arrives
        writeChunk({ content: text }, null);
      }
    },

    finalize() {
      // After all chunks received, check if accumulated text contains tool calls
      const toolCalls = parseToolCallsFromText(accumulatedText);
      if (toolCalls) {
        // Emit the final tool_calls chunk
        writeChunk({
          role: 'assistant',
          tool_calls: toolCalls.map((tc, i) => ({
            index: i,
            id: tc.id,
            type: 'function',
            function: { name: tc.function.name, arguments: tc.function.arguments },
          })),
        }, null);
        writeChunk({}, 'tool_calls');
      } else {
        // No tool calls — emit stop
        writeChunk({}, 'stop');
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
