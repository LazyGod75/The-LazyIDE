/* BrainGraphWebGL — Night Signal Obsidian vault on real AdaptedBrainData.

   Three / 3d-force-graph / bloom are dynamic-imported so jsdom tests that
   stub BrainGraph3D never load WebGL. Cluster hubs are octahedrons and are
   never forwarded to onSelectNode. Positions come from the Canvas2D layout
   (pinned) so filter toggles don't reshuffle the vault.
*/

import { useEffect, useRef, useState } from 'react';
import { SafeResizeObserver } from '../../lib/safeResizeObserver';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { AdaptedBrainData, AdaptedNode } from '../../lib/brain/brainAdapter';
import type { PaletteId } from './canvas/palettes';
import { DEFAULT_PALETTE } from './canvas/palettes';
import { TIME_BUCKET_COUNT } from './canvas/dateBucketing';
import {
  cameraForZoom,
  DEFAULT_BRAIN_ZOOM,
  forceGraphPayloadKey,
  mapAdaptedToForceGraph,
  PARTICLE_NODE_CAP,
  VAULT,
  VAULT_ARRIVE,
  zoomFromCamera,
  type ForceBody,
  type ForceLink,
} from './mapBrainForceGraph';
import './brain-hud.css';

void import('3d-force-graph');
void import('three');
void import('three/examples/jsm/postprocessing/UnrealBloomPass.js');
void import('three-spritetext');

type SimNode = ForceBody & { x?: number; y?: number; z?: number };
type SimLink = {
  source: string | SimNode;
  target: string | SimNode;
  rel: ForceLink['rel'];
};

interface Props {
  data: AdaptedBrainData;
  onSelectNode: (node: AdaptedNode) => void;
  focusedNodeId?: string | null;
  paletteId?: PaletteId;
  is3D?: boolean;
  timeIdx?: number;
  zoom?: number;
  onZoomChange?: (zoom: number) => void;
}

type Orbit = {
  autoRotate: boolean;
  autoRotateSpeed: number;
  enableDamping: boolean;
  dampingFactor: number;
  minDistance: number;
  maxDistance: number;
};

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function paintNode(n: SimNode, focusId: string | null, timeIdx: number): string {
  if (n.mass !== 'hub' && n.dateIdx > timeIdx) return '#14141c';
  if (focusId && n.id === focusId) return n.color;
  if (focusId && n.mass !== 'hub') return `${n.color}99`;
  return n.color;
}

function paintLink(l: SimLink, timeIdx: number): string {
  const a = typeof l.source === 'object' ? l.source : null;
  const b = typeof l.target === 'object' ? l.target : null;
  if (a && a.mass !== 'hub' && a.dateIdx > timeIdx) return 'rgba(255,255,255,0.04)';
  if (b && b.mass !== 'hub' && b.dateIdx > timeIdx) return 'rgba(255,255,255,0.04)';
  if (l.rel === 'synapse') return 'rgba(196,181,253,0.75)';
  return `${(a ?? b)?.color ?? '#7C5CFF'}55`;
}

export function BrainGraphWebGL({
  data,
  onSelectNode,
  focusedNodeId = null,
  paletteId = DEFAULT_PALETTE,
  timeIdx = TIME_BUCKET_COUNT - 1,
  zoom = DEFAULT_BRAIN_ZOOM,
  onZoomChange,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const reticleRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraph3DInstance<SimNode, SimLink> | null>(null);
  const dataRef = useRef(data);
  const paletteRef = useRef(paletteId);
  const timeIdxRef = useRef(timeIdx);
  const focusRef = useRef(focusedNodeId);
  const zoomRef = useRef(zoom);
  const onSelectRef = useRef(onSelectNode);
  const onZoomChangeRef = useRef(onZoomChange);
  const introDone = useRef(false);
  const lastKey = useRef('');
  const [ready, setReady] = useState(false);

  dataRef.current = data;
  paletteRef.current = paletteId;
  timeIdxRef.current = timeIdx;
  focusRef.current = focusedNodeId;
  zoomRef.current = zoom;
  onSelectRef.current = onSelectNode;
  onZoomChangeRef.current = onZoomChange;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let dead = false;
    let ro: ResizeObserver | undefined;
    let raf = 0;
    let destroy: (() => void) | undefined;
    let arriveTimer = 0;

    const tickReticle = () => {
      const el = reticleRef.current;
      const g = graphRef.current;
      const id = focusRef.current;
      if (el && g && id) {
        const node = g.graphData().nodes.find((n) => n.id === id);
        if (node && node.x != null && node.y != null && node.z != null) {
          const c = g.graph2ScreenCoords(node.x, node.y, node.z);
          el.style.opacity = '1';
          el.style.transform = `translate(${c.x}px, ${c.y}px) translate(-50%, -50%)`;
        } else {
          el.style.opacity = '0';
        }
      } else if (el) {
        el.style.opacity = '0';
      }
      raf = requestAnimationFrame(tickReticle);
    };

    const boot = async () => {
      const [{ default: ForceGraph3D }, THREE, { UnrealBloomPass }, { default: SpriteText }] = await Promise.all([
        import('3d-force-graph'),
        import('three'),
        import('three/examples/jsm/postprocessing/UnrealBloomPass.js'),
        import('three-spritetext'),
      ]);
      if (dead || !hostRef.current) return;

      const mapped = mapAdaptedToForceGraph(dataRef.current, paletteRef.current);
      const nodes: SimNode[] = mapped.nodes.map((n) => ({ ...n }));
      const links: SimLink[] = mapped.links.map((l) => ({ ...l }));
      const coreCount = mapped.nodes.filter((n) => n.mass === 'core').length;
      const useParticles = coreCount <= PARTICLE_NODE_CAP;

      const fg = new ForceGraph3D(host, {
        controlType: 'orbit',
        rendererConfig: { antialias: true, alpha: false, powerPreference: 'high-performance' },
      }) as unknown as ForceGraph3DInstance<SimNode, SimLink>;
      fg.warmupTicks(0);
      fg.cooldownTime(0);
      fg
        .graphData({ nodes, links })
        .backgroundColor('#030308')
        .showNavInfo(false)
        .enableNodeDrag(false)
        .nodeRelSize(2.1)
        .nodeVal((n) => n.val)
        .nodeResolution(16)
        .nodeOpacity(0.95)
        .nodeColor((n) => paintNode(n, focusRef.current, timeIdxRef.current))
        .nodeLabel((n) =>
          `<div class="brain-tip"><em>${n.mass === 'hub' ? 'CLUSTER' : (n.kind ?? '').toUpperCase()}</em><b>${n.name}</b></div>`,
        )
        .nodeThreeObject((n) => {
          if (n.mass !== 'hub') return false as never;
          const group = new THREE.Group();
          const wire = new THREE.LineSegments(
            new THREE.EdgesGeometry(new THREE.OctahedronGeometry(5.5, 0)),
            new THREE.LineBasicMaterial({ color: n.color, transparent: true, opacity: 0.9 }),
          );
          group.add(wire);
          const sprite = new SpriteText(n.name);
          sprite.color = n.color;
          sprite.textHeight = 5.2;
          sprite.fontFace = 'Space Grotesk';
          sprite.fontWeight = '700';
          sprite.strokeWidth = 0.45;
          sprite.strokeColor = '#030308';
          sprite.center.set(0.5, 1.55);
          sprite.material.depthWrite = false;
          group.add(sprite);
          return group;
        })
        .nodeThreeObjectExtend((n) => n.mass === 'hub')
        .nodeVisibility((n) => n.mass === 'hub' || n.dateIdx <= timeIdxRef.current)
        .linkColor((l) => paintLink(l, timeIdxRef.current))
        .linkOpacity(0.7)
        .linkWidth((l) => (l.rel === 'synapse' ? 1.4 : 0.45))
        .linkDirectionalParticles(useParticles ? (l) => (l.rel === 'synapse' ? 2 : 0) : 0)
        .linkDirectionalParticleWidth(1.35)
        .linkDirectionalParticleSpeed(0.0042)
        .linkDirectionalParticleColor(() => '#c4b5fd')
        .onNodeClick((node) => {
          if (node.mass === 'hub' || !node.source) return;
          onSelectRef.current(node.source);
        });

      const renderer = fg.renderer();
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 0.72;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

      const bloom = new UnrealBloomPass(
        new THREE.Vector2(host.clientWidth || 1, host.clientHeight || 1),
        0.55,
        0.32,
        0.7,
      );
      fg.postProcessingComposer().addPass(bloom);

      const starGeo = new THREE.BufferGeometry();
      const count = 900;
      const pos = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const r = 420 + Math.random() * 780;
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
        pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
        pos[i * 3 + 2] = r * Math.cos(phi);
      }
      starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      fg.scene().add(
        new THREE.Points(
          starGeo,
          new THREE.PointsMaterial({
            color: 0x8a84b8,
            size: 1.1,
            transparent: true,
            opacity: 0.55,
            depthWrite: false,
          }),
        ),
      );

      const reduce = prefersReducedMotion();
      const controls = fg.controls() as Orbit & {
        addEventListener?: (event: string, fn: () => void) => void;
        removeEventListener?: (event: string, fn: () => void) => void;
      };
      controls.autoRotate = !reduce;
      controls.autoRotateSpeed = 0.85;
      controls.enableDamping = true;
      controls.dampingFactor = 0.06;
      controls.minDistance = 80;
      controls.maxDistance = 1600;
      const emitZoom = () => {
        const cam = fg.camera() as { position?: { x: number; y: number; z: number } };
        if (!cam.position) return;
        onZoomChangeRef.current?.(zoomFromCamera(cam.position));
      };
      controls.addEventListener?.('change', emitZoom);

      const cam = fg.camera() as unknown as { far: number; updateProjectionMatrix: () => void };
      cam.far = 4000;
      cam.updateProjectionMatrix();

      fg.cameraPosition(cameraForZoom(zoomRef.current, VAULT_ARRIVE), { x: 0, y: 0, z: 0 });
      const size = () => {
        if (!hostRef.current) return;
        fg.width(hostRef.current.clientWidth);
        fg.height(hostRef.current.clientHeight);
      };
      size();
      ro = new SafeResizeObserver(size);
      ro.observe(host);

      destroy = () => (fg as unknown as { _destructor: () => void })._destructor();
      if (dead) {
        destroy();
        return;
      }
      graphRef.current = fg;
      lastKey.current = forceGraphPayloadKey(dataRef.current, paletteRef.current);
      setReady(true);
      raf = requestAnimationFrame(tickReticle);

      arriveTimer = window.setTimeout(() => {
        if (dead) return;
        fg.cameraPosition(cameraForZoom(zoomRef.current, VAULT), { x: 0, y: 0, z: 0 }, 1800);
        introDone.current = true;
      }, 400);
    };

    void boot();

    return () => {
      dead = true;
      window.clearTimeout(arriveTimer);
      cancelAnimationFrame(raf);
      ro?.disconnect();
      destroy?.();
      graphRef.current = null;
      host.innerHTML = '';
    };
  }, []);

  useEffect(() => {
    const g = graphRef.current;
    if (!g || !ready) return;
    const key = forceGraphPayloadKey(data, paletteId);
    if (key === lastKey.current) return;
    lastKey.current = key;
    const mapped = mapAdaptedToForceGraph(data, paletteId);
    const coreCount = mapped.nodes.filter((n) => n.mass === 'core').length;
    g.graphData({
      nodes: mapped.nodes.map((n) => ({ ...n })),
      links: mapped.links.map((l) => ({ ...l })),
    });
    g.linkDirectionalParticles(
      coreCount <= PARTICLE_NODE_CAP ? (l) => (l.rel === 'synapse' ? 2 : 0) : 0,
    );
  }, [data, paletteId, ready]);

  useEffect(() => {
    const g = graphRef.current;
    if (!g) return;
    g.nodeColor(g.nodeColor())
      .linkColor(g.linkColor())
      .nodeVisibility((n) => n.mass === 'hub' || n.dateIdx <= timeIdx);
  }, [focusedNodeId, timeIdx, ready]);

  useEffect(() => {
    const g = graphRef.current;
    if (!g || !ready || !introDone.current || focusedNodeId) return;
    g.cameraPosition(cameraForZoom(zoom, VAULT), { x: 0, y: 0, z: 0 }, 400);
  }, [zoom, ready, focusedNodeId]);

  useEffect(() => {
    const g = graphRef.current;
    if (!g || !ready) return;
    if (!focusedNodeId) {
      if (introDone.current) g.cameraPosition(cameraForZoom(zoomRef.current, VAULT), { x: 0, y: 0, z: 0 }, 900);
      return;
    }
    const node = g.graphData().nodes.find((n) => n.id === focusedNodeId);
    if (!node || node.x == null || node.y == null || node.z == null) return;
    const controls = g.controls() as Orbit;
    controls.autoRotate = false;
    const dist = node.mass === 'hub' ? 86 : 54;
    const hyp = Math.hypot(node.x, node.y, node.z) || 1;
    const ratio = 1 + dist / hyp;
    g.cameraPosition(
      { x: node.x * ratio, y: node.y * ratio, z: node.z * ratio },
      { x: node.x, y: node.y, z: node.z },
      1400,
    );
    const t = window.setTimeout(() => {
      if (!prefersReducedMotion()) (g.controls() as Orbit).autoRotate = true;
    }, 1500);
    return () => window.clearTimeout(t);
  }, [focusedNodeId, ready]);

  return (
    <div className="brain-webgl" data-testid="brain-graph-webgl">
      <div ref={hostRef} className="brain-webgl-host" />
      <div ref={reticleRef} className="brain-reticle" aria-hidden>
        <i />
        <i />
        <i />
        <i />
        <b />
      </div>
    </div>
  );
}
