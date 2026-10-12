import test from 'node:test';
import assert from 'node:assert/strict';
import { decideUpgrade, readSetting, writeSetting, readFailure, writeFailure, clearFailure } from '../../js/tiering.js';
import { TIERING } from '../../js/config.js';

const GOOD = {
  limits: { maxBufferSize: 4 * 1024 ** 3, maxStorageBufferBindingSize: 2 * 1024 ** 3 },
  decodeTps: 30,
  storage: { quota: 100e9, usage: 1e9 },
  e4bBytes: 5e9,
  connection: { saveData: false, effectiveType: '4g' },
  settingOn: true,
  previouslyFailed: false,
};

test('upgrades only when every condition holds', () => {
  assert.deepEqual(decideUpgrade(GOOD), { upgrade: true, reasons: [] });
});

for (const [name, patch, needle] of [
  ['setting off', { settingOn: false }, /setting is off/],
  ['previous failure', { previouslyFailed: true }, /failed on this device/],
  ['no adapter', { limits: null }, /no WebGPU/],
  ['small maxBufferSize', { limits: { ...GOOD.limits, maxBufferSize: 1024 } }, /maxBufferSize/],
  ['small binding size', { limits: { ...GOOD.limits, maxStorageBufferBindingSize: 1024 } }, /maxStorageBufferBindingSize/],
  ['slow decode', { decodeTps: 2 }, /decode speed/],
  ['decode not measured', { decodeTps: null }, /not measured/],
  ['low storage', { storage: { quota: 8e9, usage: 0 } }, /free storage/],
  ['storage unknown', { storage: null }, /unavailable/],
  ['save data', { connection: { saveData: true } }, /data saver/],
  ['slow cell', { connection: { effectiveType: '3g' } }, /connection is 3g/],
]) {
  test(`does not upgrade: ${name}`, () => {
    const r = decideUpgrade({ ...GOOD, ...patch });
    assert.equal(r.upgrade, false);
    assert.match(r.reasons.join(' | '), needle);
  });
}

test('missing connection API does not block the upgrade', () => {
  assert.equal(decideUpgrade({ ...GOOD, connection: null }).upgrade, true);
});

test('storage needs 2x the download', () => {
  assert.equal(decideUpgrade({ ...GOOD, storage: { quota: 10e9, usage: 0 } }).upgrade, true);
  assert.equal(decideUpgrade({ ...GOOD, storage: { quota: 9.9e9, usage: 0 } }).upgrade, false);
});

function fakeStorage() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

test('setting defaults on and persists; failure is remembered until cleared', () => {
  const s = fakeStorage();
  assert.equal(readSetting(s), true);
  writeSetting(false, s);
  assert.equal(readSetting(s), false);
  assert.equal(readFailure(s), null);
  writeFailure('out of memory', s);
  assert.equal(readFailure(s).reason, 'out of memory');
  assert.ok(s.getItem(TIERING.failureKey));
  clearFailure(s);
  assert.equal(readFailure(s), null);
});

test('storage that throws never breaks the app', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.equal(readSetting(broken), true);
  assert.equal(readFailure(broken), null);
  writeSetting(true, broken); writeFailure('x', broken); clearFailure(broken);
});

import { pinnedUrl, EMBED, GENERATORS, isAllowedModelHost } from '../../js/config.js';

test('model downloads are pinned to a commit on the wire, while the library keeps seeing main', () => {
  assert.equal(pinnedUrl(`https://huggingface.co/${EMBED.id}/resolve/main/onnx/model_q4.onnx`), `https://huggingface.co/${EMBED.id}/resolve/${EMBED.pin}/onnx/model_q4.onnx`);
  assert.equal(pinnedUrl(`https://huggingface.co/${GENERATORS.e4b.id}/resolve/main/config.json`), `https://huggingface.co/${GENERATORS.e4b.id}/resolve/${GENERATORS.e4b.pin}/config.json`);
  assert.equal(pinnedUrl('https://huggingface.co/someone/else/resolve/main/x.json'), 'https://huggingface.co/someone/else/resolve/main/x.json');
  assert.equal(pinnedUrl(`https://huggingface.co/${EMBED.id}/resolve/abc123/x.json`), `https://huggingface.co/${EMBED.id}/resolve/abc123/x.json`);
  for (const g of [EMBED, ...Object.values(GENERATORS)]) assert.match(g.pin, /^[0-9a-f]{40}$/);
});

test('only Hugging Face hosts are model hosts, including the CDN the probe found', () => {
  assert.ok(isAllowedModelHost('huggingface.co'));
  assert.ok(isAllowedModelHost('us.aws.cdn.hf.co'));
  assert.ok(isAllowedModelHost('cas-bridge.xethub.hf.co'));
  assert.ok(!isAllowedModelHost('huggingface.co.evil.example'));
  assert.ok(!isAllowedModelHost('evilhf.co'));
});
