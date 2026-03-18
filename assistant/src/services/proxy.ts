import { Hono } from 'hono';
import { getConfig } from '../config';

export const proxyRouter = new Hono();

// Proxies Anthropic's count_tokens endpoint or estimates locally
proxyRouter.post('/v1/messages/count_tokens', async (c) => {
    const config = getConfig();
    const body = await c.req.json().catch(() => ({}));

    if (!config.claude.count_tokens_enabled) {
        // Local estimation: 1 token ~= 4 chars of text
        let estimatedTokens = 0;

        if (body.system) {
            estimatedTokens += Math.ceil(String(body.system).length / 4);
        }

        if (Array.isArray(body.messages)) {
            for (const msg of body.messages) {
                if (typeof msg.content === 'string') {
                    estimatedTokens += Math.ceil(msg.content.length / 4);
                } else if (Array.isArray(msg.content)) {
                    for (const block of msg.content) {
                        if (block.type === 'text' && block.text) {
                            estimatedTokens += Math.ceil(String(block.text).length / 4);
                        }
                    }
                }
            }
        }

        // Apply fixed cap if applicable
        if (config.claude.count_tokens_fixed && estimatedTokens > config.claude.count_tokens_fixed) {
            estimatedTokens = config.claude.count_tokens_fixed;
        }

        return c.json({
            input_tokens: estimatedTokens,
            type: "message_metrics"
        });
    }

    // Pass-through to real API if enabled
    try {
        const response = await fetch(`${config.anthropicBaseUrl}/v1/messages/count_tokens`, {
            method: 'POST',
            headers: {
                'x-api-key': config.anthropicApiKey,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            return c.json({ error: 'Upstream API error' }, response.status as any);
        }

        const data = await response.json();
        return c.json(data);
    } catch (error) {
        return c.json({ error: 'Proxy fetch failed' }, 502);
    }
});
