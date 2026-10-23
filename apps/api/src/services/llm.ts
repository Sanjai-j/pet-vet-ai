import { config } from '../config.js';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export function llmConfigured(): boolean {
  return config.llm.provider !== 'none' && Boolean(config.llm.apiKey);
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
      console.warn(`[llm] provider returned ${response.status}`);
      return null;
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content?.trim();
    return text || null;
  } catch (err) {
    console.warn('[llm] request failed', (err as Error).message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
