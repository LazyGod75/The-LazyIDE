// Entry-point bootstrap — extracted from index.html to comply with
// `script-src 'self'` CSP (no 'unsafe-inline' allowed).
// Relative imports are resolved from this file's location (lib/).
import { initApp } from '../components/app-shell.js';

initApp().catch(err => {
  const content = document.getElementById('content');
  if (content) {
    const msgEl = document.createElement('p');
    msgEl.textContent = err.message;
    const wrap = document.createElement('div');
    wrap.className = 'empty-state';
    wrap.innerHTML = '<h2>Failed to load</h2>';
    wrap.appendChild(msgEl);
    content.replaceChildren(wrap);
  }
});
