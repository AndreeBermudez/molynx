// @ts-check
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const HARNESS_FORMAT = 'agent-harness-proposal-v1';
const REVIEW_FORMAT = 'agent-review-v1';
const HARNESS_DIR = path.join('.agents', 'harness', 'proposals');

/**
 * @typedef {{
 *   id: string,
 *   mode: 'deferred' | 'applied',
 *   source: string,
 *   recordPath: string,
 *   absPath: string,
 *   created: boolean,
 *   status: string,
 *   createdAt: string,
 *   baseHash: string,
 *   mtimeMs: number,
 *   size: number,
 * }} ProposalInfo
 * @typedef {{ dir: string, root?: string }} Source
 */

function reviewDir() {
  return process.env.AGENT_REVIEW_DIR || path.join(os.homedir(), '.agent-review', 'proposals');
}

function heartbeatPath() {
  return path.join(path.dirname(reviewDir()), 'active');
}

/** @param {string[]} folders */
function touchHeartbeat(folders) {
  try {
    fs.mkdirSync(path.dirname(heartbeatPath()), { recursive: true });
    fs.writeFileSync(heartbeatPath(), JSON.stringify({ at: new Date().toISOString(), folders }));
  } catch {}
}

function clearHeartbeat() {
  try {
    fs.unlinkSync(heartbeatPath());
  } catch {}
}

/**
 * @param {string[]} configured
 * @param {string[]} workspaceDirs
 */
function discoverRoots(configured, workspaceDirs) {
  const seen = new Map();
  const add = (/** @type {string} */ dir) => {
    const resolved = path.resolve(dir);
    const key = resolved.toLowerCase();
    if (!seen.has(key)) seen.set(key, resolved);
  };
  if (configured.length > 0) {
    configured.forEach(add);
    return [...seen.values()];
  }
  for (const folder of workspaceDirs) {
    let dir = path.resolve(folder);
    for (let level = 0; level < 4; level++) {
      if (fs.existsSync(path.join(dir, '.agents'))) add(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return [...seen.values()];
}

/**
 * @param {string[]} roots
 * @returns {Source[]}
 */
function sources(roots) {
  return [{ dir: reviewDir() }, ...roots.map((root) => ({ dir: path.join(root, HARNESS_DIR), root }))];
}

/**
 * @param {string} dir
 * @returns {{ recordPath: string, mtimeMs: number, size: number }[]}
 */
function listRecords(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const result = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    const recordPath = path.join(dir, name);
    try {
      const stat = fs.statSync(recordPath);
      if (stat.isFile()) result.push({ recordPath, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {}
  }
  return result;
}

/** @param {string} recordPath */
function readRecord(recordPath) {
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  if (record.format !== HARNESS_FORMAT && record.format !== REVIEW_FORMAT) {
    throw new Error(`Formato no soportado: ${record.format}`);
  }
  return record;
}

/**
 * @param {Source} source
 * @param {string} recordPath
 * @param {number} mtimeMs
 * @param {number} size
 * @returns {ProposalInfo}
 */
function loadInfo(source, recordPath, mtimeMs, size) {
  const record = readRecord(recordPath);
  const harness = record.format === HARNESS_FORMAT;
  if (harness && !source.root) throw new Error('Propuesta del harness fuera de una raíz');
  return {
    id: record.proposalId,
    mode: harness ? 'deferred' : 'applied',
    source: harness ? 'harness' : record.source ?? 'agent',
    recordPath,
    absPath: harness ? path.join(/** @type {string} */ (source.root), ...String(record.path).split('/')) : record.absPath,
    created: !harness && record.created === true,
    status: record.status,
    createdAt: record.createdAt,
    baseHash: harness ? String(record.baseHash).toLowerCase() : '',
    mtimeMs,
    size,
  };
}

/**
 * @param {string} recordPath
 * @param {Record<string, unknown>} changes
 */
function updateRecord(recordPath, changes) {
  const record = readRecord(recordPath);
  Object.assign(record, changes);
  const temp = path.join(path.dirname(recordPath), `.review-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(record));
  fs.renameSync(temp, recordPath);
}

/** @param {string} recordPath */
function removeRecord(recordPath) {
  try {
    fs.unlinkSync(recordPath);
  } catch {}
}

/** @param {string} absPath */
function fileHash(absPath) {
  return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

/** @param {string} absPath */
function readText(absPath) {
  try {
    return stripBom(fs.readFileSync(absPath, 'utf8'));
  } catch {
    return undefined;
  }
}

/** @param {string} text */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** @param {string} text */
function splitLines(text) {
  return text.split(/\r\n|\n/);
}

module.exports = {
  touchHeartbeat,
  clearHeartbeat,
  discoverRoots,
  sources,
  listRecords,
  readRecord,
  loadInfo,
  updateRecord,
  removeRecord,
  fileHash,
  readText,
  stripBom,
  splitLines,
};
