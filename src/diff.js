// @ts-check
'use strict';

/**
 * @typedef {{ oldStart: number, oldLines: number, newStart: number, newLines: number }} Hunk
 */

/**
 * @param {string[]} a
 * @param {string[]} b
 * @returns {Hunk[]}
 */
function diffLines(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ops = myers(a.slice(start, endA), b.slice(start, endB));
  /** @type {Hunk[]} */
  const hunks = [];
  let i = start;
  let j = start;
  let k = 0;
  while (k < ops.length) {
    if (ops[k] === 0) {
      i++;
      j++;
      k++;
      continue;
    }
    const hunk = { oldStart: i, oldLines: 0, newStart: j, newLines: 0 };
    while (k < ops.length && ops[k] !== 0) {
      if (ops[k] === 1) {
        hunk.oldLines++;
        i++;
      } else {
        hunk.newLines++;
        j++;
      }
      k++;
    }
    hunks.push(hunk);
  }
  return hunks;
}

/**
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number[]} 0 = igual, 1 = borrada de a, 2 = insertada de b
 */
function myers(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0) return new Array(m).fill(2);
  if (m === 0) return new Array(n).fill(1);
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  /** @type {Int32Array[]} */
  const trace = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice(off - d, off + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  /** @type {number[]} */
  const ops = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const w = trace[d];
    const at = (/** @type {number} */ k) => w[k + d];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const down = prevK === k + 1;
    const prevX = at(prevK);
    const startX = down ? prevX : prevX + 1;
    const startY = startX - k;
    while (x > startX && y > startY) {
      ops.push(0);
      x--;
      y--;
    }
    if (down) {
      ops.push(2);
      y--;
    } else {
      ops.push(1);
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push(0);
    x--;
    y--;
  }
  return ops.reverse();
}

module.exports = { diffLines };
