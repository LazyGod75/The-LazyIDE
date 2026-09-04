import { useState, useCallback, useMemo } from 'react';
import { useAppContext } from '../../app/AppContext';
import type { Platform } from '../../lib/platform/types';
import { useI18n } from '../../i18n';

interface GlobalSearchPanelProps {
  onFileOpen: (path: string, filename: string, content: string) => void;
}

interface SearchResult {
  path: string;
  filename: string;
  line: number;
  lineContent: string;
  matchStart: number;
  matchEnd: number;
}

async function searchInFiles(
  platform: Platform,
  rootPath: string,
  query: string,
  isRegex: boolean,
  includePattern: string,
  excludePattern: string,
): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  const includeRe = includePattern ? new RegExp(globToRegex(includePattern)) : null;
  const excludeRe = excludePattern ? new RegExp(globToRegex(excludePattern)) : null;
  const searchRe = isRegex ? new RegExp(query, 'i') : new RegExp(escapeRegex(query), 'i');

  async function walkDir(dirPath: string) {
    let entries;
    try {
      entries = await platform.fs.readDir(dirPath);
    } catch { return; }

    for (const entry of entries) {
      const fullPath = `${dirPath}/${entry.name}`;
      if (entry.isDir) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (excludeRe && excludeRe.test(entry.name)) continue;
        await walkDir(fullPath);
      } else {
        if (includeRe && !includeRe.test(entry.name)) continue;
        if (excludeRe && excludeRe.test(entry.name)) continue;
        const ext = entry.name.split('.').pop()?.toLowerCase() ?? '';
        if (!TEXT_EXTENSIONS.has(ext)) continue;
        try {
          const content = await platform.fs.readFile(fullPath);
          if (content.length > 256_000) continue;
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const match = searchRe.exec(lines[i]);
            if (match) {
              results.push({
                path: fullPath,
                filename: entry.name,
                line: i + 1,
                lineContent: lines[i].slice(0, 200),
                matchStart: match.index,
                matchEnd: match.index + match[0].length,
              });
              if (results.length >= 500) return;
            }
          }
        } catch { /* skip unreadable */ }
      }
    }
  }

  await walkDir(rootPath);
  return results;
}

function globToRegex(glob: string): string {
  return glob.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', 'target', '.cache']);
const TEXT_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'json', 'md', 'css', 'html', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'hpp', 'rb', 'php', 'vue', 'svelte', 'yml', 'yaml', 'toml', 'xml', 'sh', 'bash', 'sql', 'txt', 'env']);

interface ReplaceResult {
  path: string;
  replacements: number;
}

export function GlobalSearchPanel({ onFileOpen }: GlobalSearchPanelProps) {
  const { t } = useI18n();
  const { platform, projectRoot } = useAppContext();
  const [query, setQuery] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [isRegex, setIsRegex] = useState(false);
  const [includePattern, setIncludePattern] = useState('');
  const [excludePattern, setExcludePattern] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [replaceResults, setReplaceResults] = useState<ReplaceResult[] | null>(null);

  const handleSearch = useCallback(async () => {
    if (!query.trim() || !projectRoot) return;
    setSearching(true);
    setReplaceResults(null);
    try {
      const found = await searchInFiles(platform, projectRoot, query, isRegex, includePattern, excludePattern);
      setResults(found);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, [query, projectRoot, platform, isRegex, includePattern, excludePattern]);

  const handleReplace = useCallback(async () => {
    if (!query.trim() || !projectRoot || results.length === 0) return;
    setReplacing(true);
    const replaceRe = isRegex ? new RegExp(query, 'gi') : new RegExp(escapeRegex(query), 'gi');
    const fileMap = new Map<string, SearchResult[]>();
    for (const r of results) {
      const existing = fileMap.get(r.path) ?? [];
      existing.push(r);
      fileMap.set(r.path, existing);
    }
    const replaceRes: ReplaceResult[] = [];
    for (const [filePath, matches] of fileMap) {
      try {
        const content = await platform.fs.readFile(filePath);
        const newContent = content.replace(replaceRe, replaceText);
        const count = matches.length;
        await platform.fs.writeFile(filePath, newContent);
        replaceRes.push({ path: filePath, replacements: count });
      } catch { /* skip */ }
    }
    setReplaceResults(replaceRes);
    setReplacing(false);
    setResults([]);
  }, [query, results, projectRoot, platform, isRegex, replaceText]);

  const fileCount = useMemo(() => new Set(results.map(r => r.path)).size, [results]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '8px 10px', borderBottom: '1px solid rgba(255,255,255,0.05)', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSearch(); }}
            placeholder={t('globalSearch.searchPlaceholder')}
            style={inputStyle}
          />
          <button onClick={() => setIsRegex(!isRegex)} style={regexBtnStyle(isRegex)} title={t('globalSearch.toggleRegexTitle')}>.*</button>
          <button onClick={handleSearch} disabled={searching} style={searchBtnStyle}>
            {searching ? '…' : t('common.search')}
          </button>
        </div>
        {showReplace && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              value={replaceText}
              onChange={e => setReplaceText(e.target.value)}
              placeholder={t('globalSearch.replacePlaceholder')}
              style={inputStyle}
            />
            <button
              onClick={handleReplace}
              disabled={replacing || results.length === 0}
              style={replaceBtnStyle}
            >
              {replacing ? '…' : t('globalSearch.replaceAllButton')}
            </button>
          </div>
        )}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            value={includePattern}
            onChange={e => setIncludePattern(e.target.value)}
            placeholder={t('globalSearch.includePlaceholder')}
            style={{ ...inputStyle, flex: 1, fontSize: 10 }}
          />
          <input
            value={excludePattern}
            onChange={e => setExcludePattern(e.target.value)}
            placeholder={t('globalSearch.excludePlaceholder')}
            style={{ ...inputStyle, flex: 1, fontSize: 10 }}
          />
          <button
            onClick={() => setShowReplace(!showReplace)}
            style={{ ...searchBtnStyle, background: 'transparent', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.4)' }}
          >
            {showReplace ? t('globalSearch.hideButton') : t('globalSearch.replaceButton')}
          </button>
        </div>
      </div>
      {replaceResults && (
        <div style={{ padding: '6px 10px', fontSize: 10, color: '#66E27A', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
          {t('globalSearch.replacedSummary', {
            files: replaceResults.length,
            count: replaceResults.reduce((s, r) => s + r.replacements, 0),
          })}
        </div>
      )}
      <div style={{ padding: '4px 10px', fontSize: 10, color: 'rgba(255,255,255,0.3)', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
        {results.length > 0 ? t('globalSearch.resultsSummary', { count: results.length, files: fileCount }) : t('globalSearch.noResults')}
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {results.map((r, i) => (
          <div
            key={i}
            role="button"
            tabIndex={0}
            onClick={() => {
              platform.fs.readFile(r.path).then(content => onFileOpen(r.path, r.filename, content));
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                platform.fs.readFile(r.path).then(content => onFileOpen(r.path, r.filename, content));
              }
            }}
            style={{ padding: '4px 12px', cursor: 'pointer', borderBottom: '1px solid rgba(255,255,255,0.02)' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(124,92,255,0.05)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
          >
            <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>
              {r.filename}:{r.line}
            </div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', fontFamily: "'JetBrains Mono', monospace", whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {r.lineContent.trim()}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  flex: 1,
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.06)',
  borderRadius: 4,
  padding: '4px 8px',
  color: '#D5D8E0',
  fontSize: 11,
  fontFamily: 'inherit',
  outline: 'none',
};

function regexBtnStyle(active: boolean): React.CSSProperties {
  return {
    background: active ? 'rgba(124,92,255,0.15)' : 'transparent',
    border: '1px solid rgba(124,92,255,0.2)',
    borderRadius: 4,
    padding: '4px 8px',
    color: active ? '#A78BFF' : 'rgba(255,255,255,0.3)',
    cursor: 'pointer',
    fontSize: 11,
    fontFamily: "'JetBrains Mono', monospace",
  };
}

const searchBtnStyle: React.CSSProperties = {
  background: 'rgba(124,92,255,0.15)',
  border: '1px solid rgba(124,92,255,0.2)',
  borderRadius: 4,
  padding: '4px 12px',
  color: '#A78BFF',
  cursor: 'pointer',
  fontSize: 11,
  fontFamily: 'inherit',
};

const replaceBtnStyle: React.CSSProperties = {
  background: 'rgba(240,113,120,0.15)',
  border: '1px solid rgba(240,113,120,0.2)',
  borderRadius: 4,
  padding: '4px 12px',
  color: '#F07178',
  cursor: 'pointer',
  fontSize: 11,
  fontFamily: 'inherit',
};
