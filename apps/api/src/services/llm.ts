import { config } from '../config.js';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmSettings {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface LlmConfigCheck {
  configured: boolean;
  /** Actionable sentence for the operator, or null when nothing is wrong. */
  problem: string | null;
}

/**
 * Validates the model settings instead of silently degrading.
 *
 * Every one of these mistakes used to end the same way — no key, no model, no
 * error — and the owner could not tell a misconfigured deployment from an
 * intentional deterministic one. A wrong value is reported to the operator and
 * to `/api/health`; it never reaches a browser.
 */
export function checkLlmSettings(settings: LlmSettings): LlmConfigCheck {
  const provider = (settings.provider ?? '').trim().toLowerCase();
  if (!provider || provider === 'none') return { configured: false, problem: null };

  if (provider !== 'openai-compatible') {
    return { configured: false, problem: `LLM_PROVIDER must be "none" or "openai-compatible" (got "${settings.provider}").` };
  }
  if (!(settings.apiKey ?? '').trim()) {
    return { configured: false, problem: 'LLM_PROVIDER is set but LLM_API_KEY is empty, so answers stay deterministic.' };
  }
  if (!(settings.model ?? '').trim()) {
    return { configured: false, problem: 'LLM_PROVIDER is set but LLM_MODEL is empty.' };
  }

  let url: URL;
  try {
    url = new URL(settings.baseUrl);
  } catch {
    return { configured: false, problem: `LLM_BASE_URL is not a valid URL ("${settings.baseUrl}").` };
  }
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !isLocal) {
    return { configured: false, problem: 'LLM_BASE_URL must use https, except for a local model on localhost.' };
  }
  return { configured: true, problem: null };
}

export function llmConfigured(): boolean {
  return checkLlmSettings(config.llm).configured;
}

/** Safe for logs and health output: never includes the key. */
export function llmConfigStatus(): LlmConfigCheck & { provider: string; model: string; host: string } {
  const check = checkLlmSettings(config.llm);
  let host = '';
  try {
    host = new URL(config.llm.baseUrl).host;
  } catch {
    host = '';
  }
  return { ...check, provider: config.llm.provider, model: config.llm.model, host };
}

/**
 * The last provider failure, in the operator's words rather than the model's.
 *
 * "Configured but every answer is deterministic" used to be undiagnosable: a
 * rejected model name, a quota error and a timeout all looked the same in the
 * UI and nowhere in the logs but one terse status number. `/api/health` now
 * reports this string. It is the provider's own response body, truncated, and
 * never contains the key.
 */
let lastProviderError: string | null = null;

export function llmLastError(): string | null {
  return lastProviderError;
}

function remember(message: string): null {
  lastProviderError = message.slice(0, 300).replace(/\s+/g, ' ').trim();
  return null;
}

export async function llmComplete(messages: LlmMessage[]): Promise<string | null> {
  if (!llmConfigured()) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.llm.timeoutMs);
  try {
    const response = await fetch(`${config.llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.llm.apiKey}`,
      },
      body: JSON.stringify({
        model: config.llm.model,
        temperature: 0.2,
        max_tokens: 550,
        messages,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      // The body explains *why* — unknown model, wrong key, quota — and is the
      // only way to fix a live deployment without guessing.
      const detail = await response.text().catch(() => '');
      console.warn(`[llm] provider returned ${response.status}: ${detail.slice(0, 300)}`);
      return remember(`provider HTTP ${response.status}: ${detail.slice(0, 240)}`);
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) return remember('provider returned an empty message');
    lastProviderError = null;
    return text;
  } catch (err) {
    const reason = (err as Error).name === 'AbortError'
      ? `request timed out after ${config.llm.timeoutMs} ms`
      : (err as Error).message;
    console.warn('[llm] request failed', reason);
    return remember(`request failed: ${reason}`);
  } finally {
    clearTimeout(timeout);
  }
}
