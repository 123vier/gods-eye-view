import { planTextCommandCalls } from './textCommandPlan.js';

const TEXT_COMMAND_URL = '/api/text-command';

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
  if (!response.ok) return { ok: false, message: data?.error || `Request failed (${response.status})`, results: [] };

  const plan = planTextCommandCalls(data.calls, text);
  if (!plan.length) return { ok: false, message: data.reply || 'No matching command', results: [] };

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
      return { ok: false, message: `${call.name}: ${result.error || 'failed'}`, results };
    }
  }
  return { ok: true, message: plan.map((call) => call.name).join(' → '), results };
}

/** True when a keydown should jump focus into the command box ("/" outside text entry). */
export function isTextCommandShortcut(event) {
  if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return false;
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
  `;
  root.classList.add('has-text-command');
  root.append(form);
  const input = form.querySelector('input');
  const status = form.querySelector('.gev-text-command-status');

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
        input.title = 'Add OPENROUTER_API_KEY to .env to enable typed AI commands';
      }
    })
    .catch(() => {
      input.title = 'Typed AI commands unavailable';
    });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || form.dataset.state === 'busy') return;
    setStatus('busy', 'Thinking…');
    try {
      const outcome = await runTextCommand(text, { runner });
      setStatus(outcome.ok ? 'ok' : 'error', outcome.message);
      if (outcome.ok) input.value = '';
    } catch (error) {
      setStatus('error', error?.message || 'Text command failed');
    }
  });

  // Keep typed characters away from the app's global hotkeys (styles, POIs).
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      input.blur();
      setStatus('idle');
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
      document.removeEventListener('keydown', onShortcut);
      root.classList.remove('has-text-command');
      form.remove();
    },
  };
}
