import { existsSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadReplayEnvironment } from '../server/config/environment.js';

let directory: string;
const keyName = 'AI_DOU_ENV_TEST_KEY';
const modelName = 'AI_DOU_ENV_TEST_MODEL';

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'ai-dou-env-test-'));
  vi.stubEnv(keyName, undefined);
  vi.stubEnv(modelName, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const filename of ['.env', '.env.local']) {
    const path = join(directory, filename);
    if (existsSync(path)) unlinkSync(path);
  }
  rmdirSync(directory);
});

describe('local replay server environment', () => {
  it('loads .env when no local override exists', () => {
    writeFileSync(join(directory, '.env'), keyName + '=test-only-key\n' + modelName + '=test-model\n');
    loadReplayEnvironment(directory);
    expect(process.env[keyName]).toBe('test-only-key');
    expect(process.env[modelName]).toBe('test-model');
  });

  it('still supports .env.local without .env', () => {
    writeFileSync(join(directory, '.env.local'), keyName + '=local-test-key\n');
    loadReplayEnvironment(directory);
    expect(process.env[keyName]).toBe('local-test-key');
  });

  it('prioritizes .env.local and fills missing values from .env', () => {
    writeFileSync(join(directory, '.env.local'), keyName + '=local-test-key\n');
    writeFileSync(join(directory, '.env'), keyName + '=base-test-key\n' + modelName + '=base-test-model\n');
    loadReplayEnvironment(directory);
    expect(process.env[keyName]).toBe('local-test-key');
    expect(process.env[modelName]).toBe('base-test-model');
  });

  it('preserves existing process environment values, including an explicit empty value', () => {
    vi.stubEnv(keyName, 'process-test-key');
    vi.stubEnv(modelName, '');
    writeFileSync(join(directory, '.env.local'), keyName + '=local-test-key\n' + modelName + '=local-test-model\n');
    writeFileSync(join(directory, '.env'), keyName + '=base-test-key\n' + modelName + '=base-test-model\n');
    loadReplayEnvironment(directory);
    expect(process.env[keyName]).toBe('process-test-key');
    expect(process.env[modelName]).toBe('');
  });

  it('does not require either environment file to exist', () => {
    loadReplayEnvironment(directory);
    expect(process.env[keyName]).toBeUndefined();
    expect(process.env[modelName]).toBeUndefined();
  });
});
