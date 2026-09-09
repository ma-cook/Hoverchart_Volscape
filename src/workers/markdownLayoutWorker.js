/**
 * markdownLayoutWorker.js
 *
 * Web Worker that handles the CPU-intensive markdown diagram layout pipeline:
 *   1. Flow-path / tag parsing
 *   2. MarkdownProcessor AST generation
 *   3. Hierarchical relationship building
 *   4. Recursive position + scale computation (positionNodeHierarchy, positionGroupedNodes, resolveCollisions)
 *
 * Returns serialised plain-object data so the main thread can proceed directly
 * to Firebase persistence without any heavy computation.
 *
 * Safe to import here:
 *   - constants.js  (no side-effects, no DOM/store imports)
 *   - hierarchyMethods.js  (only imports constants.js)
 *   - scaleMethods.js      (only imports constants.js)
 *   - positionMethods.js   (only imports constants.js)
 *   - MarkdownProcessor from '3d-ast-generator'  (pure JS parser)
 *
 * NOT imported here (they touch Zustand / Firebase / DOM):
 *   - connectionMethods.js
 *   - objectMethods.js
 *   - containerMethods.js
 *   - spatialPartitioning.js
 */

import { expose } from 'comlink';
import { MarkdownProcessor } from '../lib/3d-ast';

import { hierarchyMethods } from '../services/markdownDiagram/hierarchyMethods.js';
import { scaleMethods } from '../services/markdownDiagram/scaleMethods.js';
import { positionMethods } from '../services/markdownDiagram/positionMethods.js';

// ---------------------------------------------------------------------------
// LayoutEngine  – mixes in only the pure computation methods
// ---------------------------------------------------------------------------

class LayoutEngine {
  constructor() {
    this.processor = null;
    this.scaleCache = new Map();
    this.boundingBoxCache = new Map();
  }

  initializeProcessor() {
    this.processor = new MarkdownProcessor({
      layout: {
        algorithm: 'none',
        nodeSpacing: 60.0,
        layers: 5,
        basePosition: [0, 0, 0],
        enableAutoLayout: false,
      },
      visual: {
        theme: 'dark',
        colors: {
          function: '#4CAF50',
          component: '#2196F3',
          datapath: '#FF9800',
        },
      },
    });
  }
}

Object.assign(LayoutEngine.prototype, hierarchyMethods);
Object.assign(LayoutEngine.prototype, scaleMethods);
Object.assign(LayoutEngine.prototype, positionMethods);

const engine = new LayoutEngine();

// ---------------------------------------------------------------------------
// Pure text helpers (inlined from connectionMethods to avoid its store imports)
// ---------------------------------------------------------------------------

function parseFlowPaths(content) {
  const connectionTags = new Map();

  const blockRegex = /```merfolk\n([\s\S]*?)```/g;
  const merfolkChunks = [];
  let blockMatch;
  while ((blockMatch = blockRegex.exec(content)) !== null) {
    merfolkChunks.push(blockMatch[1]);
  }
  if (merfolkChunks.length === 0) return connectionTags;
  const merfolkContent = merfolkChunks.join('\n');

  const addTag = (src, tgt, name) => {
    const key = `${src}|${tgt}`;
    if (!connectionTags.has(key)) connectionTags.set(key, new Set());
    connectionTags.get(key).add(name);
  };

  const flowpathRegex =
    /^[ \t]*flowpath\s+"([^"]+)"\s*(?:\([^)]*\))?\s*:\s*(.+?)(?:\s*:\s*"[^"]*")?\s*$/gm;
  let match;
  while ((match = flowpathRegex.exec(merfolkContent)) !== null) {
    const name = match[1];
    const sequenceStr = match[2];
    const nodes = sequenceStr
      .split(/\s*(?:<-->|<--|-->|-.->|-\.->|---|===+>|==|\*-->|\.\.>|--)\s*/)
      .map((n) => n.trim())
      .filter(Boolean);
    for (let i = 0; i < nodes.length - 1; i++) {
      addTag(nodes[i], nodes[i + 1], name);
    }
  }

  const taggedConnRegex =
    /^[ \t]*(\w[\w-]*)[ \t]*(?:<-->|<--|-->|-.->|-\.->|===+>|==|\*-->|\.\.>|--[^>]*>|--)[ \t]*(\w[\w-]*)[ \t]*(?::\s*"[^"]*")?[ \t]*((?:#\w+[ \t]*)+)/gm;
  while ((match = taggedConnRegex.exec(merfolkContent)) !== null) {
    const srcId = match[1];
    const tgtId = match[2];
    const tags = (match[3].match(/#(\w+)/g) || []).map((t) => t.slice(1));
    tags.forEach((tag) => addTag(srcId, tgtId, tag));
  }

  return connectionTags;
}

function stripFlowPathSyntax(content) {
  return content.replace(/^[ \t]*flowpath\b[^\n]*/gm, '');
}

// ---------------------------------------------------------------------------
// Header-style helper (inlined from objectMethods to avoid its store imports)
// ---------------------------------------------------------------------------

function computeHeaderStyle(nodeId, objectType, scale, parentChildMap) {
  if (!scale) return { fontSize: 1.5, color: 'black', underline: false };

  const isParent =
    parentChildMap.has(nodeId) && parentChildMap.get(nodeId).size > 0;

  if (objectType === 'dodecahedron' || isParent) {
    const scaleFactor = Math.max(...scale);
    const uiValue = Math.min(10, Math.max(1, Math.round(1 + scaleFactor * 1.5)));
    return { fontSize: uiValue * 0.7, color: 'black', underline: false };
  }

  return { fontSize: 1.5, color: 'black', underline: false };
}

// ---------------------------------------------------------------------------
// Exported worker API
// ---------------------------------------------------------------------------

const workerApi = {
  /**
   * Compute the full layout for a markdown document off the main thread.
   *
   * @param {string} markdownContent  - Raw markdown text from the file
   * @param {number[]} basePosition   - [x, y, z] camera-based spawn position
   * @returns {object}                - Serialisable layout result
   */
  async computeLayout(markdownContent, basePosition) {
    engine.scaleCache.clear();
    engine.boundingBoxCache.clear();

    if (!engine.processor) {
      engine.initializeProcessor();
    }

    // --- Step 1: parse annotations ---
    const connectionTags = parseFlowPaths(markdownContent);
    const processedContent = stripFlowPathSyntax(markdownContent);

    // --- Step 2: build AST ---
    const diagrams = engine.processor.processMarkdown(processedContent);

    if (!diagrams || diagrams.length === 0) {
      return { diagramLayouts: [], connectionTags: [] };
    }

    // --- Step 3: layout each diagram ---
    const diagramLayouts = [];

    for (const diagram of diagrams) {
      if (diagram.errors && diagram.errors.length > 0) {
        diagramLayouts.push({
          hasErrors: true,
          errors: diagram.errors,
          nodes: [],
          rawConnections: [],
          parentChildMap: [],
          childParentMap: [],
          rootNodes: [],
          internalComponentChildren: [],
          graphNodes: [],
        });
        continue;
      }

      const graph = diagram.graph;
      if (!graph || !graph.nodes) {
        diagramLayouts.push({
          hasErrors: true,
          errors: ['Missing graph data'],
          nodes: [],
          rawConnections: [],
          parentChildMap: [],
          childParentMap: [],
          rootNodes: [],
          internalComponentChildren: [],
          graphNodes: [],
        });
        continue;
      }

      // Build hierarchy
      const {
        parentChildMap,
        childParentMap,
        rootNodes,
        internalComponentChildren,
      } = engine.buildHierarchicalRelationships(graph);

      // Compute positions
      const nodePositions = new Map();
      const nodeScales = new Map();
      const processedNodes = new Set();

      const context = {
        parentChildMap,
        childParentMap,
        rootNodes,
        internalComponentChildren,
        graphNodes: graph.nodes,
        graphConnections: graph.connections,
        basePosition,
        nodePositions,
        nodeScales,
        processedNodes,
        alignments: graph.metadata?.alignments || [],
      };

      const rootArray = Array.from(rootNodes);
      rootArray.forEach((rootId, index) => {
        engine.positionNodeHierarchy(
          rootId,
          context,
          basePosition,
          0,
          index,
          rootArray.length
        );
      });

      engine.positionGroupedNodes(context);
      engine.resolveCollisions(context);

      // Honour `align row|column` directives after layout settles
      engine.applyAlignments(context);

      // --- Post-layout: compress extreme positions logarithmically ---
      // Keeps all objects within a renderable volume while preserving
      // relative ordering — big distances still map to larger positions,
      // but no node ends up hundreds of thousands of units away.
      const CLAMP_BOUNDARY = 50000;
      for (const [, pos] of nodePositions) {
        for (const axis of [0, 1, 2]) {
          if (Math.abs(pos[axis]) > CLAMP_BOUNDARY) {
            const sign = Math.sign(pos[axis]);
            const excess = Math.abs(pos[axis]) - CLAMP_BOUNDARY;
            pos[axis] = sign * (CLAMP_BOUNDARY + Math.log10(excess + 1) * 8000);
          }
        }
      }

      // --- Serialise node layout ---
      const nodes = [];
      for (const [nodeId, position] of nodePositions) {
        const node = graph.nodes.get(nodeId);
        if (!node) continue;

        const scale = nodeScales.get(nodeId);
        const objectType = engine.getObjectTypeForNode(node);
        if (!objectType) continue;

        nodes.push({
          nodeId,
          objectType,
          nodeType: (node.type || '').toLowerCase().trim(),
          position,
          scale: scale || [1, 1, 1],
          headerText: node.name || node.id || 'Node',
          headerStyle: computeHeaderStyle(nodeId, objectType, scale, parentChildMap),
          properties: node.properties || {},
          color: node.visual?.color,
          opacity: node.visual?.opacity,
        });
      }

      // --- Serialise connections ---
      const rawConnections = graph.connections
        ? Array.from(graph.connections.values()).map((c) => ({
            source: c.source?.nodeId || c.source,
            target: c.target?.nodeId || c.target,
            label: c.label || '',
            connectionType: c.type || c.connectionType || '',
            visual: c.visual || null,
            arrowStart: !!c.arrowStart,
            arrowEnd: !!c.arrowEnd,
          }))
        : [];

      // --- Serialise Maps for container creation on main thread ---
      diagramLayouts.push({
        hasErrors: false,
        errors: [],
        nodes,
        rawConnections,
        parentChildMap: Array.from(parentChildMap.entries()).map(([k, v]) => [
          k,
          Array.from(v),
        ]),
        childParentMap: Array.from(childParentMap.entries()),
        rootNodes: Array.from(rootNodes),
        internalComponentChildren: Array.from(internalComponentChildren),
        ungroupedComponents: context.ungroupedComponents || [],
        // Minimal node metadata needed by container-sizing methods on main thread
        graphNodes: Array.from(graph.nodes.entries()).map(([k, v]) => [
          k,
          {
            id: v.id || v.nodeId || k,
            type: v.type,
            name: v.name,
            properties: v.properties || {},
            visual: v.visual || null,
            metadata: v.metadata || {},
            parent: v.parent,
          },
        ]),
      });
    }

    // Serialise connectionTags: Map<string, Set<string>> → [[key, [tag, ...]]]
    const serializedConnectionTags = Array.from(connectionTags.entries()).map(
      ([key, set]) => [key, Array.from(set)]
    );

    return { diagramLayouts, connectionTags: serializedConnectionTags };
  },
};

expose(workerApi);
