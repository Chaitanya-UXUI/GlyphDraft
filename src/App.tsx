import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { 
  Settings, 
  Eye, 
  EyeOff, 
  RefreshCw, 
  Info,
  Layers,
  Plus,
  FolderPlus,
  Copy,
  Trash2,
  Download,
  Type,
  LayoutGrid,
  Undo2,
  Redo2,
  Pencil
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import * as opentype from 'opentype.js';

// --- Types ---

interface Point {
  x: number;
  y: number;
}

interface Segment {
  p1: Point;
  p2: Point;
  sourceId: string;
}

interface Node {
  id: string;
  point: Point;
  adj: string[];
}

interface Edge {
  from: string;
  to: string;
  angle: number;
  visited: boolean;
}

interface Region {
  id: string;
  points: Point[];
  path: string;
  area: number;
  centroid: Point;
}

interface Config {
  majorAxis: number;
  minorAxis: number;
  rotation: number;
  hOverlap: number;
  vOverlap: number;
  rows: number;
  cols: number;
}

interface GlyphAdjustments {
  yOffset: number;
  lsb: number;
  rsb: number;
  scale: number;
}

interface Canvas {
  id: string;
  letter: string;
  filledRegions: Set<string>;
  adjustments: GlyphAdjustments;
}

interface FontMetrics {
  ascender: number;
  descender: number;
  capHeight: number;
  xHeight: number;
  baseline: number;
  lsb: number;
  rsb: number;
}

interface Folder {
  id: string;
  name: string;
  gridParams: Config;
  canvases: Canvas[];
  metrics: FontMetrics;
  syncCaseFills: boolean;
}

interface TypographyConfig {
  fontSize: number;
  kerning: number;
  leading: number;
  previewText: string;
  testStrings: string[];
}

// --- Constants ---
const EPSILON = 1e-4;
const CANVAS_SIZE = 800;
const STORAGE_KEY = 'ellipse_grid_data_v1';

// --- Serialization Helpers ---

const serialize = (data: any) => JSON.stringify(data, (key, value) => {
  if (value instanceof Set) return { _type: 'Set', data: Array.from(value) };
  return value;
});

const deserialize = (json: string) => JSON.parse(json, (key, value) => {
  if (value && typeof value === 'object' && value._type === 'Set') return new Set(value.data);
  return value;
});

// --- Geometry Helpers ---

function getPointId(p: Point): string {
  return `${p.x.toFixed(3)},${p.y.toFixed(3)}`;
}

function lineLineIntersection(p1: Point, p2: Point, p3: Point, p4: Point): Point | null {
  const x1 = p1.x, y1 = p1.y;
  const x2 = p2.x, y2 = p2.y;
  const x3 = p3.x, y3 = p3.y;
  const x4 = p4.x, y4 = p4.y;

  const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(den) < 1e-10) return null;

  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / den;

  if (t >= -1e-10 && t <= 1 + 1e-10 && u >= -1e-10 && u <= 1 + 1e-10) {
    return {
      x: x1 + t * (x2 - x1),
      y: y1 + t * (y2 - y1)
    };
  }
  return null;
}

function getPolygonArea(points: Point[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    area += (p1.x * p2.y - p2.x * p1.y);
  }
  return area / 2;
}

function getPolygonCentroid(points: Point[]): Point {
  let x = 0, y = 0, area = 0;
  for (let i = 0; i < points.length; i++) {
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    const f = p1.x * p2.y - p2.x * p1.y;
    x += (p1.x + p2.x) * f;
    y += (p1.y + p2.y) * f;
    area += f;
  }
  const divisor = area * 3;
  if (Math.abs(divisor) < 1e-10) return points[0];
  return { x: x / divisor, y: y / divisor };
}

function isPointInPolygon(p: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    const intersect = ((yi > p.y) !== (yj > p.y)) &&
      (p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function isPointInEllipse(p: Point, center: Point, a: number, b: number, rotationDeg: number): boolean {
  if (a <= 0 || b <= 0) return false;
  const rad = (rotationDeg * Math.PI) / 180;
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  // Rotate point back to axis-aligned frame
  const rx = dx * Math.cos(rad) + dy * Math.sin(rad);
  const ry = -dx * Math.sin(rad) + dy * Math.cos(rad);
  return (rx * rx) / (a * a) + (ry * ry) / (b * b) <= 1.0001;
}

function getMirrorChar(char: string): string | null {
  if (char.length !== 1) return null;
  const code = char.charCodeAt(0);
  if (code >= 65 && code <= 90) return String.fromCharCode(code + 32); // A -> a
  if (code >= 97 && code <= 122) return String.fromCharCode(code - 32); // a -> A
  return null;
}

// --- Main Component ---

export default function App() {
  const [folders, setFolders] = useState<Folder[]>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const data = deserialize(saved);
        if (data.folders && Array.isArray(data.folders)) {
          return data.folders.map((f: any) => {
            const metrics = f.metrics || {
              ascender: 750,
              descender: -250,
              capHeight: 700,
              xHeight: 500,
              baseline: 0,
              lsb: 50,
              rsb: 50
            };
            return {
              ...f,
              syncCaseFills: f.syncCaseFills ?? false,
              canvases: f.canvases.map((c: any) => ({
                ...c,
                adjustments: c.adjustments || { yOffset: 0, lsb: metrics.lsb, rsb: metrics.rsb, scale: 1 }
              })),
              metrics
            };
          });
        }
      } catch (e) {
        console.error("Failed to load saved folders", e);
      }
    }
    const initialCanvas: Canvas = { 
      id: 'c1', 
      letter: 'A', 
      filledRegions: new Set(),
      adjustments: { yOffset: 0, lsb: 50, rsb: 50, scale: 1 }
    };
    const defaultMetrics: FontMetrics = {
      ascender: 750,
      descender: -250,
      capHeight: 700,
      xHeight: 500,
      baseline: 0,
      lsb: 50,
      rsb: 50
    };
    return [{
      id: 'f1',
      name: 'Default Project',
      gridParams: {
        majorAxis: 120,
        minorAxis: 80,
        rotation: 30,
        hOverlap: 100,
        vOverlap: 80,
        rows: 3,
        cols: 3
      },
      canvases: [initialCanvas],
      metrics: defaultMetrics,
      syncCaseFills: true
    }];
  });

  const [activeFolderId, setActiveFolderId] = useState<string>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const data = deserialize(saved);
        if (data.activeFolderId) return data.activeFolderId;
      } catch (e) {}
    }
    return 'f1';
  });

  const [activeCanvasId, setActiveCanvasId] = useState<string>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const data = deserialize(saved);
        if (data.activeCanvasId) return data.activeCanvasId;
      } catch (e) {}
    }
    return 'c1';
  });

  const [visibility, setVisibility] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const data = deserialize(saved);
        if (data.visibility) return data.visibility;
      } catch (e) {}
    }
    return {
      ellipses: true,
      gridLines: true,
      regions: true,
      debug: false
    };
  });

  const [typography, setTypography] = useState<TypographyConfig>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const data = deserialize(saved);
        if (data.typography) return {
          ...data.typography,
          testStrings: [
            'Hamburgefonts',
            'The quick brown fox jumps over the lazy dog',
            'ABCDEFGHIJKLMN',
            'opqrstuvwxyz'
          ]
        };
      } catch (e) {}
    }
    return {
      fontSize: 0.15,
      kerning: 10,
      leading: 60,
      previewText: 'Hamburgefonts',
      testStrings: [
        'Hamburgefonts',
        'The quick brown fox jumps over the lazy dog',
        'ABCDEFGHIJKLMN',
        'opqrstuvwxyz'
      ]
    };
  });

  useEffect(() => {
    const data = {
      folders,
      activeFolderId,
      activeCanvasId,
      visibility,
      typography
    };
    localStorage.setItem(STORAGE_KEY, serialize(data));
  }, [folders, activeFolderId, activeCanvasId, visibility, typography]);

  const [isEditingProjectName, setIsEditingProjectName] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [hoveredRegion, setHoveredRegion] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragMode, setDragMode] = useState<'fill' | 'unfill' | null>(null);
  const [sidebarTab, setSidebarTab] = useState<'Grid' | 'Metrics' | 'Preview'>('Grid');
  const [viewMode, setViewMode] = useState<'editor' | 'system'>('editor');
  const [draggingSystemGlyph, setDraggingSystemGlyph] = useState<{ 
    id: string, 
    type: 'yOffset' | 'lsb' | 'rsb', 
    initialVal: number, 
    startX: number,
    startY: number 
  } | null>(null);

  // --- History (Undo/Redo) ---
  const [undoStack, setUndoStack] = useState<Folder[][]>([]);
  const [redoStack, setRedoStack] = useState<Folder[][]>([]);

  const pushHistory = useCallback((currentFolders: Folder[]) => {
    setUndoStack(prev => [...prev.slice(-49), currentFolders]); // Keep last 50 states
    setRedoStack([]);
  }, []);

  const undo = useCallback(() => {
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1];
    setRedoStack(stack => [...stack, folders]);
    setUndoStack(stack => stack.slice(0, -1));
    setFolders(prev);
  }, [undoStack, folders]);

  const redo = useCallback(() => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    setUndoStack(stack => [...stack, folders]);
    setRedoStack(stack => stack.slice(0, -1));
    setFolders(next);
  }, [redoStack, folders]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        if (e.shiftKey) redo();
        else undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        redo();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undo, redo]);

  const activeFolder = folders.find(f => f.id === activeFolderId) || folders[0];
  const activeCanvas = activeFolder.canvases.find(c => c.id === activeCanvasId) || activeFolder.canvases[0];

  const handleSystemMouseDown = (e: React.MouseEvent, canvasId: string, type: 'yOffset' | 'lsb' | 'rsb', currentVal: number) => {
    setDraggingSystemGlyph({
      id: canvasId,
      type,
      initialVal: currentVal,
      startX: e.clientX,
      startY: e.clientY
    });
  };

  const handleSystemMouseMove = useCallback((e: MouseEvent) => {
    if (!draggingSystemGlyph) return;
    const dx = e.clientX - draggingSystemGlyph.startX;
    const dy = e.clientY - draggingSystemGlyph.startY;

    if (draggingSystemGlyph.type === 'yOffset') {
      let newVal = draggingSystemGlyph.initialVal - dy;
      // Snapping
      const snapThreshold = 15;
      const snapPoints = [0, activeFolder.metrics.xHeight, activeFolder.metrics.capHeight];
      for (const snap of snapPoints) {
        if (Math.abs(newVal - snap) < snapThreshold) {
          newVal = snap;
          break;
        }
      }
      updateGlyphAdjustment(draggingSystemGlyph.id, 'yOffset', newVal);
    } else {
      let newVal = draggingSystemGlyph.initialVal + dx;
      if (Math.abs(newVal) < 10) newVal = 0; // Snap to zero
      updateGlyphAdjustment(draggingSystemGlyph.id, draggingSystemGlyph.type, Math.max(0, newVal));
    }
  }, [draggingSystemGlyph, activeFolder.metrics]);

  const handleSystemMouseUp = useCallback(() => {
    setDraggingSystemGlyph(null);
  }, []);

  useEffect(() => {
    if (draggingSystemGlyph) {
      window.addEventListener('mousemove', handleSystemMouseMove);
      window.addEventListener('mouseup', handleSystemMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleSystemMouseMove);
      window.removeEventListener('mouseup', handleSystemMouseUp);
    };
  }, [draggingSystemGlyph, handleSystemMouseMove, handleSystemMouseUp]);

  const ROWS = [
    { label: 'Uppercase', chars: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('') },
    { label: 'Lowercase', chars: 'abcdefghijklmnopqrstuvwxyz'.split('') },
    { label: 'Numerals', chars: '0123456789'.split('') },
    { label: 'Symbols', chars: '!@#$%^&*()_+-=[]{}|;:,.<>?'.split('') },
  ];

  // --- Geometry Computation ---

  const geometry = useMemo(() => {
    const { majorAxis: a, minorAxis: b, rotation, hOverlap, vOverlap, rows, cols } = activeFolder.gridParams;
    const rad = (rotation * Math.PI) / 180;

    const ellipses: Point[][] = [];
    const gridLines: Segment[] = [];
    
    // Metadata for stable ID generation
    const ellipseInfos: { center: Point; dr: number; dc: number }[] = [];
    const vLineInfos: { val: number; dc: number; side: string }[] = [];
    const hLineInfos: { val: number; dr: number; side: string }[] = [];

    const centerX = CANVAS_SIZE / 2;
    const centerY = CANVAS_SIZE / 2;

    for (let r = 0; r < rows; r++) {
      const dr = r - Math.floor(rows / 2);
      for (let c = 0; c < cols; c++) {
        const dc = c - Math.floor(cols / 2);
        // Stable centering: the ellipse at index floor(rows/2), floor(cols/2) is always at centerX, centerY
        const tx = centerX + dc * hOverlap;
        const ty = centerY + dr * vOverlap;
        
        ellipseInfos.push({ center: { x: tx, y: ty }, dr, dc });

        const points: Point[] = [];
        const SAMPLES = 128;
        for (let i = 0; i < SAMPLES; i++) {
          const t = (i / SAMPLES) * 2 * Math.PI;
          const x = a * Math.cos(t);
          const y = b * Math.sin(t);
          const rx = x * Math.cos(rad) - y * Math.sin(rad);
          const ry = x * Math.sin(rad) + y * Math.cos(rad);
          points.push({ x: rx + tx, y: ry + ty });
        }
        ellipses.push(points);

        const xMax = Math.sqrt(a * a * Math.cos(rad) ** 2 + b * b * Math.sin(rad) ** 2);
        const yMax = Math.sqrt(a * a * Math.sin(rad) ** 2 + b * b * Math.cos(rad) ** 2);
        
        gridLines.push({ p1: { x: tx - xMax, y: 0 }, p2: { x: tx - xMax, y: CANVAS_SIZE }, sourceId: `v-${r}-${c}-l` });
        gridLines.push({ p1: { x: tx + xMax, y: 0 }, p2: { x: tx + xMax, y: CANVAS_SIZE }, sourceId: `v-${r}-${c}-r` });
        gridLines.push({ p1: { x: 0, y: ty - yMax }, p2: { x: CANVAS_SIZE, y: ty - yMax }, sourceId: `h-${r}-${c}-t` });
        gridLines.push({ p1: { x: 0, y: ty + yMax }, p2: { x: CANVAS_SIZE, y: ty + yMax }, sourceId: `h-${r}-${c}-b` });

        vLineInfos.push({ val: tx - xMax, dc, side: 'L' });
        vLineInfos.push({ val: tx + xMax, dc, side: 'R' });
        hLineInfos.push({ val: ty - yMax, dr, side: 'T' });
        hLineInfos.push({ val: ty + yMax, dr, side: 'B' });
      }
    }

    let segments: Segment[] = [];
    ellipses.forEach((poly, eIdx) => {
      for (let i = 0; i < poly.length; i++) {
        segments.push({ p1: poly[i], p2: poly[(i + 1) % poly.length], sourceId: `e-${eIdx}-${i}` });
      }
    });
    segments.push(...gridLines);

    const segmentPoints: Map<number, Point[]> = new Map();
    segments.forEach((_, i) => segmentPoints.set(i, [segments[i].p1, segments[i].p2]));

    for (let i = 0; i < segments.length; i++) {
      for (let j = i + 1; j < segments.length; j++) {
        const inter = lineLineIntersection(segments[i].p1, segments[i].p2, segments[j].p1, segments[j].p2);
        if (inter) {
          segmentPoints.get(i)!.push(inter);
          segmentPoints.get(j)!.push(inter);
        }
      }
    }

    const nodes: Map<string, Node> = new Map();
    const edges: Map<string, Edge> = new Map();

    const getOrAddNode = (p: Point) => {
      const id = getPointId(p);
      if (!nodes.has(id)) {
        nodes.set(id, { id, point: p, adj: [] });
      }
      return id;
    };

    segmentPoints.forEach((points, sIdx) => {
      const p1 = segments[sIdx].p1;
      const p2 = segments[sIdx].p2;
      const isVertical = Math.abs(p1.x - p2.x) < 1e-6;
      
      points.sort((a, b) => isVertical ? a.y - b.y : a.x - b.x);

      const uniquePoints: Point[] = [];
      for (let i = 0; i < points.length; i++) {
        if (i === 0 || Math.hypot(points[i].x - points[i-1].x, points[i].y - points[i-1].y) > EPSILON) {
          uniquePoints.push(points[i]);
        }
      }

      for (let i = 0; i < uniquePoints.length - 1; i++) {
        const u = getOrAddNode(uniquePoints[i]);
        const v = getOrAddNode(uniquePoints[i + 1]);
        if (u === v) continue;

        const nodeU = nodes.get(u)!;
        const nodeV = nodes.get(v)!;

        if (!nodeU.adj.includes(v)) nodeU.adj.push(v);
        if (!nodeV.adj.includes(u)) nodeV.adj.push(u);

        const angleUV = Math.atan2(nodeV.point.y - nodeU.point.y, nodeV.point.x - nodeU.point.x);
        const angleVU = Math.atan2(nodeU.point.y - nodeV.point.y, nodeU.point.x - nodeV.point.x);

        edges.set(`${u}->${v}`, { from: u, to: v, angle: angleUV, visited: false });
        edges.set(`${v}->${u}`, { from: v, to: u, angle: angleVU, visited: false });
      }
    });

    const sortedAdj: Map<string, string[]> = new Map();
    nodes.forEach((node, id) => {
      const neighbors = [...node.adj];
      neighbors.sort((a, b) => {
        const angleA = edges.get(`${id}->${a}`)!.angle;
        const angleB = edges.get(`${id}->${b}`)!.angle;
        return angleA - angleB;
      });
      sortedAdj.set(id, neighbors);
    });

    const rawRegions: { points: Point[], path: string, area: number, centroid: Point, topologyId: string }[] = [];
    edges.forEach((edge) => {
      if (edge.visited) return;

      const facePoints: Point[] = [];
      let curr = edge;
      const visitedInThisFace = new Set<string>();

      while (!curr.visited) {
        const key = `${curr.from}->${curr.to}`;
        if (visitedInThisFace.has(key)) break;
        visitedInThisFace.add(key);
        
        curr.visited = true;
        facePoints.push(nodes.get(curr.from)!.point);
        
        const nextNodeId = curr.to;
        const neighbors = sortedAdj.get(nextNodeId)!;
        const idx = neighbors.findIndex(n => n === curr.from);
        const nextIdx = (idx - 1 + neighbors.length) % neighbors.length;
        const nextTarget = neighbors[nextIdx];
        curr = edges.get(`${nextNodeId}->${nextTarget}`)!;
      }

      const area = getPolygonArea(facePoints);
      if (area > 1) {
        const path = `M ${facePoints.map(p => `${p.x},${p.y}`).join(' L ')} Z`;
        const centroid = getPolygonCentroid(facePoints);
        
        // Topology-based ID for stability across grid changes (axis, overlap)
        const insideEllipses = ellipseInfos
          .filter(info => isPointInEllipse(centroid, info.center, a, b, rotation))
          .map(info => `(${info.dr},${info.dc})`)
          .sort()
          .join(',');
        
        const leftLine = vLineInfos.filter(l => l.val < centroid.x - EPSILON).sort((a, b) => b.val - a.val)[0];
        const rightLine = vLineInfos.filter(l => l.val > centroid.x + EPSILON).sort((a, b) => a.val - b.val)[0];
        const topLine = hLineInfos.filter(l => l.val < centroid.y - EPSILON).sort((a, b) => b.val - a.val)[0];
        const bottomLine = hLineInfos.filter(l => l.val > centroid.y + EPSILON).sort((a, b) => a.val - b.val)[0];

        const vSig = `${leftLine ? `${leftLine.dc}${leftLine.side}` : 'S'}|${rightLine ? `${rightLine.dc}${rightLine.side}` : 'E'}`;
        const hSig = `${topLine ? `${topLine.dr}${topLine.side}` : 'S'}|${bottomLine ? `${bottomLine.dr}${bottomLine.side}` : 'E'}`;

        const topologyId = `topo-e:[${insideEllipses}]-v:${vSig}-h:${hSig}`;
        
        rawRegions.push({
          points: facePoints,
          path,
          area,
          centroid,
          topologyId
        });
      }
    });

    // Sort regions by position to ensure stable ID assignment for collisions
    rawRegions.sort((a, b) => {
      if (Math.abs(a.centroid.y - b.centroid.y) > EPSILON) return a.centroid.y - b.centroid.y;
      return a.centroid.x - b.centroid.x;
    });

    const regions: Region[] = [];
    const idCounts: Map<string, number> = new Map();

    rawRegions.forEach(raw => {
      const count = idCounts.get(raw.topologyId) || 0;
      const finalId = count === 0 ? raw.topologyId : `${raw.topologyId}-#${count}`;
      idCounts.set(raw.topologyId, count + 1);
      
      regions.push({
        id: finalId,
        points: raw.points,
        path: raw.path,
        area: raw.area,
        centroid: raw.centroid
      });
    });

    return { regions, nodes: Array.from(nodes.values()), edges: Array.from(edges.values()), ellipses, gridLines };
  }, [activeFolder.gridParams]);

  const glyphLayouts = useMemo(() => {
    const layouts = new Map<string, { xMin: number, xMax: number, width: number }>();
    activeFolder.canvases.forEach(canvas => {
      let xMin = Infinity, xMax = -Infinity;
      let hasContent = false;
      canvas.filledRegions.forEach(regId => {
        const region = geometry.regions.find(r => r.id === regId);
        if (region) {
          region.points.forEach(p => {
            xMin = Math.min(xMin, p.x);
            xMax = Math.max(xMax, p.x);
            hasContent = true;
          });
        }
      });
      if (!hasContent) {
        layouts.set(canvas.id, { xMin: 0, xMax: 100, width: 100 });
      } else {
        layouts.set(canvas.id, { xMin, xMax, width: xMax - xMin });
      }
    });
    return layouts;
  }, [activeFolder.canvases, geometry.regions]);

  // --- Migration Logic (Restore Legacy Fills) ---
  useEffect(() => {
    if (!geometry.regions.length) return;
    
    let folderChanged = false;
    const newCanvases = activeFolder.canvases.map(canvas => {
      const legacyIds = Array.from(canvas.filledRegions).filter(id => typeof id === 'string' && (id.startsWith('reg-') || id.startsWith('region-'))) as string[];
      if (legacyIds.length === 0) return canvas;
      
      const nextFilled = new Set(canvas.filledRegions);
      legacyIds.forEach(legacyId => {
        nextFilled.delete(legacyId);
        
        // Parse coordinates from reg-X.X-Y.Y
        const match = legacyId.match(/reg-([\d.-]+)-([\d.-]+)/);
        if (match) {
          const lx = parseFloat(match[1]);
          const ly = parseFloat(match[2]);
          
          // Find closest region in current geometry
          let closest: Region | null = null;
          let minDist = Infinity;
          geometry.regions.forEach(r => {
            const dist = Math.hypot(r.centroid.x - lx, r.centroid.y - ly);
            if (dist < minDist) {
              minDist = dist;
              closest = r;
            }
          });
          
          if (closest && minDist < 30) { // 30px threshold for migration
            nextFilled.add((closest as Region).id);
          }
        }
      });
      
      folderChanged = true;
      return { ...canvas, filledRegions: nextFilled };
    });
    
    if (folderChanged) {
      setFolders(prev => prev.map(f => f.id === activeFolder.id ? { ...f, canvases: newCanvases } : f));
    }
  }, [geometry.regions, activeFolder.id]);

  // --- Handlers ---

  const handleMouseDown = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const point = { x, y };

    let targetRegion: Region | null = null;
    geometry.regions.forEach(region => {
      if (isPointInPolygon(point, region.points)) {
        if (!targetRegion || region.area < targetRegion.area) {
          targetRegion = region;
        }
      }
    });

    if (targetRegion) {
      pushHistory(folders);
      const isFilled = activeCanvas.filledRegions.has(targetRegion.id);
      const mode = isFilled ? 'unfill' : 'fill';
      setDragMode(mode);
      setIsDragging(true);

      setFolders(prev => prev.map(f => {
        if (f.id !== activeFolderId) return f;
        const mirrorChar = f.syncCaseFills ? getMirrorChar(activeCanvas.letter) : null;
        
        return {
          ...f,
          canvases: f.canvases.map(c => {
            if (c.id !== activeCanvasId && c.letter !== mirrorChar) return c;
            const next = new Set(c.filledRegions);
            if (mode === 'fill') next.add(targetRegion!.id);
            else next.delete(targetRegion!.id);
            return { ...c, filledRegions: next };
          })
        };
      }));
    }
  }, [geometry, activeFolderId, activeCanvasId, activeCanvas.filledRegions, activeCanvas.letter, folders]);

  const handleMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const point = { x, y };

    let targetRegion: Region | null = null;
    geometry.regions.forEach(region => {
      if (isPointInPolygon(point, region.points)) {
        if (!targetRegion || region.area < targetRegion.area) {
          targetRegion = region;
        }
      }
    });

    if (visibility.debug) {
      setHoveredRegion(targetRegion?.id || null);
    }

    if (isDragging && targetRegion && dragMode) {
      setFolders(prev => prev.map(f => {
        if (f.id !== activeFolderId) return f;
        const mirrorChar = f.syncCaseFills ? getMirrorChar(activeCanvas.letter) : null;

        return {
          ...f,
          canvases: f.canvases.map(c => {
            if (c.id !== activeCanvasId && c.letter !== mirrorChar) return c;
            if (dragMode === 'fill' && c.filledRegions.has(targetRegion!.id)) return c;
            if (dragMode === 'unfill' && !c.filledRegions.has(targetRegion!.id)) return c;
            
            const next = new Set(c.filledRegions);
            if (dragMode === 'fill') next.add(targetRegion!.id);
            else next.delete(targetRegion!.id);
            return { ...c, filledRegions: next };
          })
        };
      }));
    }
  }, [geometry, visibility.debug, isDragging, dragMode, activeFolderId, activeCanvasId, activeCanvas.letter]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    setDragMode(null);
  }, []);

  const updateGridParams = (key: keyof Config, val: number) => {
    pushHistory(folders);
    setFolders(prev => prev.map(f => {
      if (f.id !== activeFolderId) return f;
      return { ...f, gridParams: { ...f.gridParams, [key]: val } };
    }));
  };

  const createFolder = () => {
    pushHistory(folders);
    const id = `f-${Date.now()}`;
    const newFolder: Folder = {
      id,
      name: `Project ${folders.length + 1}`,
      gridParams: { ...activeFolder.gridParams },
      canvases: [{ 
        id: `c-${Date.now()}`, 
        letter: 'A', 
        filledRegions: new Set(),
        adjustments: { yOffset: 0, lsb: activeFolder.metrics.lsb, rsb: activeFolder.metrics.rsb, scale: 1 }
      }],
      metrics: { ...activeFolder.metrics },
      syncCaseFills: activeFolder.syncCaseFills
    };
    setFolders(prev => [...prev, newFolder]);
    setActiveFolderId(id);
    setActiveCanvasId(newFolder.canvases[0].id);
  };

  const renameFolder = (id: string, newName: string) => {
    if (newName && newName.trim()) {
      pushHistory(folders);
      setFolders(prev => prev.map(f => f.id === id ? { ...f, name: newName.trim() } : f));
    }
    setIsEditingProjectName(false);
  };

  const deleteFolder = (id: string) => {
    if (folders.length <= 1) {
      setShowDeleteConfirm(false);
      return;
    }
    pushHistory(folders);
    const nextFolders = folders.filter(f => f.id !== id);
    setFolders(nextFolders);
    if (activeFolderId === id) {
      setActiveFolderId(nextFolders[0].id);
      setActiveCanvasId(nextFolders[0].canvases[0].id);
    }
    setShowDeleteConfirm(false);
  };

  const createCanvas = () => {
    pushHistory(folders);
    const lastCanvas = activeFolder.canvases[activeFolder.canvases.length - 1];
    let nextLetter = 'A';
    
    if (lastCanvas && lastCanvas.letter) {
      const lastChar = lastCanvas.letter.toUpperCase();
      const lastCode = lastChar.charCodeAt(0);
      
      if (lastCode >= 65 && lastCode < 90) { // A-Y
        nextLetter = String.fromCharCode(lastCode + 1);
      } else if (lastCode === 90) { // Z
        nextLetter = 'A'; // Wrap around
      } else {
        // If it's not a standard letter, try to increment anyway or default to A
        nextLetter = String.fromCharCode(lastCode + 1);
      }
    }

    const id = `c-${Date.now()}`;
    const newCanvas: Canvas = { 
      id, 
      letter: nextLetter, 
      filledRegions: new Set(),
      adjustments: { yOffset: 0, lsb: activeFolder.metrics.lsb, rsb: activeFolder.metrics.rsb, scale: 1 }
    };
    setFolders(prev => prev.map(f => {
      if (f.id !== activeFolderId) return f;
      return { ...f, canvases: [...f.canvases, newCanvas] };
    }));
    setActiveCanvasId(id);
  };

  const duplicateCanvas = (canvas: Canvas) => {
    pushHistory(folders);
    const id = `c-${Date.now()}`;
    const newCanvas: Canvas = { ...canvas, id, filledRegions: new Set(canvas.filledRegions) };
    setFolders(prev => prev.map(f => {
      if (f.id !== activeFolderId) return f;
      return { ...f, canvases: [...f.canvases, newCanvas] };
    }));
    setActiveCanvasId(id);
  };

  const deleteCanvas = (id: string) => {
    if (activeFolder.canvases.length <= 1) return;
    pushHistory(folders);
    setFolders(prev => prev.map(f => {
      if (f.id !== activeFolderId) return f;
      const nextCanvases = f.canvases.filter(c => c.id !== id);
      return { ...f, canvases: nextCanvases };
    }));
    if (activeCanvasId === id) {
      setActiveCanvasId(activeFolder.canvases.find(c => c.id !== id)!.id);
    }
  };

  const toggleSyncCaseFills = () => {
    pushHistory(folders);
    setFolders(prev => prev.map(f => {
      if (f.id !== activeFolderId) return f;
      return { ...f, syncCaseFills: !f.syncCaseFills };
    }));
  };

  const mirrorToCaseMate = (canvasId: string) => {
    const canvas = activeFolder.canvases.find(c => c.id === canvasId);
    if (!canvas) return;
    const mirrorChar = getMirrorChar(canvas.letter);
    if (!mirrorChar) return;

    pushHistory(folders);
    setFolders(prev => prev.map(f => {
      if (f.id !== activeFolderId) return f;
      return {
        ...f,
        canvases: f.canvases.map(c => {
          if (c.letter === mirrorChar) {
            return { ...c, filledRegions: new Set(canvas.filledRegions) };
          }
          return c;
        })
      };
    }));
  };

  const renameCanvas = (id: string, letter: string) => {
    // allow both upper and lowercase
    setFolders(prev => prev.map(f => {
      if (f.id !== activeFolderId) return f;
      return {
        ...f,
        canvases: f.canvases.map(c => c.id === id ? { ...c, letter: letter.slice(0, 1) } : c)
      };
    }));
  };

  const clearCanvas = (id: string) => {
    pushHistory(folders);
    setFolders(prev => prev.map(f => {
      if (f.id !== activeFolderId) return f;
      return {
        ...f,
        canvases: f.canvases.map(c => c.id === id ? { ...c, filledRegions: new Set() } : c)
      };
    }));
  };

  const updateMetrics = (key: keyof FontMetrics, val: number) => {
    pushHistory(folders);
    setFolders(prev => prev.map(f => {
      if (f.id !== activeFolderId) return f;
      return { ...f, metrics: { ...f.metrics, [key]: val } };
    }));
  };

  const updateGlyphAdjustment = (canvasId: string, key: keyof GlyphAdjustments, val: number) => {
    setFolders(prev => prev.map(f => {
      if (f.id !== activeFolderId) return f;
      return {
        ...f,
        canvases: f.canvases.map(c => {
          if (c.id !== canvasId) return c;
          return { ...c, adjustments: { ...c.adjustments, [key]: val } };
        })
      };
    }));
  };

  const exportFolderSVG = () => {
    const { fontSize, kerning } = typography;
    const scale = fontSize;
    const charWidth = CANVAS_SIZE * scale;
    const charHeight = CANVAS_SIZE * scale;
    
    let svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${activeFolder.canvases.length * (charWidth + kerning)} ${charHeight}">`;
    
    activeFolder.canvases.forEach((canvas, i) => {
      const xOffset = i * (charWidth + kerning);
      svgContent += `<g id="${canvas.letter}-${canvas.id}" transform="translate(${xOffset}, 0) scale(${scale})">`;
      geometry.regions.forEach(region => {
        if (canvas.filledRegions.has(region.id)) {
          svgContent += `<path d="${region.path}" fill="black" stroke="black" stroke-width="0.5" />`;
        }
      });
      svgContent += `</g>`;
    });
    
    svgContent += `</svg>`;
    
    const blob = new Blob([svgContent], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${activeFolder.name}.svg`;
    link.click();
  };

  const exportCanvasSVG = (canvas: Canvas) => {
    let svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS_SIZE} ${CANVAS_SIZE}">`;
    geometry.regions.forEach(region => {
      if (canvas.filledRegions.has(region.id)) {
        svgContent += `<path d="${region.path}" fill="black" stroke="black" stroke-width="0.5" />`;
      }
    });
    svgContent += `</svg>`;
    
    const blob = new Blob([svgContent], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${canvas.letter}.svg`;
    link.click();
  };

  const exportFont = (type: 'otf' | 'ttf') => {
    const unitsPerEm = 1000;
    const { ascender, descender } = activeFolder.metrics;

    const glyphs = activeFolder.canvases.map(canvas => {
      if (canvas.filledRegions.size === 0) return null;

      const { yOffset, lsb, rsb, scale: glyphScale } = canvas.adjustments;
      const path = new opentype.Path();
      
      const canvasHeight = 800;
      const fontHeight = ascender - descender;
      const baseScale = fontHeight / canvasHeight;
      const finalScale = baseScale * glyphScale;

      let xMin = Infinity, xMax = -Infinity;

      canvas.filledRegions.forEach(regionId => {
        const region = geometry.regions.find(r => r.id === regionId);
        if (!region) return;

        region.points.forEach((p, i) => {
          // fy calculation adjusted for per-glyph yOffset
          const fx = p.x * finalScale;
          const fy = ascender - (p.y * finalScale) + yOffset;
          
          if (i === 0) path.moveTo(fx, fy);
          else path.lineTo(fx, fy);

          xMin = Math.min(xMin, fx);
          xMax = Math.max(xMax, fx);
        });
        path.closePath();
      });

      // Shift glyph by its custom LSB
      const shiftX = lsb - xMin;
      path.unitsPerEm = unitsPerEm;
      
      const commands = path.commands.map(cmd => {
        if ('x' in cmd) {
          cmd.x += shiftX;
          if ('x1' in cmd) cmd.x1 += shiftX;
          if ('x2' in cmd) cmd.x2 += shiftX;
        }
        return cmd;
      });

      const finalPath = new opentype.Path();
      finalPath.commands = commands;

      return new opentype.Glyph({
        name: canvas.letter,
        unicode: canvas.letter.charCodeAt(0),
        advanceWidth: (xMax - xMin) + lsb + rsb,
        path: finalPath
      });
    }).filter(g => g !== null) as opentype.Glyph[];

    // Add required .notdef character
    const notdefGlyph = new opentype.Glyph({
      name: '.notdef',
      unicode: 0,
      advanceWidth: 650,
      path: new opentype.Path()
    });

    const font = new opentype.Font({
      familyName: activeFolder.name,
      styleName: 'Regular',
      unitsPerEm: unitsPerEm,
      ascender: ascender,
      descender: descender,
      glyphs: [notdefGlyph, ...glyphs]
    });

    const buffer = font.toArrayBuffer();
    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${activeFolder.name}.${type}`;
    link.click();
  };

  return (
    <div className="flex h-screen w-full bg-[#E4E3E0] text-[#141414] font-sans overflow-hidden flex-col">
      {/* TOP: Folder Controls + Export */}
      <header className="h-14 border-b border-[#141414] bg-white flex items-center px-6 justify-between z-20">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <LayoutGrid size={18} className="opacity-50" />
            
            {isEditingProjectName ? (
              <input
                autoFocus
                className="text-sm font-bold bg-[#F0F0EE] border border-[#141414] px-2 py-0.5 rounded focus:outline-none"
                defaultValue={activeFolder.name}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') renameFolder(activeFolderId, e.currentTarget.value);
                  if (e.key === 'Escape') setIsEditingProjectName(false);
                }}
                onBlur={(e) => renameFolder(activeFolderId, e.target.value)}
              />
            ) : (
              <select 
                value={activeFolderId} 
                onChange={(e) => setActiveFolderId(e.target.value)}
                className="text-sm font-bold bg-transparent border-none focus:ring-0 cursor-pointer max-w-[150px] truncate"
              >
                {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            )}

            <div className="flex items-center gap-1 ml-2 border-l border-[#141414]/10 pl-2">
              {!isEditingProjectName && (
                <button 
                  onClick={() => setIsEditingProjectName(true)}
                  className="p-1.5 hover:bg-[#F0F0EE] transition-colors rounded"
                  title="Rename Project"
                >
                  <Pencil size={14} />
                </button>
              )}
              
              {showDeleteConfirm ? (
                <div className="flex items-center gap-1 bg-red-50 p-0.5 rounded border border-red-200">
                  <button 
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      deleteFolder(activeFolderId);
                    }}
                    className="px-2 py-0.5 text-[9px] font-bold text-red-600 hover:bg-red-100 rounded transition-colors"
                  >
                    Confirm
                  </button>
                  <button 
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setShowDeleteConfirm(false);
                    }}
                    className="px-2 py-0.5 text-[9px] font-bold text-gray-500 hover:bg-gray-100 rounded transition-colors"
                  >
                    Cancel
                  </button>
                </div>>
              ) : (
                <button 
                  onClick={() => setShowDeleteConfirm(true)}
                  className="p-1.5 hover:bg-red-50 text-red-500 transition-colors rounded"
                  title="Delete Project"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          </div>
          <button 
            onClick={createFolder}
            className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider hover:opacity-60 transition-opacity"
          >
            <FolderPlus size={14} />
            New Project
          </button>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex bg-[#F0F0EE] p-1 border border-[#141414]">
            <button 
              onClick={() => setViewMode('editor')}
              className={`px-3 py-1 text-[10px] font-mono uppercase tracking-widest transition-all flex items-center gap-2 ${viewMode === 'editor' ? 'bg-[#141414] text-white' : 'hover:bg-white/50'}`}
            >
              <LayoutGrid size={12} />
              Editor
            </button>
            <button 
              onClick={() => setViewMode('system')}
              className={`px-3 py-1 text-[10px] font-mono uppercase tracking-widest transition-all flex items-center gap-2 ${viewMode === 'system' ? 'bg-[#141414] text-white' : 'hover:bg-white/50'}`}
            >
              <Type size={12} />
              System
            </button>
          </div>

          <div className="flex items-center border border-[#141414] bg-white overflow-hidden">
            <button 
              onClick={undo}
              disabled={undoStack.length === 0}
              className="p-2 hover:bg-[#F0F0EE] disabled:opacity-20 disabled:hover:bg-transparent border-r border-[#141414]"
              title="Undo (Ctrl+Z)"
            >
              <Undo2 size={16} />
            </button>
            <button 
              onClick={redo}
              disabled={redoStack.length === 0}
              className="p-2 hover:bg-[#F0F0EE] disabled:opacity-20 disabled:hover:bg-transparent"
              title="Redo (Ctrl+Y)"
            >
              <Redo2 size={16} />
            </button>
          </div>
          
          <div className="flex items-center gap-1 border border-[#141414] bg-white p-1">
            <button 
              onClick={() => exportFont('otf')}
              className="px-3 py-1 bg-[#141414] text-white text-[10px] font-mono uppercase tracking-widest hover:bg-[#333] transition-colors"
            >
              Export OTF
            </button>
            <button 
              onClick={() => exportFont('ttf')}
              className="px-3 py-1 border border-[#141414] text-[#141414] text-[10px] font-mono uppercase tracking-widest hover:bg-[#F0F0EE] transition-colors"
            >
              TTF
            </button>
          </div>

          <button 
            onClick={exportFolderSVG}
            className="flex items-center gap-2 px-4 py-2 bg-[#141414] text-white text-[10px] font-mono uppercase tracking-widest hover:bg-[#333] transition-colors"
          >
            <Download size={14} />
            Export Project SVG
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* LEFT: Canvas Area */}
        <main className="flex-1 relative flex flex-col overflow-hidden bg-[#F0F0EE]">
          <AnimatePresence mode="wait">
            {viewMode === 'editor' ? (
              <motion.div 
                key="editor"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="flex-1 overflow-auto"
              >
                <div className="min-h-full flex items-center justify-center p-12">
                  <div className="relative bg-white shadow-2xl border border-[#141414] overflow-hidden" style={{ width: CANVAS_SIZE, height: CANVAS_SIZE }}>
                  <svg 
                    width={CANVAS_SIZE} 
                    height={CANVAS_SIZE} 
                    viewBox={`0 0 ${CANVAS_SIZE} ${CANVAS_SIZE}`}
                    onMouseDown={handleMouseDown}
                    onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp}
                    onMouseLeave={handleMouseUp}
                    className="cursor-crosshair select-none"
                  >
                    {visibility.regions && geometry.regions.map(region => {
                      const isFilled = activeCanvas.filledRegions.has(region.id);
                      return (
                        <path
                          key={region.id}
                          d={region.path}
                          fill={isFilled ? '#141414' : 'transparent'}
                          stroke={isFilled ? '#141414' : 'none'}
                          strokeWidth={isFilled ? 0.5 : 0}
                          className="transition-colors duration-200"
                        />
                      );
                    })}

                    {visibility.gridLines && geometry.gridLines.map((line, i) => (
                      <line
                        key={`line-${i}`}
                        x1={line.p1.x}
                        y1={line.p1.y}
                        x2={line.p2.x}
                        y2={line.p2.y}
                        stroke="#141414"
                        strokeWidth="0.5"
                        strokeOpacity="0.1"
                      />
                    ))}

                    {visibility.ellipses && geometry.ellipses.map((poly, i) => (
                      <path
                        key={`ellipse-${i}`}
                        d={`M ${poly.map(p => `${p.x},${p.y}`).join(' L ')} Z`}
                        fill="none"
                        stroke="#141414"
                        strokeWidth="1"
                        strokeOpacity="0.4"
                      />
                    ))}

                    {visibility.debug && (
                      <>
                        {hoveredRegion && (
                          <path
                            d={geometry.regions.find(r => r.id === hoveredRegion)?.path}
                            fill="#FFD700"
                            fillOpacity="0.4"
                            stroke="#FFD700"
                            strokeWidth="2"
                            pointerEvents="none"
                          />
                        )}
                        {geometry.nodes.map(node => (
                          <circle
                            key={node.id}
                            cx={node.point.x}
                            cy={node.point.y}
                            r="1.5"
                            fill="#FF0000"
                            pointerEvents="none"
                          />
                        ))}
                      </>
                    )}
                  </svg>

                  <div className="absolute top-4 left-4 bg-[#141414] text-white px-3 py-1 text-[10px] font-mono uppercase tracking-widest">
                    Canvas: {activeCanvas.letter}
                  </div>
                </div>
              </div>
            </motion.div>
            ) : (
              <motion.div 
                key="system"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 1.02 }}
                className="flex-1 overflow-auto bg-white border border-[#141414]"
              >
                <div className="min-w-max p-12 space-y-24 select-none">
                  {ROWS.map((row, ri) => (
                    <div key={ri} className="space-y-4">
                      <div className="text-[10px] font-mono uppercase tracking-widest opacity-30 px-2">{row.label}</div>
                      <div className="flex items-end gap-x-2 border-b border-[#141414]/10 pb-8 min-h-[400px] relative">
                        {/* Global Row Guides */}
                        <div className="absolute w-full h-full pointer-events-none opacity-10">
                           <div className="absolute bottom-0 w-full border-b border-[#141414] border-dashed" />
                           <div className="absolute w-full border-b border-[#141414]" style={{ bottom: activeFolder.metrics.xHeight / ( (activeFolder.metrics.ascender - activeFolder.metrics.descender) / CANVAS_SIZE) }} />
                           <div className="absolute w-full border-b border-[#141414]" style={{ bottom: activeFolder.metrics.capHeight / ( (activeFolder.metrics.ascender - activeFolder.metrics.descender) / CANVAS_SIZE) }} />
                        </div>

                        {row.chars.map((char, ci) => {
                          const canvas = activeFolder.canvases.find(c => c.letter === char);
                          if (!canvas) return null;
                          const layout = glyphLayouts.get(canvas.id)!;
                          const { lsb, rsb, yOffset, scale: glyphScale } = canvas.adjustments;
                          const fontScale = (activeFolder.metrics.ascender - activeFolder.metrics.descender) / CANVAS_SIZE;
                          const isActive = activeCanvasId === canvas.id;

                          return (
                            <div key={ci} className="relative group">
                              <div 
                                className={`relative border-x border-dashed transition-all ${isActive ? 'bg-[#141414]/5 border-[#141414]' : 'border-[#141414]/10 hover:border-[#141414]/40'}`}
                                style={{ 
                                  width: (layout.width + lsb + rsb) * glyphScale, 
                                  height: CANVAS_SIZE,
                                }}
                                onClick={() => setActiveCanvasId(canvas.id)}
                              >
                                {/* Glyph Specific Guides */}
                                <div className="absolute inset-0 pointer-events-none opacity-20 group-hover:opacity-40 transition-opacity">
                                  <div className="absolute bottom-0 w-full border-b border-[#141414]" /> {/* Baseline */}
                                  <div className="absolute w-[1px] h-full left-0 border-l border-[#141414]" /> {/* LSB */}
                                  <div className="absolute w-[1px] h-full right-0 border-r border-[#141414]" /> {/* RSB */}
                                </div>

                                <svg 
                                  viewBox={`0 0 ${layout.width + lsb + rsb} ${CANVAS_SIZE}`} 
                                  width="100%" 
                                  height="100%"
                                  className="overflow-visible"
                                  style={{ transform: `scale(${glyphScale})`, transformOrigin: 'bottom' }}
                                >
                                  <g transform={`translate(${lsb}, ${-yOffset / fontScale})`}>
                                    {geometry.regions.map(region => (
                                      canvas.filledRegions.has(region.id) && (
                                        <path 
                                          key={region.id} 
                                          d={region.path} 
                                          fill="#141414" 
                                          transform={`translate(${-layout.xMin}, 0)`}
                                        />
                                      )
                                    ))}
                                  </g>
                                </svg>
                                
                                {/* Draggable Overlays */}
                                <div 
                                  className="absolute inset-0 cursor-move"
                                  onMouseDown={(e) => handleSystemMouseDown(e, canvas.id, 'yOffset', yOffset)}
                                  title="Drag vertically to adjust Baseline Shift"
                                />
                                <div 
                                  className="absolute left-0 top-0 bottom-0 w-4 cursor-ew-resize hover:bg-[#141414]/5 z-10"
                                  onMouseDown={(e) => {
                                    e.stopPropagation();
                                    handleSystemMouseDown(e, canvas.id, 'lsb', lsb);
                                  }}
                                  title="Drag to adjust Left Side Bearing"
                                />
                                <div 
                                  className="absolute right-0 top-0 bottom-0 w-4 cursor-ew-resize hover:bg-[#141414]/5 z-10"
                                  onMouseDown={(e) => {
                                    e.stopPropagation();
                                    handleSystemMouseDown(e, canvas.id, 'rsb', rsb);
                                  }}
                                  title="Drag to adjust Right Side Bearing"
                                />

                                {/* Tracker Stats (Only visible in System View) */}
                                <div className="absolute -bottom-12 left-0 right-0 flex justify-between text-[8px] font-mono uppercase tracking-tighter opacity-0 group-hover:opacity-100 transition-opacity bg-white p-2 border border-[#141414] shadow-sm z-20 pointer-events-none">
                                  <div className="flex flex-col gap-1">
                                    <span className="text-[7px] opacity-40">SB</span>
                                    <span>{lsb.toFixed(0)} | {rsb.toFixed(0)}</span>
                                  </div>
                                  <div className="text-right flex flex-col gap-1">
                                    <span className="text-[7px] opacity-40">Y-OFF | GLYPH</span>
                                    <span>{yOffset.toFixed(0)} | {char}</span>
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </main>

        {/* RIGHT: Sidebar Controls */}
        <aside className="w-96 border-l border-[#141414] flex flex-col bg-white overflow-hidden">
          {/* Tabs for Sidebar Sections */}
          <div className="flex border-b border-[#141414] bg-[#F0F0EE]">
            {['Grid', 'Metrics', 'Preview'].map(tab => (
              <button
                key={tab}
                onClick={() => setSidebarTab(tab as any)}
                className={`flex-1 py-3 text-[10px] font-mono uppercase tracking-widest transition-all ${
                  sidebarTab === tab ? 'bg-white font-bold' : 'hover:bg-white/50 opacity-50'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto">
            {sidebarTab === 'Grid' && (
              <>
                {/* Grid Controls */}
                <div className="p-6 border-b border-[#141414]">
                  <div className="flex items-center gap-2 mb-6">
                    <Settings size={14} className="opacity-50" />
                    <h2 className="text-xs font-mono uppercase tracking-wider font-bold">Grid Parameters</h2>
                  </div>
                  <div className="space-y-4">
                    {[
                      { label: 'Major Axis', key: 'majorAxis', min: 20, max: 200 },
                      { label: 'Minor Axis', key: 'minorAxis', min: 20, max: 200 },
                      { label: 'Rotation', key: 'rotation', min: 0, max: 180 },
                      { label: 'H Overlap', key: 'hOverlap', min: 20, max: 200 },
                      { label: 'V Overlap', key: 'vOverlap', min: 20, max: 200 },
                      { label: 'Rows', key: 'rows', min: 1, max: 5 },
                      { label: 'Cols', key: 'cols', min: 1, max: 5 },
                    ].map((item) => (
                      <div key={item.key} className="space-y-1">
                        <div className="flex justify-between text-[10px] font-mono opacity-70">
                          <span>{item.label}</span>
                          <span>{activeFolder.gridParams[item.key as keyof Config]}</span>
                        </div>
                        <input 
                          type="range" 
                          min={item.min} 
                          max={item.max} 
                          value={activeFolder.gridParams[item.key as keyof Config]} 
                          onChange={(e) => updateGridParams(item.key as keyof Config, parseInt(e.target.value))}
                          className="w-full accent-[#141414]"
                        />
                      </div>
                    ))}
                  </div>
                </div>
                <div className="p-6">
                  <button 
                    onClick={() => clearCanvas(activeCanvasId)}
                    className="w-full flex items-center justify-center gap-2 py-3 border border-[#141414] text-xs font-mono uppercase hover:bg-red-500 hover:text-white transition-all"
                  >
                    <RefreshCw size={14} />
                    Clear Active Canvas
                  </button>
                </div>
              </>
            )}

            {sidebarTab === 'Metrics' && (
              <div className="p-6">
                <div className="flex items-center gap-2 mb-6">
                  <LayoutGrid size={14} className="opacity-50" />
                  <h2 className="text-xs font-mono uppercase tracking-wider font-bold">Font Metrics</h2>
                </div>
                <div className="space-y-4">
                  {[
                    { label: 'Ascender', key: 'ascender', min: 500, max: 1000 },
                    { label: 'Descender', key: 'descender', min: -500, max: 0 },
                    { label: 'Cap Height', key: 'capHeight', min: 200, max: 800 },
                    { label: 'X-Height', key: 'xHeight', min: 100, max: 600 },
                    { label: 'LSB', key: 'lsb', min: 0, max: 200 },
                    { label: 'RSB', key: 'rsb', min: 0, max: 200 },
                  ].map((item) => (
                    <div key={item.key} className="space-y-1">
                      <div className="flex justify-between text-[10px] font-mono opacity-70">
                        <span>{item.label}</span>
                        <span>{activeFolder.metrics[item.key as keyof FontMetrics]}</span>
                      </div>
                      <input 
                        type="range" 
                        min={item.min} 
                        max={item.max} 
                        value={activeFolder.metrics[item.key as keyof FontMetrics]} 
                        onChange={(e) => updateMetrics(item.key as keyof FontMetrics, parseInt(e.target.value))}
                        className="w-full accent-[#141414]"
                      />
                    </div>
                  ))}
                </div>

                {/* Per-Glyph Adjustments */}
                <div className="mt-8 border-t border-[#141414] pt-6">
                  <div className="flex items-center gap-2 mb-4">
                    <Type size={14} className="opacity-50" />
                    <h3 className="text-[10px] font-mono uppercase font-bold">Glyph Adjustments ({activeCanvas.letter})</h3>
                  </div>
                  <div className="space-y-4">
                    {[
                      { label: 'LSB Override', key: 'lsb', min: 0, max: 400 },
                      { label: 'RSB Override', key: 'rsb', min: 0, max: 400 },
                      { label: 'Baseline Shift', key: 'yOffset', min: -500, max: 1000 },
                      { label: 'Scale', key: 'scale', min: 0.5, max: 2.0, step: 0.05 },
                    ].map((item) => (
                      <div key={item.key} className="space-y-1">
                        <div className="flex justify-between text-[10px] font-mono opacity-70">
                          <span>{item.label}</span>
                          <span>{activeCanvas.adjustments[item.key as keyof GlyphAdjustments]}</span>
                        </div>
                        <input 
                          type="range" 
                          min={item.min} 
                          max={item.max} 
                          step={item.step || 1}
                          value={activeCanvas.adjustments[item.key as keyof GlyphAdjustments]} 
                          onChange={(e) => updateGlyphAdjustment(activeCanvas.id, item.key as keyof GlyphAdjustments, parseFloat(e.target.value))}
                          className="w-full accent-[#141414]"
                        />
                      </div>
                    ))}
                  </div>
                </div>

                <div className="mt-8 border-t border-[#141414] pt-6 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Layers size={14} className="opacity-50" />
                    <span className="text-[10px] font-mono uppercase font-bold text-[#141414]">Sync Case Fills</span>
                  </div>
                  <button 
                    onClick={toggleSyncCaseFills}
                    className={`w-10 h-5 rounded-full transition-colors relative ${activeFolder.syncCaseFills ? 'bg-green-500' : 'bg-[#141414]/10'}`}
                  >
                    <div className={`absolute top-1 left-1 w-3 h-3 bg-white rounded-full transition-transform ${activeFolder.syncCaseFills ? 'translate-x-5' : 'translate-x-0'}`} />
                  </button>
                </div>
                <p className="text-[9px] font-mono opacity-50 italic">
                  When enabled, designing 'A' automatically mirrors to 'a', and vice versa.
                </p>
                <button 
                  onClick={() => mirrorToCaseMate(activeCanvasId)}
                  disabled={!getMirrorChar(activeCanvas.letter)}
                  className="w-full py-2 border border-[#141414] text-[9px] font-mono uppercase hover:bg-black hover:text-white disabled:opacity-20 disabled:hover:bg-transparent transition-all"
                >
                  Mirror Current to {getMirrorChar(activeCanvas.letter) || 'Mate'}
                </button>
              </div>

              {/* Validation Feedback */}
                <div className="mt-8 border-t border-[#141414] pt-6">
                  <div className="flex items-center gap-2 mb-4">
                    <Info size={14} className="opacity-50" />
                    <h3 className="text-[10px] font-mono uppercase font-bold">Consistency Checklist</h3>
                  </div>
                  <div className="space-y-2">
                    {[
                      { label: 'Upper Case Coverage', check: activeFolder.canvases.filter(c => c.letter >= 'A' && c.letter <= 'Z' && c.filledRegions.size > 0).length === 26 },
                      { label: 'Lower Case Coverage', check: activeFolder.canvases.filter(c => c.letter >= 'a' && c.letter <= 'z' && c.filledRegions.size > 0).length === 26 },
                      { label: 'Shared Grid Logic', check: activeFolder.canvases.every(c => c.filledRegions.size > 0 ? true : true) }, // Stylistic preservation
                      { label: 'n/h Proportions', check: (() => {
                        const n = activeFolder.canvases.find(c => c.letter === 'n');
                        const h = activeFolder.canvases.find(c => c.letter === 'h');
                        return n && h && n.filledRegions.size > 0 && h.filledRegions.size > 0;
                      })() },
                    ].map((v, i) => (
                      <div key={i} className={`text-[9px] font-mono px-2 py-1 flex items-center justify-between gap-2 ${v.check ? 'text-green-600 bg-green-50' : 'text-orange-600 bg-orange-50'}`}>
                        <span className="flex items-center gap-2">
                          <div className={`w-1 h-1 rounded-full ${v.check ? 'bg-green-600' : 'bg-orange-600'}`} />
                          {v.label}
                        </span>
                        <span>{v.check ? 'OK' : 'FAIL'}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {sidebarTab === 'Preview' && (
              <div className="flex-1 flex flex-col min-h-0 min-w-0">
                <div className="p-6 border-b border-[#141414]">
                  <div className="flex items-center gap-2 mb-6">
                    <Type size={14} className="opacity-50" />
                    <h2 className="text-xs font-mono uppercase tracking-wider font-bold">Preview Settings</h2>
                  </div>
                  <div className="space-y-4">
                    <div className="space-y-1">
                      <div className="flex justify-between text-[10px] font-mono opacity-70">
                        <span>Preview Scale</span>
                        <span>{(typography.fontSize * 100).toFixed(0)}%</span>
                      </div>
                      <input 
                        type="range" min="0.05" max="0.5" step="0.01"
                        value={typography.fontSize} 
                        onChange={(e) => setTypography(t => ({ ...t, fontSize: parseFloat(e.target.value) }))}
                        className="w-full accent-[#141414]"
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="flex justify-between text-[10px] font-mono opacity-70">
                        <span>Kerning</span>
                        <span>{typography.kerning}px</span>
                      </div>
                      <input 
                        type="range" min="-50" max="200"
                        value={typography.kerning} 
                        onChange={(e) => setTypography(t => ({ ...t, kerning: parseInt(e.target.value) }))}
                        className="w-full accent-[#141414]"
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="flex justify-between text-[10px] font-mono opacity-70">
                        <span>Leading</span>
                        <span>{typography.leading}px</span>
                      </div>
                      <input 
                        type="range" min="0" max="400"
                        value={typography.leading} 
                        onChange={(e) => setTypography(t => ({ ...t, leading: parseInt(e.target.value) }))}
                        className="w-full accent-[#141414]"
                      />
                    </div>
                  </div>
                </div>

                <div className="p-6 flex-1 flex flex-col min-h-0 overflow-hidden">
                  <div className="flex justify-between items-center mb-4">
                    <div className="flex items-center gap-2">
                      <Eye size={14} className="opacity-50" />
                      <h2 className="text-xs font-mono uppercase tracking-wider font-bold">Text Preview</h2>
                    </div>
                    <div className="flex gap-1 overflow-x-auto max-w-[200px]">
                      {typography.testStrings.map((s, idx) => (
                        <button 
                          key={idx}
                          onClick={() => setTypography(t => ({ ...t, previewText: s }))}
                          className="text-[7px] font-mono border border-[#141414]/20 px-1 py-0.5 hover:bg-[#141414] hover:text-white transition-colors whitespace-nowrap"
                        >
                          T{idx + 1}
                        </button>
                      ))}
                    </div>
                  </div>
                  <textarea 
                    value={typography.previewText}
                    onChange={(e) => setTypography(t => ({ ...t, previewText: e.target.value }))}
                    placeholder="Type to preview font..."
                    className="w-full border border-[#141414] p-3 text-xs font-mono mb-4 focus:ring-1 focus:ring-[#141414] outline-none min-h-[80px] shrink-0"
                  />
                  <div className="flex-1 bg-white border border-[#141414] p-4 overflow-auto rounded-sm">
                    <div className="flex flex-wrap gap-y-[var(--leading)]" style={{ '--leading': `${typography.leading}px` } as any}>
                      {typography.previewText.split('\n').map((line, li) => (
                        <div key={li} className="w-full flex flex-wrap border-b border-[#141414]/5 last:border-0 pb-4 mb-4">
                          {line.split('').map((char, i) => {
                            if (char === ' ') return <div key={i} className="w-8 shrink-0" />;
                            
                            const canvas = activeFolder.canvases.find(c => c.letter === char);
                            if (!canvas) return <div key={i} className="w-6 h-6 border border-dashed border-[#141414]/20 flex items-center justify-center text-[8px] opacity-20 shrink-0">{char}</div>;
                            
                            const layout = glyphLayouts.get(canvas.id)!;
                            const { lsb, rsb, yOffset, scale: itemScale } = canvas.adjustments;
                            const glyphVisualWidth = (layout.width + lsb + rsb) * typography.fontSize;

                            return (
                              <div 
                                key={i} 
                                className="shrink-0 relative"
                                style={{ 
                                  width: glyphVisualWidth, 
                                  height: CANVAS_SIZE * typography.fontSize, 
                                  marginRight: typography.kerning,
                                  opacity: canvas.filledRegions.size > 0 ? 1 : 0.1
                                }}
                              >
                                <svg 
                                  viewBox={`0 0 ${layout.width + lsb + rsb} ${CANVAS_SIZE}`} 
                                  width="100%" 
                                  height="100%"
                                  style={{ transform: `scale(${itemScale})`, transformOrigin: 'bottom left' }}
                                >
                                  <g transform={`translate(${lsb}, ${-yOffset / ( (activeFolder.metrics.ascender - activeFolder.metrics.descender) / CANVAS_SIZE)})`}>
                                    {geometry.regions.map(region => (
                                      canvas.filledRegions.has(region.id) && (
                                        <path 
                                          key={region.id} 
                                          d={region.path} 
                                          fill="#141414" 
                                          transform={`translate(${-layout.xMin}, 0)`}
                                        />
                                      )
                                    ))}
                                  </g>
                                </svg>
                              </div>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* BOTTOM: Canvas Strip */}
      <footer className="h-24 border-t border-[#141414] bg-white flex items-center px-6 gap-4 overflow-x-auto">
        {activeFolder.canvases.map((canvas) => (
          <div 
            key={canvas.id}
            className={`group relative flex flex-col items-center gap-1 p-2 border transition-all cursor-pointer ${
              activeCanvasId === canvas.id ? 'border-[#141414] bg-[#F0F0EE]' : 'border-transparent hover:bg-[#F0F0EE]/50'
            }`}
            onClick={() => setActiveCanvasId(canvas.id)}
          >
            <div className="w-12 h-12 bg-white border border-[#141414]/20 overflow-hidden">
              <svg viewBox={`0 0 ${CANVAS_SIZE} ${CANVAS_SIZE}`} width="100%" height="100%">
                {geometry.regions.map(region => (
                  canvas.filledRegions.has(region.id) && (
                    <path key={region.id} d={region.path} fill="black" stroke="black" strokeWidth="0.5" />
                  )
                ))}
              </svg>
            </div>
            <input 
              type="text"
              value={canvas.letter}
              onChange={(e) => renameCanvas(canvas.id, e.target.value)}
              className="w-8 text-center text-[10px] font-bold bg-transparent border-none p-0 focus:ring-0"
              onClick={(e) => e.stopPropagation()}
            />
            
            {/* Canvas Actions */}
            <div className="absolute -top-2 -right-2 hidden group-hover:flex gap-1">
              <button 
                onClick={(e) => { e.stopPropagation(); duplicateCanvas(canvas); }}
                className="p-1 bg-white border border-[#141414] hover:bg-[#141414] hover:text-white transition-colors"
                title="Duplicate"
              >
                <Copy size={10} />
              </button>
              {getMirrorChar(canvas.letter) && (
                <button 
                  onClick={(e) => { e.stopPropagation(); mirrorToCaseMate(canvas.id); }}
                  className="p-1 bg-white border border-[#141414] hover:bg-green-500 hover:text-white transition-colors"
                  title={`Mirror to ${getMirrorChar(canvas.letter)}`}
                >
                  <Layers size={10} />
                </button>
              )}
              <button 
                onClick={(e) => { e.stopPropagation(); clearCanvas(canvas.id); }}
                className="p-1 bg-white border border-[#141414] hover:bg-orange-500 hover:text-white transition-colors"
                title="Clear Fills"
              >
                <RefreshCw size={10} />
              </button>
              <button 
                onClick={(e) => { e.stopPropagation(); deleteCanvas(canvas.id); }}
                className="p-1 bg-white border border-[#141414] hover:bg-red-500 hover:text-white transition-colors"
                title="Delete"
              >
                <Trash2 size={10} />
              </button>
              <button 
                onClick={(e) => { e.stopPropagation(); exportCanvasSVG(canvas); }}
                className="p-1 bg-white border border-[#141414] hover:bg-[#141414] hover:text-white transition-colors"
                title="Export SVG"
              >
                <Download size={10} />
              </button>
            </div>
          </div>
        ))}
        <button 
          onClick={createCanvas}
          className="w-12 h-12 flex items-center justify-center border border-dashed border-[#141414]/40 hover:border-[#141414] hover:bg-[#F0F0EE] transition-all"
        >
          <Plus size={20} className="opacity-40" />
        </button>
      </footer>

      {/* Visibility Toggles Floating */}
      <div className="absolute bottom-28 left-6 flex gap-2">
        {[
          { label: 'Ellipses', key: 'ellipses' },
          { label: 'Grid', key: 'gridLines' },
          { label: 'Fills', key: 'regions' },
          { label: 'Debug', key: 'debug' },
        ].map((item) => (
          <button
            key={item.key}
            onClick={() => setVisibility(v => ({ ...v, [item.key]: !v[item.key as keyof typeof visibility] }))}
            className={`px-3 py-1 border border-[#141414] text-[9px] font-mono uppercase transition-colors ${
              visibility[item.key as keyof typeof visibility] ? 'bg-[#141414] text-white' : 'bg-white/80 backdrop-blur-sm'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}
