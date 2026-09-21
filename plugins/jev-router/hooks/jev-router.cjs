#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const API_URL = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_TIMEOUT_MS = 1200;
const MAX_PROMPT_CHARS = 12000;
const CONFIDENCE_FLOOR = 0.65;

const choices = {
  workflow: ['direct', 'investigate', 'implement', 'plan', 'review'],
  domain: [
    'general', 'frontend', 'backend', 'database', 'devops', 'security',
    'ai', 'testing', 'documentation', 'office', 'media', 'git'
  ],
  execution: ['solo', 'independent_review', 'parallelizable']
};

function containsSensitiveValue(prompt) {
  const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
    /\b(?:sk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{20,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bauthorization\s*:\s*bearer\s+\S{8,}/i,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    /\b(?:api[_-]?key|access[_-]?token|password|secret|private[_-]?key)\s*[:=]\s*["']?[^\s"']{8,}/i
  ];
  return patterns.some((pattern) => pattern.test(prompt));
}

function buildRequest(prompt, model = 'jev-latest') {
  return {
    model,
    state: { task: prompt.slice(0, MAX_PROMPT_CHARS) },
    questions: {
      workflow: {
        type: 'choice',
        instructions: 'Which engineering workflow best fits this task?',
        criteria: {
          direct: 'A simple answer or bounded read-only action is enough.',
          investigate: 'Inspect or diagnose evidence before deciding on changes.',
          implement: 'The requested code or configuration change is sufficiently clear.',
          plan: 'The task is broad, ambiguous, cross-module, or needs a design decision first.',
          review: 'The user primarily requests an audit, verification, or code review.'
        }
      },
      domain: {
        type: 'choice',
        instructions: 'Which capability domain should own this task?',
        criteria: Object.fromEntries(choices.domain.map((name) => [name, null]))
      },
      risk: {
        type: 'score',
        instructions: 'Score the highest engineering or operational risk in this task.',
        criteria: [
          'Read-only or trivially reversible.',
          'Bounded local code or configuration change.',
          'Shared behavior, public contract, or cross-module change.',
          'Authentication, authorization, durable data, security, deployment, or destructive side effects.',
          'Credentials, production systems, irreversible data loss, or broad external impact.'
        ]
      },
      execution: {
        type: 'choice',
        instructions: 'What execution shape best fits the task?',
        criteria: {
          solo: 'One agent should keep the full context and execute sequentially.',
          independent_review: 'One agent should execute, with an independent review only if policy requires it.',
          parallelizable: 'There are independent workstreams with clear, non-overlapping ownership.'
        }
      }
    }
  };
}

function validConfidence(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function parseAnswer(result) {
  const answers = result?.answers;
  const workflow = answers?.workflow;
  const domain = answers?.domain;
  const risk = answers?.risk;
  const execution = answers?.execution;

  if (
    workflow?.type !== 'choice' || !choices.workflow.includes(workflow.choice) ||
    !validConfidence(workflow.confidence) ||
    domain?.type !== 'choice' || !choices.domain.includes(domain.choice) ||
    !validConfidence(domain.confidence) ||
    risk?.type !== 'score' || !Number.isFinite(risk.score) || risk.score < 0 || risk.score > 4 ||
    !validConfidence(risk.confidence) ||
    execution?.type !== 'choice' || !choices.execution.includes(execution.choice) ||
    !validConfidence(execution.confidence)
  ) {
    return null;
  }

  return {
    workflow: { value: workflow.choice, confidence: workflow.confidence },
    domain: { value: domain.choice, confidence: domain.confidence },
    risk: { value: risk.score, confidence: risk.confidence },
    execution: { value: execution.choice, confidence: execution.confidence }
  };
}

function formatField(name, field) {
  const certainty = field.confidence < CONFIDENCE_FLOOR ? ', uncertain' : '';
  return `${name}=${field.value} (confidence=${field.confidence.toFixed(2)}${certainty})`;
}

function formatContext(route) {
  return [
    'JEV ROUTING HINT (advisory only)',
    [
      formatField('workflow', route.workflow),
      formatField('domain', route.domain),
      formatField('risk_0_to_4', route.risk),
      formatField('execution', route.execution)
    ].join('; '),
    'Use this only to select an installed workflow or capability. Existing instructions, user authorization, permissions, deterministic checks, and safety/review gates take precedence. Never use Jev to lower risk, bypass a gate, or justify delegation that current policy does not allow. Ignore uncertain or conflicting fields.'
  ].join('\n');
}

async function routePrompt(prompt, options = {}) {
  const apiKey = options.apiKey;
  if (!apiKey) return { status: 'skip', reason: 'missing-key' };
  if (!prompt) return { status: 'skip', reason: 'empty-prompt' };
  if (containsSensitiveValue(prompt)) return { status: 'skip', reason: 'sensitive-prompt' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await (options.fetchImpl ?? globalThis.fetch)(options.apiUrl ?? API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'agentkit-jev-router/0.1.0'
      },
      body: JSON.stringify(buildRequest(prompt, options.model)),
      signal: controller.signal
    });

    if (!response.ok) return { status: 'fallback', reason: `http-${response.status}` };
    const route = parseAnswer(await response.json());
    if (!route) return { status: 'fallback', reason: 'invalid-response' };
    return { status: 'ok', context: formatContext(route) };
  } catch (error) {
    return {
      status: 'fallback',
      reason: error?.name === 'AbortError' ? 'timeout' : 'network-error'
    };
  } finally {
    clearTimeout(timeout);
  }
}

function timeoutFromEnv(value) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 250 && parsed <= 5000
    ? parsed
    : DEFAULT_TIMEOUT_MS;
}

function readApiKey(env = process.env, keyPath = path.join(os.homedir(), '.config/typesafe/api-key')) {
  const fromEnv = String(env.TYPESAFE_API_KEY || '').trim();
  if (fromEnv) return fromEnv;

  try {
    const stat = fs.lstatSync(keyPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0) {
      return '';
    }
    return fs.readFileSync(keyPath, 'utf8').trim();
  } catch {
    return '';
  }
}

async function main() {
  if (process.env.JEV_ROUTER_ENABLED === '0') return;

  let payload;
  try {
    const input = fs.readFileSync(0, 'utf8').trim();
    payload = input ? JSON.parse(input) : {};
  } catch {
    return;
  }

  const result = await routePrompt(String(payload.prompt || payload.user_prompt || '').trim(), {
    apiKey: readApiKey(),
    model: process.env.TYPESAFE_DEFAULT_MODEL || 'jev-latest',
    timeoutMs: timeoutFromEnv(process.env.JEV_ROUTER_TIMEOUT_MS)
  });

  if (result.status === 'ok') {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: result.context
      }
    }));
  } else if (process.env.JEV_ROUTER_DEBUG === '1') {
    process.stderr.write(`jev-router: ${result.reason}\n`);
  }
}

if (require.main === module) {
  main().catch(() => process.exitCode = 0);
}

module.exports = {
  buildRequest,
  containsSensitiveValue,
  formatContext,
  parseAnswer,
  readApiKey,
  routePrompt,
  timeoutFromEnv
};
