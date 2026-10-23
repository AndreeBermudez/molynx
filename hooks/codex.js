#!/usr/bin/env node
'use strict';

// Codex PreToolUse hook for apply_patch. It records each file's pre-edit
// contents in the same proposal format used by the Claude Code connector.
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
    const event = JSON.parse(input.replace(/^\uFEFF/, ''));
    if (event.hook_event_name === 'PreToolUse' && event.tool_name === 'apply_patch') {
      for (const file of patchFiles(event.tool_input?.command)) recordBeforeEdit(file, event);
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
    return file === root || file.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  });
}

function patchFiles(patch) {
  if (typeof patch !== 'string') return [];
  const result = new Set();
  for (const line of patch.split(/\r?\n/)) {
    const match = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/.exec(line);
    if (match) result.add(match[1].trim());
  }
  return [...result];
}

function recordBeforeEdit(relativePath, event) {
  const folders = workspaceFolders();
  if (folders.length === 0 || !relativePath || relativePath.includes('\0')) return;
  const target = path.resolve(event.cwd || process.cwd(), relativePath);
  if (!inside(target, folders)) return;

  fs.mkdirSync(DIR, { recursive: true });
  if (hasPending(target)) return;
  const exists = fs.existsSync(target);
  if (exists && (!fs.statSync(target).isFile() || fs.statSync(target).size > MAX_FILE)) return;
  const original = exists ? fs.readFileSync(target, 'utf8') : '';
  if (original.includes('\0')) return;

  const id = crypto.randomUUID();
  const record = {
    format: 'agent-review-v1',
    proposalId: id,
    source: 'codex',
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
