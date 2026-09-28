'use strict';
const $ = (id) => document.getElementById(id);
const mask = (k) => '•'.repeat(8) + k.slice(-4);

async function showSaved() {
  const { geminiKey } = await chrome.storage.local.get('geminiKey');
  $('saved').textContent = geminiKey ? `Saved key: ${mask(geminiKey)}` : 'No key saved.';
}
function result(text, ok) {
  $('result').textContent = text;
  $('result').className = ok ? 'ok' : 'err';
}

$('save').addEventListener('click', async () => {
  const key = $('key').value.trim();
  if (!key) return result('Paste a key first.', false);
  await chrome.storage.local.set({ geminiKey: key });
  await chrome.storage.local.remove('geminiStatus');
  await chrome.storage.sync.set({ translator: 'gemini' });
  $('key').value = '';
  await showSaved();
  result('Saved. Gemini is now the translator.', true);
});

$('test').addEventListener('click', async () => {
  result('Testing…', true);
  const res = await chrome.runtime.sendMessage({ type: 'testKey', key: $('key').value.trim() });
  result(res && res.ok ? res.message : `Error: ${(res && res.error) || 'no answer'}`, !!(res && res.ok));
});

$('remove').addEventListener('click', async () => {
  await chrome.storage.local.remove(['geminiKey', 'geminiStatus']);
  const { translator } = await chrome.storage.sync.get('translator');
  if (translator === 'gemini') await chrome.storage.sync.remove('translator');
  await showSaved();
  result('Key removed. Using Google Translate.', true);
});

showSaved();
