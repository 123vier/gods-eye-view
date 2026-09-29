import { readRequestBody } from '../common/request.js';
import { makeOptInRateLimiter } from '../common/rate-limit.js';
import { enforceOptInRateLimit } from '../openai/rate-limit.js';
import { GEV_REALTIME_TOOLS } from '../openai/tools.js';
import { TEXT_COMMAND_TOOL_NAMES } from '../../../src/voice/textCommandPlan.js';

const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL_DEFAULT = 'anthropic/claude-haiku-4.5';
const MAX_TEXT_LENGTH = 500;

const SYSTEM_PROMPT = [
  "You control God's Eye View, a 3D globe console, for an operator who types commands in any language.",
  'Translate the command into tool calls. This is a single turn: you will NOT see tool results, so emit EVERY tool call the command needs in this one response, in the order they should run. Never ask questions.',
  'For fly_to_location use `query` with a precise, geocodable place name (e.g. "John F. Kennedy International Airport, New York").',
  'To circle / orbit around a place: fly_to_location, then move_camera with motion=orbit and mode=continuous.',
  "If no tool fits, reply with at most one short sentence in the operator's language instead; otherwise add no text.",
].join(' ');

/** First sentence, capped — the voice descriptions are written for a long spoken session. */
function shortDescription(text, max) {
  const value = String(text || '');
  const sentence = value.match(/^.*?[.!?](\s|$)/)?.[0]?.trim() || value;
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}

function compactSchema(node) {
  if (Array.isArray(node)) return node.map(compactSchema);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'description') out[key] = shortDescription(value, 120);
    else out[key] = compactSchema(value);
  }
  return out;
}

/**
 * The allowlisted voice tools in Chat Completions format with trimmed prose.
 * Exported for tests.
 */
export function textCommandTools(tools = GEV_REALTIME_TOOLS) {
  const allowed = new Set(TEXT_COMMAND_TOOL_NAMES);
  return tools
    .filter((tool) => allowed.has(tool.name))
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: shortDescription(tool.description, 240),
        parameters: compactSchema(
          tool.parameters || { type: 'object', properties: {} },
        ),
      },
    }));
}

/** Chat Completions message → [{name, args}], tolerating malformed argument JSON. Exported for tests. */
export function extractToolCalls(message) {
  return (Array.isArray(message?.tool_calls) ? message.tool_calls : [])
    .map((call) => {
      let args = {};
      try {
        args = JSON.parse(call?.function?.arguments || '{}');
      } catch {
        args = {};
      }
      return { name: call?.function?.name, args };
    })
    .filter((call) => typeof call.name === 'string');
}

// Built lazily on first use: `.env` reaches process.env only after this module
// loads. Rebuilt when the value changes, so the per-IP window state otherwise
// persists across requests. `null` = unlimited (the default).
let _rateLimiter = null;
let _rateLimiterEnv;

/** Opt-in per-IP throttle for command requests (GEV_RATELIMIT_OPENROUTER_PER_MIN). */
function textCommandRateLimiter() {
  const value = process.env.GEV_RATELIMIT_OPENROUTER_PER_MIN;
  if (value !== _rateLimiterEnv) {
    _rateLimiterEnv = value;
    _rateLimiter = makeOptInRateLimiter(value);
  }
  return _rateLimiter;
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

async function handleTextCommand(req, res) {
  const apiKey = String(process.env.OPENROUTER_API_KEY || '').trim();
  const model =
    String(process.env.OPENROUTER_MODEL || '').trim() ||
    OPENROUTER_MODEL_DEFAULT;

  if (req.method === 'GET') {
    sendJson(res, 200, { configured: !!apiKey, model: apiKey ? model : null });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }
  // Only commands spend OpenRouter credit; the config check above is free.
  if (!enforceOptInRateLimit(textCommandRateLimiter(), req, res)) return;
  if (!apiKey) {
    sendJson(res, 503, { error: 'OPENROUTER_API_KEY is not configured' });
    return;
  }

  try {
    const body = JSON.parse((await readRequestBody(req, 16 * 1024)) || '{}');
    const text = String(body.text || '')
      .trim()
      .slice(0, MAX_TEXT_LENGTH);
    if (!text) {
      sendJson(res, 400, { error: 'Empty command' });
      return;
    }
    const response = await fetch(OPENROUTER_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': "God's Eye View",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
        tools: textCommandTools(),
        tool_choice: 'auto',
        parallel_tool_calls: true,
        temperature: 0,
        max_tokens: 800,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      sendJson(res, 502, {
        error:
          data?.error?.message ||
          `OpenRouter request failed (${response.status})`,
      });
      return;
    }
    const message = data?.choices?.[0]?.message;
    sendJson(res, 200, {
      calls: extractToolCalls(message),
      reply: typeof message?.content === 'string' ? message.content.trim() : '',
      model: data?.model || model,
    });
  } catch (error) {
    sendJson(res, 502, { error: error?.message || 'Text command failed' });
  }
}

/** Vite plugin: typed AI commands via OpenRouter, key kept server-side. */
function openRouterTextCommandProxy() {
  function install(middlewares) {
    middlewares.use('/api/text-command', handleTextCommand);
  }
  return {
    name: 'openrouter-text-command-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export {
  handleTextCommand,
  openRouterTextCommandProxy,
  OPENROUTER_MODEL_DEFAULT,
};
