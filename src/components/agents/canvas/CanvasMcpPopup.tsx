/* CanvasMcpPopup — a floating popup on the right side of the canvas for
   managing MCP (Model Context Protocol) server connections.
   Shows preset servers (Sentry, Slack, Notion, Linear, Figma, etc.) and
   custom servers, with connect/disconnect toggles and env var configuration.

   Triggered by a circular button on the right edge of the canvas.
*/

import { useCallback, useEffect, useState, type RefObject } from 'react';
import {
  listServerConfigs,
  addServerConfig,
  removeServerConfig,
  updateServerConfig,
  MCP_PRESETS,
  type McpServerConfig,
  type McpPreset,
} from '../../../lib/mcp/mcpRegistry';
import { listMcpTools, disconnectServer, getConnectedServers } from '../../../lib/mcp/mcpClient';
import { useDismissable } from '../../common/useDismissable';

interface CanvasMcpPopupProps {
  open: boolean;
  onClose: () => void;
  /** Ref to the round toggle button that opens/closes this popup
   *  (CanvasFloatingButtons.tsx's "MCP Servers" button) — ignored by the
   *  outside-pointerdown handler so a re-click doesn't close-then-reopen it.
   *  See CanvasLibraryPopup.tsx's identical doc comment on this same prop
   *  for why this is defense-in-depth rather than a required fix here. */
  triggerRef?: RefObject<HTMLElement | null>;
}

export function CanvasMcpPopup({ open, onClose, triggerRef }: CanvasMcpPopupProps) {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [connectedIds, setConnectedIds] = useState<string[]>([]);
  const [expandedPreset, setExpandedPreset] = useState<string | null>(null);
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [customUrl, setCustomUrl] = useState('');
  const [customName, setCustomName] = useState('');
  const [tools, setTools] = useState<{ server: string; name: string; description: string }[]>([]);
  const [showTools, setShowTools] = useState(false);
  const panelRef = useDismissable<HTMLDivElement>({
    open,
    onClose,
    ignoreRefs: triggerRef ? [triggerRef] : undefined,
  });

  const reload = useCallback(() => {
    setServers(listServerConfigs());
    setConnectedIds(getConnectedServers());
  }, []);

  useEffect(() => {
    if (!open) return;
    reload();
  }, [open, reload]);

  const handleAddPreset = useCallback((preset: McpPreset) => {
    const config = addServerConfig({
      name: preset.name,
      transport: preset.transport,
      command: preset.command,
      args: preset.args,
      enabled: true,
    });
    // Store env var names as placeholder — user fills them in later
    if (preset.env && preset.env.length > 0) {
      const envRecord: Record<string, string> = {};
      for (const envName of preset.env) {
        envRecord[envName] = envValues[envName] ?? '';
      }
      updateServerConfig(config.id, { env: envRecord });
    }
    setExpandedPreset(null);
    setEnvValues({});
    reload();
  }, [envValues, reload]);

  const handleRemove = useCallback((id: string) => {
    void disconnectServer(id).then(() => {
      removeServerConfig(id);
      reload();
    });
  }, [reload]);

  const handleToggle = useCallback((id: string, currentEnabled: boolean) => {
    updateServerConfig(id, { enabled: !currentEnabled });
    reload();
  }, [reload]);

  const handleRefreshTools = useCallback(async () => {
    try {
      const result = await listMcpTools();
      setTools(result);
      setShowTools(true);
    } catch {
      setTools([]);
      setShowTools(true);
    }
  }, []);

  const handleAddCustom = useCallback(() => {
    if (!customName.trim() || !customUrl.trim()) return;
    addServerConfig({
      name: customName.trim(),
      transport: 'sse',
      url: customUrl.trim(),
      enabled: true,
    });
    setCustomName('');
    setCustomUrl('');
    reload();
  }, [customName, customUrl, reload]);

  if (!open) return null;

  return (
    <>
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.35)',
          zIndex: 1099,
        }}
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      />
      <div
        ref={panelRef}
        data-testid="canvas-mcp-popup"
        role="dialog"
        aria-label="MCP Servers"
        style={{
          position: 'fixed',
          top: '50%',
          right: 16,
          transform: 'translateY(-50%)',
          width: 420,
          maxHeight: '70vh',
          zIndex: 1100,
          background: 'var(--color-panel-2)',
          border: '1px solid rgba(255,255,255,0.14)',
          borderRadius: 12,
          boxShadow: '4px 4px 0 rgba(0,0,0,0.4)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '12px 16px 8px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: '#E2E2F0' }}>
              MCP Servers
            </span>
            <span style={{
              fontSize: 10,
              padding: '2px 6px',
              borderRadius: 4,
              background: 'rgba(124,92,255,0.15)',
              color: 'var(--color-accent)',
              fontWeight: 600,
            }}>
              {connectedIds.length} connected
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              border: 'none',
              background: 'transparent',
              color: 'rgba(255,255,255,0.5)',
              fontSize: 16,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            ×
          </button>
        </div>

        {/* Content */}
        <div style={{
          flex: 1,
          overflowY: 'auto',
          padding: '8px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}>
          {/* Connected servers */}
          {servers.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{
                fontSize: 11,
                fontWeight: 700,
                color: 'rgba(255,255,255,0.35)',
                letterSpacing: '0.07em',
                textTransform: 'uppercase',
                padding: '4px 0',
              }}>
                Configured ({servers.length})
              </div>
              {servers.map((server) => (
                <div
                  key={server.id}
                  data-testid={`mcp-server-${server.name}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 10px',
                    borderRadius: 7,
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid transparent',
                  }}
                >
                  <div
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: connectedIds.includes(server.id) ? '#66E27A' : 'rgba(255,255,255,0.20)',
                      flexShrink: 0,
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: '#E2E2F0',
                    }}>
                      {server.name}
                    </div>
                    <div style={{
                      fontSize: 10,
                      color: 'rgba(255,255,255,0.35)',
                    }}>
                      {server.transport} · {server.command || server.url}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleToggle(server.id, server.enabled)}
                    style={{
                      padding: '3px 8px',
                      borderRadius: 5,
                      border: '1px solid rgba(255,255,255,0.12)',
                      background: server.enabled ? 'rgba(102,226,122,0.10)' : 'transparent',
                      color: server.enabled ? '#66E27A' : 'rgba(255,255,255,0.4)',
                      fontSize: 10,
                      fontWeight: 600,
                      fontFamily: 'inherit',
                      cursor: 'pointer',
                      flexShrink: 0,
                    }}
                  >
                    {server.enabled ? 'ON' : 'OFF'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRemove(server.id)}
                    style={{
                      padding: '3px 8px',
                      borderRadius: 5,
                      border: '1px solid rgba(248,113,113,0.20)',
                      background: 'transparent',
                      color: 'rgba(248,113,113,0.6)',
                      fontSize: 10,
                      fontWeight: 600,
                      fontFamily: 'inherit',
                      cursor: 'pointer',
                      flexShrink: 0,
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Preset servers */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{
              fontSize: 11,
              fontWeight: 700,
              color: 'rgba(255,255,255,0.35)',
              letterSpacing: '0.07em',
              textTransform: 'uppercase',
              padding: '4px 0',
            }}>
              Add Server ({MCP_PRESETS.length} presets)
            </div>
            {MCP_PRESETS.map((preset) => {
              const isExpanded = expandedPreset === preset.name;
              const alreadyAdded = servers.some((s) => s.name === preset.name);
              return (
                <div key={preset.name}>
                  <button
                    type="button"
                    disabled={alreadyAdded}
                    onClick={() => {
                      if (preset.env && preset.env.length > 0) {
                        setExpandedPreset(isExpanded ? null : preset.name);
                        setEnvValues({});
                      } else {
                        handleAddPreset(preset);
                      }
                    }}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 10px',
                      borderRadius: 7,
                      background: 'rgba(255,255,255,0.03)',
                      border: '1px solid transparent',
                      cursor: alreadyAdded ? 'default' : 'pointer',
                      textAlign: 'left',
                      fontFamily: 'inherit',
                      opacity: alreadyAdded ? 0.4 : 1,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: '#E2E2F0',
                      }}>
                        {preset.name}
                      </div>
                      <div style={{
                        fontSize: 10,
                        color: 'rgba(255,255,255,0.35)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}>
                        {preset.description}
                      </div>
                    </div>
                    {alreadyAdded ? (
                      <span style={{ fontSize: 10, color: '#66E27A', fontWeight: 600 }}>✓ Added</span>
                    ) : (
                      <span style={{ fontSize: 14, color: 'var(--color-accent)' }}>+</span>
                    )}
                  </button>
                  {/* Env var inputs */}
                  {isExpanded && preset.env && preset.env.length > 0 && (
                    <div style={{
                      padding: '8px 10px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                    }}>
                      {preset.env.map((envName) => (
                        <input
                          key={envName}
                          type="password"
                          placeholder={envName}
                          value={envValues[envName] ?? ''}
                          onChange={(e) => setEnvValues((prev) => ({ ...prev, [envName]: e.target.value }))}
                          style={{
                            width: '100%',
                            background: 'var(--color-bg)',
                            border: '1px solid rgba(255,255,255,0.12)',
                            borderRadius: 5,
                            padding: '4px 8px',
                            color: '#E2E2F0',
                            fontSize: 11,
                            fontFamily: 'inherit',
                            outline: 'none',
                            boxSizing: 'border-box',
                          }}
                        />
                      ))}
                      <button
                        type="button"
                        onClick={() => handleAddPreset(preset)}
                        style={{
                          padding: '4px 12px',
                          borderRadius: 5,
                          border: 'none',
                          background: 'var(--color-accent)',
                          color: '#fff',
                          fontSize: 11,
                          fontWeight: 600,
                          fontFamily: 'inherit',
                          cursor: 'pointer',
                        }}
                      >
                        Add {preset.name}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Custom SSE server */}
          <div style={{
            padding: '8px 10px',
            borderRadius: 7,
            background: 'rgba(255,255,255,0.03)',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}>
            <div style={{
              fontSize: 11,
              fontWeight: 700,
              color: 'rgba(255,255,255,0.35)',
              letterSpacing: '0.07em',
              textTransform: 'uppercase',
            }}>
              Custom SSE Server
            </div>
            <input
              type="text"
              placeholder="Server name"
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              style={{
                background: 'var(--color-bg)',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 5,
                padding: '4px 8px',
                color: '#E2E2F0',
                fontSize: 11,
                fontFamily: 'inherit',
                outline: 'none',
              }}
            />
            <input
              type="text"
              placeholder="https://api.example.com/mcp/sse"
              value={customUrl}
              onChange={(e) => setCustomUrl(e.target.value)}
              style={{
                background: 'var(--color-bg)',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 5,
                padding: '4px 8px',
                color: '#E2E2F0',
                fontSize: 11,
                fontFamily: 'inherit',
                outline: 'none',
              }}
            />
            <button
              type="button"
              onClick={handleAddCustom}
              disabled={!customName.trim() || !customUrl.trim()}
              style={{
                padding: '4px 12px',
                borderRadius: 5,
                border: 'none',
                background: !customName.trim() || !customUrl.trim() ? 'rgba(255,255,255,0.10)' : 'var(--color-accent)',
                color: '#fff',
                fontSize: 11,
                fontWeight: 600,
                fontFamily: 'inherit',
                cursor: !customName.trim() || !customUrl.trim() ? 'default' : 'pointer',
              }}
            >
              + Add Custom Server
            </button>
          </div>

          {/* Tools discovery */}
          <button
            type="button"
            onClick={handleRefreshTools}
            style={{
              padding: '6px 12px',
              borderRadius: 7,
              border: '1px solid rgba(255,255,255,0.12)',
              background: 'rgba(255,255,255,0.03)',
              color: 'var(--color-text)',
              fontSize: 12,
              fontWeight: 600,
              fontFamily: 'inherit',
              cursor: 'pointer',
              textAlign: 'center',
            }}
          >
            ⟳ Discover Available Tools
          </button>
          {showTools && (
            <div style={{
              padding: '8px 10px',
              borderRadius: 7,
              background: 'rgba(255,255,255,0.03)',
              maxHeight: 200,
              overflowY: 'auto',
            }}>
              {tools.length === 0 ? (
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', textAlign: 'center' }}>
                  No tools discovered. Make sure servers are enabled and env vars are set.
                </div>
              ) : (
                tools.map((tool, i) => (
                  <div key={i} style={{
                    fontSize: 11,
                    color: 'rgba(255,255,255,0.6)',
                    padding: '2px 0',
                  }}>
                    <span style={{ color: 'var(--color-accent)', fontWeight: 600 }}>{tool.server}</span>
                    <span style={{ color: 'rgba(255,255,255,0.35)' }}> / </span>
                    <span style={{ color: '#E2E2F0' }}>{tool.name}</span>
                    <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.30)' }}>{tool.description}</div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
