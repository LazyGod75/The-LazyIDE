// examples/brain-ui/lib/router.js

export function parseRoute() {
  const hash = location.hash.slice(1) || '/';
  const parts = hash.split('/').filter(Boolean);
  if (parts.length === 0) return { view: 'home', params: {} };
  // Explicit note route: #/note/<id>
  if (parts[0] === 'note' && parts[1]) return { view: 'note', params: { id: decodeURIComponent(parts[1]) } };
  // Wiki route: #/wiki/<id> — works for any neuron type (file-neuron, aggregate-neuron, concept)
  if (parts[0] === 'wiki' && parts[1]) {
    const rawId = parts.slice(1).join('/');
    return { view: 'wiki', params: { id: decodeURIComponent(rawId) } };
  }
  if (parts[0] === 'stats') return { view: 'stats', params: {} };
  if (parts[0] === 'timeline') return { view: 'timeline', params: {} };
  if (parts[0] === 'search') return { view: 'search', params: { query: parts.slice(1).join('/') } };
  if (parts[0] === 'browse') return { view: 'browse', params: {} };
  return { view: 'topic', params: { path: parts } };
}

export function navigate(path) {
  location.hash = path;
}

export function onRouteChange(callback) {
  window.addEventListener('hashchange', () => callback(parseRoute()));
  callback(parseRoute());
}

export function buildNoteLink(id) {
  return `#/note/${encodeURIComponent(id)}`;
}

export function buildWikiLink(id) {
  return `#/wiki/${encodeURIComponent(id)}`;
}

export function buildTopicLink(path) {
  return `#/${Array.isArray(path) ? path.join('/') : path}`;
}

/**
 * Detect the code-first neuron types that should use #/wiki/<id> routing.
 * @param {string} type
 * @returns {boolean}
 */
export function isCodeNeuronType(type) {
  return type === 'file-neuron' || type === 'aggregate-neuron' || type === 'concept';
}
