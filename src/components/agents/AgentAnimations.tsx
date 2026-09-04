/* AgentAnimations — injects CSS keyframe animations into document head */

import { useEffect } from 'react';

const CSS = `
  @keyframes pulse-dot {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.45; transform: scale(0.82); }
  }
  @keyframes progress-shimmer {
    0% { background-position: 200% center; }
    100% { background-position: -200% center; }
  }
  @keyframes timeline-blink {
    0%, 49% { opacity: 1; }
    50%, 100% { opacity: 0; }
  }
  @keyframes pulse-violet {
    0%, 100% { box-shadow: 0 0 0 1px rgba(124,92,255,0.22), 0 4px 20px rgba(124,92,255,0.10); }
    50% { box-shadow: 0 0 0 1px rgba(124,92,255,0.40), 0 4px 24px rgba(124,92,255,0.22); }
  }
  .agent-live-dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #22C55E;
    animation: pulse-dot 1.8s ease-in-out infinite;
    flex-shrink: 0;
  }
  .agent-progress-bar {
    height: 3px;
    border-radius: 2px;
    background: linear-gradient(90deg, #7C5CFF 0%, #A78BFF 50%, #7C5CFF 100%);
    background-size: 200% auto;
    animation: progress-shimmer 2.2s linear infinite;
  }
  .agent-progress-track {
    background: rgba(255,255,255,0.07);
    border-radius: 2px;
    height: 3px;
    overflow: hidden;
  }
  .agent-timeline-cursor {
    display: inline-block;
    width: 6px;
    height: 11px;
    background: #7C5CFF;
    border-radius: 1px;
    margin-left: 4px;
    vertical-align: middle;
    animation: timeline-blink 1s steps(1) infinite;
  }
  .agent-running-card {
    animation: pulse-violet 3s ease-in-out infinite;
  }
`;

export function AgentAnimations() {
  useEffect(() => {
    const id = 'lazy-agent-animations';
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = CSS;
    document.head.appendChild(style);
  }, []);

  return null;
}
