import { MarkdownProcessor } from '../../lib/3d-ast';
import * as THREE from 'three';
import { DEFAULT_CAMERA_DISTANCE } from './constants.js';
import { getMarkdownLayoutWorker } from '../../workers/markdownLayoutWorkerClient.js';
import useDiagramStore from '../../stores/diagramStore.js';
import useObjectsStore from '../../stores/objectsStore.js';
import useConnectionStore from '../../stores/connectionStore.js';
import { api } from '../../api-client';
import importPerf from '../../utils/importPerf';

export const processMethods = {
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
  },

  /**
   * Get camera position for positioning the objects
   * @returns {Array} - [x, y, z] position
   */
  getCameraBasedPosition() {
    const DEFAULT_POSITION = [0, 0, -50];

    try {
      const workingCamera =
        window.cameraRef?.current?.camera ||
        window.camera ||
        window.orbitControls?.object;

      if (!workingCamera?.position) {
        return DEFAULT_POSITION;
      }

      const cameraDirection = new THREE.Vector3();
      try {
        workingCamera.getWorldDirection(cameraDirection);
      } catch {
        cameraDirection.set(0, 0, -1);
      }

      const distance = DEFAULT_CAMERA_DISTANCE;
      const cameraPos = workingCamera.position;

      return [
        cameraPos.x + cameraDirection.x * distance,
        cameraPos.y + cameraDirection.y * distance,
        cameraPos.z + cameraDirection.z * distance,
      ];
    } catch {
      return DEFAULT_POSITION;
    }
  },

  /**
   * Populate diagramStore from raw markdown without creating 3D objects.
   *
   * Used to hydrate the 2D diagram view when loading an existing space that
   * already has objects in Firebase but whose diagramStore is empty (because
   * processMarkdownFile only runs during a fresh scan).
   */
  async hydrateStoreFromMarkdown(content) {
    if (!this.processor) this.initializeProcessor();

    const connectionTags = this.parseFlowPaths(content);
    const processedContent = this.stripFlowPathSyntax(content);
    const diagrams = this.processor.processMarkdown(processedContent);

    if (!diagrams || diagrams.length === 0) {
      // Throw instead of silently returning: UIOverlay's hydration effect falls
      // back to the persisted diagram digest in its catch block, so a silent
      // return here would leave is2DReady false and hide the 2D / repository
      // analysis buttons after a page refresh.
      throw new Error('No Merfolk diagrams found in the stored markdown');
    }

    const validGraphs = diagrams
      .filter((d) => !d.errors || d.errors.length === 0)
      .map((d) => d.graph);

    if (validGraphs.length === 0) {
      throw new Error('Stored markdown contained no valid Merfolk diagrams');
    }

    // Build hierarchy from all graphs
    const allNodes = new Map();
    const allConnections = new Map();
    let connIdx = 0;
    for (const graph of validGraphs) {
      if (graph.nodes) for (const [id, data] of graph.nodes) allNodes.set(id, data);
      if (graph.connections) for (const [, conn] of graph.connections) allConnections.set(`hc-${connIdx++}`, conn);
    }
    const combinedGraph = { nodes: allNodes, connections: allConnections };
    const hierarchy = this.buildHierarchicalRelationships(combinedGraph);

    // Build nodeToObjectIdMap from loaded 3D objects' merfolkData
    const nodeToObjectIdMap = new Map();
    const objects = useObjectsStore.getState().objects;
    for (const obj of objects) {
      const nodeId = obj.merfolkData?.nodeId;
      if (nodeId) nodeToObjectIdMap.set(nodeId, obj.id);
    }

    // Populate store — enables the 2D view
    const store = useDiagramStore.getState();
    store.setGraphs(validGraphs);
    store.setConnectionTags(connectionTags);
    store.setHierarchy(hierarchy);
    store.setNodeToObjectIdMap(nodeToObjectIdMap);

    // Detect communities after graph is hydrated
    try {
      const { detectAndStoreCommunities } = await import('../context/communityService');
      await detectAndStoreCommunities();
    } catch (commErr) {
      console.warn('[hydrateStoreFromMarkdown] Community detection failed:', commErr.message);
    }
  },

  /**
   * Main entry point: parse and process a Markdown/Merfolk file.
   *
   * The heavy layout computation (AST parsing, hierarchy building, position/scale
   * resolution) is offloaded to markdownLayoutWorker via Comlink so the main
   * thread stays responsive.  If the worker is unavailable or throws, the
   * existing main-thread path is used as a transparent fallback.
   */
  async processMarkdownFile(file, onCreateObject, currentSpaceId, user) {
    this.scaleCache.clear();
    this.boundingBoxCache.clear();

    const validExtensions = ['.md', '.markdown'];
    const fileExtension = file.name
      .toLowerCase()
      .substring(file.name.lastIndexOf('.'));

    if (!validExtensions.includes(fileExtension)) {
      throw new Error('Please select a Markdown file (.md or .markdown)');
    }

    // Read file on the main thread (FileReader requires DOM access)
    const content = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = reject;
      reader.readAsText(file);
    });

    // Camera position must be sampled on the main thread
    const basePosition = this.getCameraBasedPosition();

    // ── Attempt worker-computed layout ────────────────────────────────────
    let workerResult = null;
    try {
      const layoutWorker = getMarkdownLayoutWorker();
      workerResult = await layoutWorker.computeLayout(content, basePosition);
    } catch (workerError) {
      console.warn(
        '[MarkdownDiagramService] Layout worker failed – falling back to main thread:',
        workerError
      );
    }

    // ── Build diagrams + connectionTags from worker output or main thread ─
    let diagrams;
    let connectionTags;

    if (workerResult) {
      // Reconstruct diagram-like objects from the serialised worker output so
      // createObjectsFromDiagram and createConnectionsFromDiagram can consume
      // them via the same interface they already expect.
      diagrams = workerResult.diagramLayouts.map((layout) => ({
        graph: {
          // Restore graph.nodes as a Map<nodeId, {id, type, name, properties}>
          nodes: new Map(layout.graphNodes),
          // Restore graph.connections as a Map so .values() iteration works
          connections: new Map(
            layout.rawConnections.map((c, i) => [
              `wc-${i}`,
              {
                source: c.source,
                target: c.target,
                label: c.label,
                type: c.connectionType,
                visual: c.visual || null,
                arrowStart: !!c.arrowStart,
                arrowEnd: !!c.arrowEnd,
              },
            ])
          ),
        },
        errors: layout.errors || [],
      }));
      // Restore Map<string, Set<string>> from [[key, [tag,...]]]
      connectionTags = new Map(
        workerResult.connectionTags.map(([key, tags]) => [key, new Set(tags)])
      );
    } else {
      // ── Main-thread fallback (original behaviour) ──────────────────────
      if (!this.processor) {
        this.initializeProcessor();
      }
      connectionTags = this.parseFlowPaths(content);
      const processedContent = this.stripFlowPathSyntax(content);
      diagrams = this.processor.processMarkdown(processedContent);
    }

    if (!diagrams || diagrams.length === 0) {
      throw new Error(
        'No Merfolk diagrams found in the markdown file. Make sure your file contains properly formatted Merfolk syntax with ```merfolk code blocks.'
      );
    }

    window._lastMerfolkProcessTime = performance.now();

    // Clear previous diagram data before processing new one
    useDiagramStore.getState().clear();

    // Persist parsed graphs and connection tags for the 2D diagram view
    const validGraphs = diagrams
      .filter((d) => !d.errors || d.errors.length === 0)
      .map((d) => d.graph);
    useDiagramStore.getState().setGraphs(validGraphs);
    useDiagramStore.getState().setConnectionTags(connectionTags);

    let totalObjectsCreated = 0;
    const nodeToObjectIdMap = new Map();
    const nodeDataMap = new Map();
    const allConnectionsToSave = [];
    const allObjectsToSave = [];

    window._faceDistributionCounters = new Map();

    for (let diagramIndex = 0; diagramIndex < diagrams.length; diagramIndex++) {
      const diagram = diagrams[diagramIndex];

      if (diagram.errors && diagram.errors.length > 0) {
        console.warn(`Diagram ${diagramIndex} has errors:`, diagram.errors);
        continue;
      }

      // Pass worker-computed layout to skip position/scale on the main thread.
      // When null (fallback path) createObjectsFromDiagram computes it locally.
      const precomputedLayout = workerResult?.diagramLayouts?.[diagramIndex] ?? null;

      const objectsCreated = await this.createObjectsFromDiagram(
        diagram,
        onCreateObject,
        nodeToObjectIdMap,
        basePosition,
        user,
        currentSpaceId,
        allObjectsToSave,
        precomputedLayout,
        nodeDataMap
      );

      totalObjectsCreated += objectsCreated;

      await this.createConnectionsFromDiagram(
        diagram,
        nodeToObjectIdMap,
        allConnectionsToSave,
        connectionTags,
        nodeDataMap
      );
    }

    // Persist the node-to-object mapping so the 2D view can cross-reference.
    // Pass the map directly (no defensive copy) — copying a Map with tens of
    // thousands of entries doubles the transient memory during the scan for
    // no benefit, since nothing mutates it after this point.
    useDiagramStore.getState().setNodeToObjectIdMap(nodeToObjectIdMap);

    // ── Clean up orphaned objects ──────────────────────────────────
    // Objects that have a merfolkData.nodeId that no longer exists in
    // the current diagram are leftovers from previous scans.  Delete
    // them from the store and backend so they don't accumulate.
    await new Promise(r => setTimeout(r, 0));
    const activeNodeIds = new Set(nodeToObjectIdMap.keys());
    const allObjects = useObjectsStore.getState().objects;
    const orphans = allObjects.filter(
      (obj) => obj.merfolkData?.nodeId && !activeNodeIds.has(obj.merfolkData.nodeId)
    );

    if (orphans.length > 0) {
      const orphanIds = new Set(orphans.map((o) => o.id));

      // Remove orphans from the store
      useObjectsStore.getState().setObjects(
        allObjects.filter((o) => !orphanIds.has(o.id))
      );

      await new Promise(r => setTimeout(r, 0));

      // Clean up any connections attached to orphaned objects
      const connectionStore = useConnectionStore.getState();
      const remainingConnections = connectionStore.connections.filter(
        (conn) =>
          !orphanIds.has(conn.start?.objectId) &&
          !orphanIds.has(conn.end?.objectId)
      );
      useConnectionStore.getState().setConnections(remainingConnections);

      await new Promise(r => setTimeout(r, 0));

      // Fire-and-forget backend deletions for orphaned objects
      if (user && currentSpaceId) {
        for (const obj of orphans) {
          const cellCoords = obj.position
            ? ((arr) => ({ x: arr[0], y: arr[1], z: arr[2] || 0 }))(Array.isArray(obj.position) ? obj.position : [0, 0, 0])
            : { x: 0, y: 0, z: 0 };
          const cellId = `${cellCoords.x},${cellCoords.y},${cellCoords.z}`;
          api.delete(`/api/spaces/${currentSpaceId}/objects/${obj.id}?cell_id=${cellId}`).catch(() => {});
        }
      }
    }

    importPerf.mark('processMarkdown: all objects created, starting save + communities');
    const savePromise = this.saveConnections(
      allConnectionsToSave,
      currentSpaceId,
      user,
      allObjectsToSave
    );

    // Detect communities after graph is populated
    try {
      const { detectAndStoreCommunities } = await import('../context/communityService');
      await detectAndStoreCommunities();
    } catch (commErr) {
      console.warn('[processMarkdownFile] Community detection failed:', commErr.message);
    }

    const validDiagrams = diagrams.filter(
      (d) => !d.errors || d.errors.length === 0
    );

    return {
      diagramCount: validDiagrams.length,
      objectsCreated: totalObjectsCreated,
      connectionsCreated: allConnectionsToSave.length,
      success: totalObjectsCreated > 0,
      savePromise: savePromise,
    };
  },
};
