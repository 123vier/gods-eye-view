import { planTextCommandCalls } from './textCommandPlan.js';

const TEXT_COMMAND_URL = '/api/text-command';

/** How long the not-understood panel stays open without interaction. */
const HELP_HIDE_MS = 20_000;

/**
 * Commands verified to resolve to tools, offered when a sentence is not
 * understood. Clicking one runs it; the model accepts any language.
 */
export const TEXT_COMMAND_EXAMPLES = Object.freeze([
  'fly to Times Square',
  'circle around JFK airport',
  'stop the orbit',
  'zoom in',
  'show the whole earth',
  'turn on flights',
  'show ships',
  'night vision on',
  'thermal view',
  'follow the nearest aircraft over Frankfurt',
]);

/**
 * Send one typed sentence to the server proxy and run the returned tool calls
 * locally, in order, through the voice agent's action runner.
 * @param {string} text
 * @param {{runner: Function, fetchImpl?: Function}} deps
 * @returns {Promise<{ok: boolean, message: string, results: Array}>}
 */
export async function runTextCommand(text, { runner, fetchImpl = fetch }) {
  const response = await fetchImpl(TEXT_COMMAND_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 429)
    return {
      ok: false,
      message: 'Too many commands — wait a few seconds and try again.',
      results: [],
    };
  if (!response.ok)
    return {
      ok: false,
      message: data?.error || `Request failed (${response.status})`,
      results: [],
    };

  const plan = planTextCommandCalls(data.calls, text);
  if (!plan.length) {
    return {
      ok: false,
      noMatch: true,
      message: data.reply || 'Command not recognized.',
      results: [],
    };
  }

  const results = [];
  for (const call of plan) {
    let result;
    try {
      result = await runner(call.name, call.args);
    } catch (error) {
      result = { ok: false, error: error?.message || String(error) };
    }
    results.push({ name: call.name, result });
    if (result?.ok === false) {
      return {
        ok: false,
        message: `${call.name}: ${result.error || 'failed'}`,
        results,
      };
    }
  }
  return {
    ok: true,
    message: plan.map((call) => call.name).join(' → '),
    results,
  };
}

/** True when a keydown should jump focus into the command box ("/" outside text entry). */
export function isTextCommandShortcut(event) {
  if (
    event.key !== '/' ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.defaultPrevented
  )
    return false;
  const target = event.target;
  if (target?.isContentEditable) return false;
  return !target?.closest?.('input, textarea, select, [contenteditable]');
}

/**
 * Mount the typed-command box above the voice control pill.
 * @param {{root: HTMLElement, runner: Function}} options
 * @returns {{destroy: Function}}
 */
export function mountTextCommand({ root, runner }) {
  root.querySelector('.gev-text-command')?.remove();
  const form = document.createElement('form');
  form.className = 'gev-text-command';
  form.dataset.state = 'idle';
  form.innerHTML = `
    <input type="text" class="gev-text-command-input" maxlength="500" autocomplete="off" spellcheck="false"
      placeholder="Type a command…  ( / )" aria-label="Type an AI command" disabled />
    <div class="gev-text-command-status" aria-live="polite"></div>
    <div class="gev-text-command-help" role="status" hidden>
      <div class="gev-text-command-help-message"></div>
      <div class="gev-text-command-help-kicker">TRY ONE OF THESE — ANY LANGUAGE WORKS</div>
      <div class="gev-text-command-help-examples">
        ${TEXT_COMMAND_EXAMPLES.map((example) => `<button type="button" class="gev-text-command-example">${example}</button>`).join('')}
      </div>
    </div>
  `;
  root.classList.add('has-text-command');
  root.append(form);
  const input = form.querySelector('input');
  const status = form.querySelector('.gev-text-command-status');

  const help = form.querySelector('.gev-text-command-help');
  const helpMessage = form.querySelector('.gev-text-command-help-message');
  let helpTimer = null;

  const hideHelp = () => {
    clearTimeout(helpTimer);
    help.hidden = true;
  };
  const showHelp = (message) => {
    helpMessage.textContent = message;
    help.hidden = false;
    clearTimeout(helpTimer);
    helpTimer = setTimeout(hideHelp, HELP_HIDE_MS);
  };
  const setStatus = (state, message = '') => {
    form.dataset.state = state;
    status.textContent = message;
  };

  fetch(TEXT_COMMAND_URL)
    .then((response) => response.json())
    .then((data) => {
      if (data?.configured) {
        input.disabled = false;
        input.title = `AI command via OpenRouter (${data.model})`;
      } else {
        input.title =
          'Add OPENROUTER_API_KEY to .env to enable typed AI commands';
      }
    })
    .catch(() => {
      input.title = 'Typed AI commands unavailable';
    });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || form.dataset.state === 'busy') return;
    hideHelp();
    setStatus('busy', 'Thinking…');
    try {
      const outcome = await runTextCommand(text, { runner });
      if (outcome.noMatch) {
        setStatus('error', '');
        showHelp(outcome.message);
      } else {
        setStatus(outcome.ok ? 'ok' : 'error', outcome.message);
      }
      if (outcome.ok) input.value = '';
    } catch (error) {
      setStatus('error', error?.message || 'Text command failed');
    }
  });

  help.addEventListener('click', (event) => {
    const example = event.target.closest?.('.gev-text-command-example');
    if (!example) return;
    input.value = example.textContent;
    form.requestSubmit();
  });
  // Moving the pointer over the panel keeps it open while the user reads.
  help.addEventListener('pointerenter', () => clearTimeout(helpTimer));
  help.addEventListener('pointerleave', () => {
    if (!help.hidden) helpTimer = setTimeout(hideHelp, HELP_HIDE_MS);
  });

  // Keep typed characters away from the app's global hotkeys (styles, POIs).
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      input.blur();
      setStatus('idle');
      hideHelp();
    }
    event.stopPropagation();
  });

  const onShortcut = (event) => {
    if (input.disabled || !isTextCommandShortcut(event)) return;
    event.preventDefault();
    input.focus();
  };
  document.addEventListener('keydown', onShortcut);

  return {
    destroy() {
      clearTimeout(helpTimer);
      document.removeEventListener('keydown', onShortcut);
      root.classList.remove('has-text-command');
      form.remove();
    },
  };
}
