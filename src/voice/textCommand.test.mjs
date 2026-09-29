// Typed AI commands: plan sanitizing, tool compaction, and local execution order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTextCommandCalls, TEXT_COMMAND_TOOL_NAMES } from './textCommandPlan.js';
import { runTextCommand, isTextCommandShortcut, TEXT_COMMAND_EXAMPLES } from './textCommand.js';
import { textCommandTools, extractToolCalls } from '../../server/providers/openrouter/text-command.js';
import { GEV_REALTIME_TOOLS } from '../../server/providers/openai/tools.js';

test('every allowlisted text command is a real voice tool', () => {
  const voiceTools = new Set(GEV_REALTIME_TOOLS.map((tool) => tool.name));
  for (const name of TEXT_COMMAND_TOOL_NAMES) assert.ok(voiceTools.has(name), name);
  assert.equal(textCommandTools().length, TEXT_COMMAND_TOOL_NAMES.length);
});

test('compacted tools keep Chat Completions shape and enums, and stay small', () => {
  const tools = textCommandTools();
  const move = tools.find((tool) => tool.function.name === 'move_camera');
  assert.equal(move.type, 'function');
  assert.deepEqual(move.function.parameters.properties.motion.enum, ['orbit', 'pan', 'tilt', 'rotate', 'stop']);
  assert.ok(JSON.stringify(tools).length < 20000);
});

test('planTextCommandCalls drops unknown tools and waits for arrival before follow-ups', () => {
  const plan = planTextCommandCalls([
    { name: 'fly_to_location', args: { query: 'JFK Airport' } },
    { name: 'analyst_query', args: {} },
    { name: 'move_camera', args: { motion: 'orbit', mode: 'continuous' } },
  ]);
  assert.deepEqual(plan.map((call) => call.name), ['fly_to_location', 'move_camera']);
  assert.equal(plan[0].args.waitForArrival, true);
  assert.equal(planTextCommandCalls([{ name: 'fly_to_location', args: { query: 'x' } }])[0].args.waitForArrival, undefined);
});

test('extractToolCalls tolerates malformed argument JSON', () => {
  const calls = extractToolCalls({
    tool_calls: [
      { function: { name: 'zoom_to_globe', arguments: '{}' } },
      { function: { name: 'move_camera', arguments: '{not json' } },
    ],
  });
  assert.deepEqual(calls, [{ name: 'zoom_to_globe', args: {} }, { name: 'move_camera', args: {} }]);
});

test('runTextCommand executes calls in order and stops at the first failure', async () => {
  const ran = [];
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ calls: [
      { name: 'fly_to_location', args: { query: 'Times Square' } },
      { name: 'move_camera', args: { motion: 'orbit' } },
      { name: 'set_hud', args: {} },
    ] }),
  });
  const runner = async (name) => {
    ran.push(name);
    return name === 'move_camera' ? { ok: false, error: 'no target' } : { ok: true };
  };
  const outcome = await runTextCommand('fly to times square and orbit', { runner, fetchImpl });
  assert.deepEqual(ran, ['fly_to_location', 'move_camera']);
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /move_camera: no target/);
});

test('runTextCommand surfaces the model reply when no tool fits', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ calls: [], reply: 'Dafür gibt es keinen Befehl.' }) });
  const outcome = await runTextCommand('mach Kaffee', { runner: async () => ({ ok: true }), fetchImpl });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.noMatch, true);
  assert.equal(outcome.message, 'Dafür gibt es keinen Befehl.');
});

test('"/" focuses the box only outside text entry', () => {
  const outside = { key: '/', target: { closest: () => null } };
  const inInput = { key: '/', target: { closest: () => ({}) } };
  assert.equal(isTextCommandShortcut(outside), true);
  assert.equal(isTextCommandShortcut(inInput), false);
  assert.equal(isTextCommandShortcut({ ...outside, ctrlKey: true }), false);
});

test('a typed orbit request adds the orbit the model left out', () => {
  const flight = [{ name: 'fly_to_location', args: { query: 'JFK' } }];
  const plan = planTextCommandCalls(flight, 'flieg zum JFK und kreise langsam drumherum');
  assert.deepEqual(plan.map((call) => call.name), ['fly_to_location', 'move_camera']);
  assert.deepEqual(plan[1].args, { motion: 'orbit', mode: 'continuous', speed: 'slow' });
  assert.equal(plan[0].args.waitForArrival, true);
  assert.equal(planTextCommandCalls(flight, 'bring mich zum times square').length, 1);
  const explicit = [...flight, { name: 'move_camera', args: { motion: 'orbit', speed: 'fast' } }];
  assert.equal(planTextCommandCalls(explicit, 'circle around JFK').length, 2);
});

test('an unknown tool or empty reply still reports a not-recognized outcome', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ calls: [{ name: 'analyst_query', args: {} }], reply: '' }) });
  const outcome = await runTextCommand('what is this?', { runner: async () => ({ ok: true }), fetchImpl });
  assert.deepEqual([outcome.noMatch, outcome.message], [true, 'Command not recognized.']);
  assert.ok(TEXT_COMMAND_EXAMPLES.length >= 6);
});

test('the opt-in rate limit answers 429 before any OpenRouter call', async () => {
  const { handleTextCommand } = await import('../../server/providers/openrouter/text-command.js');
  const saved = { ...process.env };
  process.env.GEV_RATELIMIT_OPENROUTER_PER_MIN = '1';
  delete process.env.OPENROUTER_API_KEY; // a 503 proves the request got past the limiter
  const call = async (method) => {
    const res = { statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } };
    await handleTextCommand({ method, socket: { remoteAddress: '203.0.113.7' } }, res);
    return res;
  };
  try {
    assert.equal((await call('GET')).statusCode, 200, 'the config check is not counted');
    assert.equal((await call('POST')).statusCode, 503);
    const limited = await call('POST');
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.headers['Retry-After'], '5');
  } finally {
    process.env = saved;
  }
});

test('a 429 becomes a readable status message', async () => {
  const outcome = await runTextCommand('fly to Berlin', {
    runner: async () => ({ ok: true }),
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ error: 'Rate limit exceeded' }) }),
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /Too many commands/);
});
