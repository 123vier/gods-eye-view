// Typed AI commands (OpenRouter): one LLM call turns a sentence into tool calls,
// which then run locally through the same runGevAction the voice agent uses.
// Shared by the server proxy (tool allowlist) and the browser (call planning).

/**
 * Voice tools a typed command may trigger. Only fire-and-forget controls are
 * listed: query tools (get_entity_context, analyst_query, …) exist to feed a
 * result back to the model, and a single-shot text command has no second turn.
 */
export const TEXT_COMMAND_TOOL_NAMES = Object.freeze([
  'fly_to_location',
  'select_nearest_aircraft',
  'adjust_camera_zoom',
  'zoom_to_globe',
  'set_layer_visibility',
  'set_panel_open',
  'set_context_mode',
  'control_cockpit',
  'set_visual_style',
  'set_hud',
  'set_detection',
  'set_map_stack',
  'set_post_processing',
  'control_radio',
  'track_entity',
  'stop_tracking',
  'frame_overhead',
  'annotate_map',
  'clear_annotations',
  'move_camera',
  'fly_route',
]);

const ALLOWED = new Set(TEXT_COMMAND_TOOL_NAMES);

/** Upper bound on calls executed for one typed sentence. */
export const TEXT_COMMAND_MAX_CALLS = 6;

const ORBIT_WORDS =
  /\b(orbit\w*|circl\w*|kreis\w*|umkreis\w*|umrund\w*|rundflug|360)\b|drumherum|herum fliegen/i;
const SLOW_WORDS = /\b(slow\w*|langsam\w*)\b/i;
const FAST_WORDS = /\b(fast\w*|quick\w*|schnell\w*)\b/i;

/**
 * Sanitize model tool calls into an executable plan. Unknown tools and
 * non-object args are dropped. A flight followed by more calls waits for
 * arrival, so "fly to JFK and orbit" orbits JFK rather than the departure view.
 * Smaller models reliably emit the flight for "circle around X" but often drop
 * the orbit; when the typed text asks for one, it is appended here.
 * @param {Array<{name?: string, args?: object}>} calls
 * @param {string} [text] - The operator's typed command.
 * @returns {Array<{name: string, args: object}>}
 */
export function planTextCommandCalls(calls, text = '') {
  const plan = (Array.isArray(calls) ? calls : [])
    .filter((call) => ALLOWED.has(call?.name))
    .slice(0, TEXT_COMMAND_MAX_CALLS)
    .map((call) => ({
      name: call.name,
      args:
        call.args && typeof call.args === 'object' && !Array.isArray(call.args)
          ? { ...call.args }
          : {},
    }));
  const wantsOrbit = ORBIT_WORDS.test(String(text));
  const hasCameraMove = plan.some((call) => call.name === 'move_camera');
  if (
    wantsOrbit &&
    !hasCameraMove &&
    plan.some((call) => call.name === 'fly_to_location') &&
    plan.length < TEXT_COMMAND_MAX_CALLS
  ) {
    const speed = SLOW_WORDS.test(text)
      ? 'slow'
      : FAST_WORDS.test(text)
        ? 'fast'
        : 'normal';
    plan.push({
      name: 'move_camera',
      args: { motion: 'orbit', mode: 'continuous', speed },
    });
  }
  plan.forEach((call, index) => {
    if (call.name === 'fly_to_location' && index < plan.length - 1)
      call.args.waitForArrival = true;
  });
  return plan;
}
