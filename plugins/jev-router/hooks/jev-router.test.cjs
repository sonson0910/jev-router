'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  buildRequest,
  containsSensitiveValue,
  readApiKey,
  routePrompt,
  timeoutFromEnv,
  userAgentFromArgs
} = require('./jev-router.cjs');

const validResponse = {
  answers: {
    workflow: { type: 'choice', choice: 'implement', confidence: 0.91 },
    domain: { type: 'choice', choice: 'backend', confidence: 0.86 },
    risk: { type: 'score', score: 1.4, confidence: 0.78 },
    execution: { type: 'choice', choice: 'solo', confidence: 0.93 }
  }
};

test('builds the documented System One request shape', () => {
  const body = buildRequest('fix the API');
  assert.equal(body.model, 'jev-latest');
  assert.equal(body.state.task, 'fix the API');
  assert.equal(body.questions.workflow.type, 'choice');
  assert.equal(body.questions.risk.type, 'score');
});

test('skips calls without a key or when the prompt looks sensitive', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; };
  assert.equal((await routePrompt('fix it', { fetchImpl })).reason, 'missing-key');
  assert.equal(containsSensitiveValue('api_key=super-secret-value'), true);
  assert.equal(containsSensitiveValue('Authorization: Bearer hidden-token'), true);
  assert.equal((await routePrompt('api_key=super-secret-value', {
    apiKey: 'test', fetchImpl
  })).reason, 'sensitive-prompt');
  assert.equal(calls, 0);
});

test('injects an advisory hint for a valid response', async () => {
  const result = await routePrompt('fix the API', {
    apiKey: 'test',
    fetchImpl: async () => new Response(JSON.stringify(validResponse), { status: 200 })
  });
  assert.equal(result.status, 'ok');
  assert.match(result.context, /workflow=implement/);
  assert.match(result.context, /Never use Jev to lower risk/);
  assert.doesNotMatch(result.context, /fix the API/);
});

test('fails open on HTTP, invalid response, and timeout', async () => {
  const http = await routePrompt('task', {
    apiKey: 'test',
    fetchImpl: async () => new Response('', { status: 503 })
  });
  assert.deepEqual(http, { status: 'fallback', reason: 'http-503' });

  const invalid = await routePrompt('task', {
    apiKey: 'test',
    fetchImpl: async () => new Response('{}', { status: 200 })
  });
  assert.deepEqual(invalid, { status: 'fallback', reason: 'invalid-response' });

  const timedOut = await routePrompt('task', {
    apiKey: 'test',
    timeoutMs: 10,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {
        name: 'AbortError'
      })));
    })
  });
  assert.deepEqual(timedOut, { status: 'fallback', reason: 'timeout' });
});

test('bounds timeout configuration', () => {
  assert.equal(timeoutFromEnv('250'), 250);
  assert.equal(timeoutFromEnv('5000'), 5000);
  assert.equal(timeoutFromEnv('50'), 1200);
  assert.equal(timeoutFromEnv('bad'), 1200);
});

test('reads a key from env or a private file only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-router-'));
  const keyPath = path.join(dir, 'api-key');
  try {
    fs.writeFileSync(keyPath, 'file-key\n', { mode: 0o600 });
    assert.equal(readApiKey({}, keyPath), 'file-key');
    assert.equal(readApiKey({ TYPESAFE_API_KEY: 'env-key' }, keyPath), 'env-key');
    const symlinkPath = path.join(dir, 'api-key-link');
    fs.symlinkSync(keyPath, symlinkPath);
    assert.equal(readApiKey({}, symlinkPath), '');
    fs.chmodSync(keyPath, 0o644);
    assert.equal(readApiKey({}, keyPath), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('labels the client in the user agent', async () => {
  assert.equal(userAgentFromArgs([]), 'agentkit-jev-router/0.1.0');
  assert.equal(userAgentFromArgs(['--client', 'unknown']), 'agentkit-jev-router/0.1.0');
  const userAgent = userAgentFromArgs(['--client', 'claude-code']);
  assert.equal(userAgent, 'agentkit-jev-router/0.1.0 (claude-code)');

  let sent;
  await routePrompt('task', {
    apiKey: 'test',
    userAgent,
    fetchImpl: async (_url, init) => {
      sent = init.headers['User-Agent'];
      return new Response('{}', { status: 200 });
    }
  });
  assert.equal(sent, userAgent);
});

test('fails open on network errors', async () => {
  const result = await routePrompt('task', {
    apiKey: 'test',
    fetchImpl: async () => { throw new TypeError('fetch failed'); }
  });
  assert.deepEqual(result, { status: 'fallback', reason: 'network-error' });
});
