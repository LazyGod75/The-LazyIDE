import { useState } from 'react';
import { useI18n } from '../../i18n';

interface SnippetsManagerProps {
  onClose: () => void;
}

interface Snippet {
  id: string;
  name: string;
  prefix: string;
  body: string;
  language: string;
  description: string;
}

const DEFAULT_SNIPPETS: Snippet[] = [
  { id: 'cl', name: 'Console Log', prefix: 'cl', body: 'console.log($1);', language: 'typescript', description: 'Quick console.log' },
  { id: 'fn', name: 'Function', prefix: 'fn', body: 'function $1($2) {\n  $3\n}', language: 'typescript', description: 'Named function' },
  { id: 'afn', name: 'Arrow Function', prefix: 'afn', body: 'const $1 = ($2) => {\n  $3\n};', language: 'typescript', description: 'Arrow function' },
  { id: 'if', name: 'If Statement', prefix: 'if', body: 'if ($1) {\n  $2\n}', language: 'typescript', description: 'If statement' },
  { id: 'for', name: 'For Loop', prefix: 'for', body: 'for (let i = 0; i < $1; i++) {\n  $2\n}', language: 'typescript', description: 'For loop' },
  { id: 'try', name: 'Try Catch', prefix: 'try', body: 'try {\n  $1\n} catch (err) {\n  $2\n}', language: 'typescript', description: 'Try-catch block' },
  { id: 'rfc', name: 'React Component', prefix: 'rfc', body: 'export function $1() {\n  return (\n    <div>\n      $2\n    </div>\n  );\n}', language: 'tsx', description: 'React function component' },
  { id: 'ue', name: 'useEffect', prefix: 'ue', body: 'useEffect(() => {\n  $1\n}, [$2]);', language: 'tsx', description: 'useEffect hook' },
  { id: 'us', name: 'useState', prefix: 'us', body: 'const [$1, set$1] = useState($2);', language: 'tsx', description: 'useState hook' },
];

// B22: default snippet library content (name/description of each built-in
// snippet) stays in English on purpose — factory-default seed content, not
// interface chrome (same convention as VS Code's own default snippets,
// which ship untranslated regardless of the editor's display language).
// Only the panel's OWN chrome (search placeholder, buttons, empty-name
// fallback) is localized below via code.snippetsPanel.* — all 6 locales.
export function SnippetsManager({ onClose }: SnippetsManagerProps) {
  const { t } = useI18n();
  const [snippets, setSnippets] = useState<Snippet[]>(DEFAULT_SNIPPETS);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Snippet | null>(null);

  function saveSnippet(snippet: Snippet) {
    setSnippets(prev => {
      const exists = prev.find(s => s.id === snippet.id);
      if (exists) return prev.map(s => s.id === snippet.id ? snippet : s);
      return [...prev, snippet];
    });
    setEditing(null);
  }

  function deleteSnippet(id: string) {
    setSnippets(prev => prev.filter(s => s.id !== id));
  }

  const filtered = snippets.filter(s =>
    !search || s.name.toLowerCase().includes(search.toLowerCase()) || s.prefix.includes(search.toLowerCase())
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#0E0E12' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={t('code.snippetsPanel.searchPlaceholder')}
          style={{ flex: 1, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, padding: '5px 10px', color: '#D5D8E0', fontSize: 11, fontFamily: 'inherit', outline: 'none' }}
        />
        <button onClick={() => setEditing({ id: `snip-${Date.now()}`, name: '', prefix: '', body: '', language: 'typescript', description: '' })} style={{ background: 'rgba(124,92,255,0.15)', border: '1px solid rgba(124,92,255,0.2)', borderRadius: 4, padding: '4px 10px', color: '#A78BFF', cursor: 'pointer', fontSize: 11, fontFamily: 'inherit' }}>
          {t('code.snippetsPanel.new')}
        </button>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.3)', cursor: 'pointer', fontSize: 14 }}>×</button>
      </div>

      {editing && (
        <div style={{ padding: 12, borderBottom: '1px solid rgba(255,255,255,0.07)', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} placeholder={t('code.snippetsPanel.namePlaceholder')} style={{ flex: 1, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, padding: '4px 8px', color: '#D5D8E0', fontSize: 11, fontFamily: 'inherit', outline: 'none' }} />
            <input value={editing.prefix} onChange={e => setEditing({ ...editing, prefix: e.target.value })} placeholder={t('code.snippetsPanel.prefixPlaceholder')} style={{ width: 80, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, padding: '4px 8px', color: '#D5D8E0', fontSize: 11, fontFamily: 'inherit', outline: 'none' }} />
            <select value={editing.language} onChange={e => setEditing({ ...editing, language: e.target.value })} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, padding: '4px 8px', color: '#D5D8E0', fontSize: 11, fontFamily: 'inherit', outline: 'none' }}>
              <option value="typescript">TypeScript</option>
              <option value="tsx">TSX</option>
              <option value="javascript">JavaScript</option>
              <option value="python">Python</option>
              <option value="rust">Rust</option>
            </select>
          </div>
          <textarea value={editing.body} onChange={e => setEditing({ ...editing, body: e.target.value })} placeholder={t('code.snippetsPanel.bodyPlaceholder')} rows={4} style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, padding: '6px 8px', color: '#D5D8E0', fontSize: 11, fontFamily: "'JetBrains Mono', monospace", outline: 'none', resize: 'vertical', boxSizing: 'border-box' }} />
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => saveSnippet(editing)} style={{ background: 'rgba(124,92,255,0.15)', border: '1px solid rgba(124,92,255,0.2)', borderRadius: 4, padding: '4px 12px', color: '#A78BFF', cursor: 'pointer', fontSize: 11, fontFamily: 'inherit' }}>{t('code.snippetsPanel.save')}</button>
            <button onClick={() => setEditing(null)} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, padding: '4px 12px', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: 11, fontFamily: 'inherit' }}>{t('code.snippetsPanel.cancel')}</button>
          </div>
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {filtered.map(snippet => (
          <div key={snippet.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, color: '#D5D8E0' }}>
                {snippet.name || t('code.snippetsPanel.unnamed')}
                <span style={{ fontSize: 10, color: '#A78BFF', marginLeft: 8, fontFamily: "'JetBrains Mono', monospace" }}>{snippet.prefix}</span>
              </div>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', marginTop: 1 }}>{snippet.description}</div>
            </div>
            <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.2)' }}>{snippet.language}</span>
            <button onClick={() => setEditing(snippet)} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.3)', cursor: 'pointer', fontSize: 11 }}>{t('code.snippetsPanel.edit')}</button>
            <button onClick={() => deleteSnippet(snippet.id)} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.2)', cursor: 'pointer', fontSize: 14 }}>×</button>
          </div>
        ))}
      </div>
    </div>
  );
}
