import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, getConfig, resetConfig } from '../src/config';
import { writeFileSync, unlinkSync } from 'fs';
import { resolve } from 'path';

describe('Config Module', () => {
    const testConfigPath = resolve(__dirname, 'test-config.yaml');

    beforeEach(() => {
        const testYaml = `
server:
  port: 9999
  host: 127.0.0.1
auth:
  jwt_secret: "test_secret"
claude:
  api_key: "sk-test"
runner: {}
terminal: {}
files: {}
memory: {}
lark: {}
tasks: {}
logs: {}
    `;
        writeFileSync(testConfigPath, testYaml);
    });

    afterEach(() => {
        try {
            unlinkSync(testConfigPath);
        } catch (e) { }
    });

    it('should load and parse config correctly', () => {
        const config = loadConfig(testConfigPath);
        expect(config.server.port).toBe(9999);
        expect(config.server.host).toBe('127.0.0.1');
        expect(config.auth.jwt_secret).toBe('test_secret');
    });

    it('should apply defaults correctly', () => {
        const config = loadConfig(testConfigPath);
        expect(config.auth.token_expire_days).toBe(7);
        expect(config.runner.idle_timeout_minutes).toBe(60);
        expect(config.terminal.max_sessions).toBe(5);
    });

    it('should throw error if config file does not exist', () => {
        expect(() => loadConfig(resolve(__dirname, 'non-existent.yaml'))).toThrow();
    });

    it('getConfig should return the loaded config singleton', () => {
        const config = loadConfig(testConfigPath);
        const singleton = getConfig();
        expect(singleton).toBe(config);
    });

    it('getConfig should load default config if not initialized', () => {
        // We already have assistant/config.yaml in CWD
        resetConfig();
        const config = getConfig();
        expect(config.server.port).toBe(8888);
    });
});
