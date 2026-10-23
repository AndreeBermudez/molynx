#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.AGENT_REVIEW_DIR || path.join(os.homedir(), '.agent-review', 'proposals');
const HEARTBEAT = path.join(path.dirname(DIR), 'active');
const HEARTBEAT_MS = 30 * 1000;
const MAX_FILE = 2 * 1024 * 1024;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  try {
    if (snapshot(JSON.parse(input.replace(/^﻿/, '')))) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason: 'Agent Review revisará este cambio en el editor',
          },
        }),
      );
    }
  } catch {}
  process.exit(0);
});

function workspaceFolders() {
  try {
    if (Date.now() - fs.statSync(HEARTBEAT).mtimeMs >= HEARTBEAT_MS) return [];
    const folders = JSON.parse(fs.readFileSync(HEARTBEAT, 'utf8')).folders;
    return Array.isArray(folders) ? folders.filter((f) => typeof f === 'string') : [];
  } catch {
    return [];
  }
}

function inside(target, folders) {
  const file = path.resolve(target).toLowerCase();
  return folders.some((folder) => {
    const root = path.resolve(folder).toLowerCase();
    return file.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  });
}

function snapshot(event) {
  const folders = workspaceFolders();
  if (folders.length === 0) return false;
  const target = resolveTarget(event);
  if (!target || !inside(target, folders)) return false;
  fs.mkdirSync(DIR, { recursive: true });
  if (hasPending(target)) return true;
  const exists = fs.existsSync(target);
  if (exists && (!fs.statSync(target).isFile() || fs.statSync(target).size > MAX_FILE)) return false;
  const original = exists ? fs.readFileSync(target, 'utf8') : '';
  if (original.includes('\0')) return false;
  const id = crypto.randomUUID();
  const record = {
    format: 'agent-review-v1',
    proposalId: id,
    source: String(event.tool_name || '').startsWith('mcp__') ? 'harness' : 'claude-code',
    tool: event.tool_name,
    sessionId: event.session_id,
    status: 'pending',
    absPath: target,
    created: !exists,
    original,
    createdAt: new Date().toISOString(),
  };
  const temp = path.join(DIR, `.${id}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(record));
  fs.renameSync(temp, path.join(DIR, `${id}.json`));
  return true;
}

function resolveTarget(event) {
  const toolInput = event.tool_input || {};
  const cwd = event.cwd || process.cwd();
  if (typeof toolInput.file_path === 'string') return path.resolve(cwd, toolInput.file_path);
  if (typeof toolInput.path !== 'string' || toolInput.preview === true) return undefined;
  let dir = process.env.CLAUDE_PROJECT_DIR || cwd;
  for (let level = 0; level < 4; level++) {
    const candidate = path.resolve(dir, toolInput.path);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function hasPending(target) {
  const key = path.resolve(target).toLowerCase();
  for (const name of fs.readdirSync(DIR)) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));
      if (record.status === 'pending' && path.resolve(record.absPath).toLowerCase() === key) return true;
    } catch {}
  }
  return false;
}
