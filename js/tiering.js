// The silent upgrade from Gemma 4 E2B to E4B. Silent means no prompt and no banner; it does not
// mean hidden (the footer line always names the active model).
//
// This module only decides. It does no I/O, so every rule can be unit-tested.

import { TIERING } from './config.js';

/**
 * @param {object} input
 * @param {{maxBufferSize: number, maxStorageBufferBindingSize: number}|null} input.limits  WebGPU adapter limits
 * @param {number|null} input.decodeTps       measured on the loaded E2B (about 128 tokens)
 * @param {{quota: number, usage: number}|null} input.storage   navigator.storage.estimate()
 * @param {number|null} input.e4bBytes        size of the E4B download, from file metadata
 * @param {{saveData?: boolean, effectiveType?: string}|null} input.connection
 * @param {boolean} input.settingOn           the user's "use the larger model" toggle
 * @param {boolean} input.previouslyFailed    E4B failed on this device before
 * @param {typeof TIERING} [cfg]
 * @returns {{upgrade: boolean, reasons: string[]}} reasons explain every failed condition
 */
export function decideUpgrade(input, cfg = TIERING) {
  const reasons = [];
  if (!input.settingOn) reasons.push('the larger-model setting is off');
  if (input.previouslyFailed) reasons.push('the larger model failed on this device before');

  // 1. WebGPU adapter limits
  const l = input.limits;
  if (!l) {
    reasons.push('no WebGPU adapter limits available');
  } else {
    if (l.maxBufferSize < cfg.minMaxBufferSize) reasons.push(`maxBufferSize ${l.maxBufferSize} is below ${cfg.minMaxBufferSize}`);
    if (l.maxStorageBufferBindingSize < cfg.minMaxStorageBufferBindingSize) {
      reasons.push(`maxStorageBufferBindingSize ${l.maxStorageBufferBindingSize} is below ${cfg.minMaxStorageBufferBindingSize}`);
    }
  }

  // 2. Measured decode speed
  if (input.decodeTps === null || input.decodeTps === undefined) reasons.push('decode speed not measured');
  else if (input.decodeTps < cfg.minDecodeTokensPerSecond) reasons.push(`decode speed ${input.decodeTps.toFixed(1)} tok/s is below ${cfg.minDecodeTokensPerSecond}`);

  // 3. Free storage
  if (!input.storage || input.e4bBytes === null || input.e4bBytes === undefined) {
    reasons.push('storage estimate or download size unavailable');
  } else {
    const free = input.storage.quota - input.storage.usage;
    if (free < cfg.storageHeadroomFactor * input.e4bBytes) reasons.push(`free storage ${free} is below ${cfg.storageHeadroomFactor}x the download`);
  }

  // 4. Connection (where the browser reports it)
  const c = input.connection;
  if (c?.saveData === true) reasons.push('data saver is on');
  if (c?.effectiveType && cfg.slowConnectionTypes.includes(c.effectiveType)) reasons.push(`connection is ${c.effectiveType}`);

  return { upgrade: reasons.length === 0, reasons };
}

// ---- small persistence helpers (localStorage may be unavailable; never throw) ----

export function readSetting(storage = globalThis.localStorage) {
  try {
    return storage.getItem(TIERING.settingKey) !== 'off';
  } catch {
    return true;
  }
}

export function writeSetting(on, storage = globalThis.localStorage) {
  try {
    storage.setItem(TIERING.settingKey, on ? 'on' : 'off');
  } catch {
    /* ignore */
  }
}

export function readFailure(storage = globalThis.localStorage) {
  try {
    const v = storage.getItem(TIERING.failureKey);
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}

export function writeFailure(reason, storage = globalThis.localStorage) {
  try {
    storage.setItem(TIERING.failureKey, JSON.stringify({ reason: String(reason).slice(0, 300), at: new Date().toISOString() }));
  } catch {
    /* ignore */
  }
}

export function clearFailure(storage = globalThis.localStorage) {
  try {
    storage.removeItem(TIERING.failureKey);
  } catch {
    /* ignore */
  }
}
