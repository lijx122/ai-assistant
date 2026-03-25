import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { proxyRouter } from '../src/services/proxy';
import { loadConfig, resetConfig, getConfig } from '../src/config';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { resolve } from 'path';

const testConfigPath = resolve(__dirname, 'test-config-proxy.yaml');

describe('Proxy Router (T-2.1)', () => {
    let app: Hono;

    beforeEach(() => {
        app = new Hono();
        app.route('/', proxyRouter);
    });

    afterEach(() => {
        if (existsSync(testConfigPath)) unlinkSync(testConfigPath);
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    const setupConfig = (enabled: boolean, fixedCount?: number) => {
        // Clear env vars that might override YAML config
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.ANTHROPIC_BASE_URL;

        writeFileSync(testConfigPath, `
server: { port: 8888 }
auth: { jwt_secret: "test_secret", token_expire_days: 1 }
claude:
  api_key: "test_key"
  base_url: "https://api.test.com"
  model: "claude-test"
  count_tokens_enabled: ${enabled}
  ${fixedCount ? `count_tokens_fixed: ${fixedCount}` : ''}
runner: {}
terminal: {}
files: {}
memory: {}
lark: {}
tasks: {}
logs: {}
    `);
        resetConfig();
        loadConfig(testConfigPath);
    };

    const makeReq = async (body: any) => {
        return app.request(new Request('http://localhost/v1/messages/count_tokens', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }));
    };

    it('should estimate tokens locally when count_tokens_enabled is false', async () => {
        setupConfig(false);
        const res = await makeReq({
            system: "1234", // 4 chars -> 1 token
            messages: [
                { role: 'user', content: '12345678' }, // 8 chars -> 2 tokens
                { role: 'user', content: [{ type: 'text', text: '1234' }] } // 4 chars -> 1 token
            ]
        });
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.input_tokens).toBe(4); // 1 + 2 + 1 = 4
    });

    it('should apply count_tokens_fixed cap when estimating locally', async () => {
        setupConfig(false, 2); // Cap at 2 tokens
        const res = await makeReq({
            system: "12345678", // 8 chars -> 2 tokens
            messages: [
                { role: 'user', content: '12345678' } // 8 chars -> 2 tokens, total 4
            ]
        });
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.input_tokens).toBe(2); // Capped at 2
    });

    it('should pass-through to real API when count_tokens_enabled is true', async () => {
        setupConfig(true);

        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ input_tokens: 42, type: "message_metrics" })
        });
        vi.stubGlobal('fetch', fetchMock);

        const reqBody = { system: "test", messages: [{ role: 'user', content: 'test message' }] };
        const res = await makeReq(reqBody);

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.input_tokens).toBe(42);

        // Verify fetch was called with correct parameters
        expect(fetchMock).toHaveBeenCalled();
        const [fetchUrl, fetchOptions] = fetchMock.mock.calls[0];
        expect(fetchUrl).toContain('/v1/messages/count_tokens');
        expect(fetchOptions.method).toBe('POST');
        expect(fetchOptions.body).toBe(JSON.stringify(reqBody));
    });

    it('should handle API errors when pass-through is enabled', async () => {
        setupConfig(true);

        const fetchMock = vi.fn().mockResolvedValue({
            ok: false,
            status: 400
        });
        vi.stubGlobal('fetch', fetchMock);

        const res = await makeReq({});
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toBe('Upstream API error');
    });

    it('should handle fetch failures gracefully when pass-through is enabled', async () => {
        setupConfig(true);

        const fetchMock = vi.fn().mockRejectedValue(new Error('Network error'));
        vi.stubGlobal('fetch', fetchMock);

        const res = await makeReq({});
        expect(res.status).toBe(502);
        const data = await res.json();
        expect(data.error).toBe('Proxy fetch failed');
    });

    it('should return 0 tokens for empty body when local estimation is used', async () => {
        setupConfig(false);
        const res = await makeReq({});
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.input_tokens).toBe(0);
    });
});
