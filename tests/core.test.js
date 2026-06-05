import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, costFromUsage, createUserRecord, verifyPassword, extractDataUrl } from '../server.js';

test('password records verify only the correct password', () => {
  const user = createUserRecord('client', 'secret123');
  assert.equal(verifyPassword('secret123', user), true);
  assert.equal(verifyPassword('wrong', user), false);
});

test('cost is calculated from OpenRouter token usage and UAH rate', () => {
  const cost = costFromUsage({ prompt_tokens: 1_000_000, completion_tokens: 500_000 });
  assert.equal(cost.usd, 8);
  assert.equal(cost.uah, 320);
});

test('prompt includes user intent and image settings', () => {
  const prompt = buildPrompt({ prompt: 'Зроби банер', aspectRatio: '16:9', imageSize: '4K', style: 'Комерційний' });
  assert.match(prompt, /Зроби банер/);
  assert.match(prompt, /16:9/);
  assert.match(prompt, /4K/);
  assert.match(prompt, /Комерційний/);
});

test('extractDataUrl finds embedded base64 image urls', () => {
  assert.equal(extractDataUrl('ok data:image/png;base64,QUJDRA=='), 'data:image/png;base64,QUJDRA==');
  assert.equal(extractDataUrl('no image'), null);
});
