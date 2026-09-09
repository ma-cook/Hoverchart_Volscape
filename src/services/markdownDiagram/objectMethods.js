import { useObjectsStore, useSpatialManagerStore } from '../../stores';
import useDiagramStore from '../../stores/diagramStore.js';
import { getCellCoordinates, getCellId } from '../spatialPartitioning';
import { addToAllCellObjects } from '../cellObjectCache';
import { reportMemoryPressureOnce } from '../../utils/memoryMonitor';

export const objectMethods = {
  /**
   * Create 3D objects from processed diagram data.
   *
   * @param {object}      diagram          - Raw diagram from MarkdownProcessor (or a reconstructed
   *                                         diagram-like object when using precomputedLayout).
   * @param {Function}    onCreateObject   - Callback invoked for each new object.
   * @param {Map}         nodeToObjectIdMap - Populated with nodeId → objectId mappings.
   * @param {number[]}    basePosition     - [x, y, z] spawn origin.
   * @param {object}      user             - Authenticated user record.
   * @param {string}      currentSpaceId   - Active space identifier.
   * @param {object[]}    allObjectsToSave - Accumulator for batch-saving to Firebase.
   * @param {object|null} precomputedLayout - When provided (from markdownLayoutWorker) the
   *                                         position/scale/hierarchy computation is skipped and
   *                                         the serialised arrays are restored into ES6 Maps.
   */
  async createObjectsFromDiagram(
    diagram,
    onCreateObject,
    nodeToObjectIdMap,
    basePosition,
    user,
    currentSpaceId,
    allObjectsToSave,
    precomputedLayout = null,
    nodeDataMap = null
  ) {
    const graph = diagram.graph;
    if (!graph || !graph.nodes) {
      return 0;
    }
    if (nodeDataMap) {
      nodeDataMap.clear();
    }

    let parentChildMap, childParentMap, rootNodes, internalComponentChildren;
    let nodePositions, nodeScales;
    let context;

    if (precomputedLayout) {
      // ── Worker-computed layout ───────────────────────────────────────────
      // Reconstruct ES6 Maps / Sets from the serialised arrays returned by
      // markdownLayoutWorker so container methods receive the types they expect.
      parentChildMap = new Map(
        precomputedLayout.parentChildMap.map(([k, v]) => [k, new Set(v)])
      );
      childParentMap = new Map(precomputedLayout.childParentMap);
      rootNodes = new Set(precomputedLayout.rootNodes);
      internalComponentChildren = new Set(precomputedLayout.internalComponentChildren);
      nodePositions = new Map(
        precomputedLayout.nodes.map((n) => [n.nodeId, n.position])
      );
      nodeScales = new Map(
        precomputedLayout.nodes.map((n) => [n.nodeId, n.scale])
      );
      context = {
        parentChildMap,
        childParentMap,
        rootNodes,
        internalComponentChildren,
        graphNodes: graph.nodes,
        graphConnections: graph.connections,
        basePosition,
        nodePositions,
        nodeScales,
        processedNodes: new Set(),
        // Use the worker-computed ungrouped list so container creation
        // uses the same set of nodes that was positioned as "ungrouped".
        ungroupedComponents: precomputedLayout.ungroupedComponents || [],
        communityAssignments: useDiagramStore.getState().communityAssignments || null,
        alignments: graph.metadata?.alignments || [],
        spaceId: currentSpaceId,
      };
    } else {
      // ── Main-thread fallback (original code path) ────────────────────────
      const relationships = this.buildHierarchicalRelationships(graph);
      parentChildMap = relationships.parentChildMap;
      childParentMap = relationships.childParentMap;
      rootNodes = relationships.rootNodes;
      internalComponentChildren = relationships.internalComponentChildren;

      nodePositions = new Map();
      nodeScales = new Map();
      const processedNodes = new Set();

      context = {
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
        communityAssignments: useDiagramStore.getState().communityAssignments || null,
        alignments: graph.metadata?.alignments || [],
        spaceId: currentSpaceId,
      };

      // Process root nodes
      const rootArray = Array.from(rootNodes);
      rootArray.forEach((rootId, index) => {
        this.positionNodeHierarchy(
          rootId,
          context,
          basePosition,
          0,
          index,
          rootArray.length
        );
      });

      // Position grouped nodes (utilities, services, stores) in square grids
      this.positionGroupedNodes(context);

      // Apply collision detection and resolution to prevent overlapping subtrees
      this.resolveCollisions(context);
    }

    // Honour `align row|column` directives (idempotent — worker paths already
    // applied them, so re-running against the same positions is a no-op).
    this.applyAlignments(context);

    // Persist hierarchy for the 2D diagram view
    useDiagramStore.getState().setHierarchy({
      parentChildMap,
      childParentMap,
      rootNodes,
      internalComponentChildren,
    });

    // ── Sampled histogram (only on small or first-batch for performance) ──
    if (graph.nodes.size < 5000) {
      const positionedTypes = {};
      const unpositionedTypes = {};
      for (const [nodeId, node] of graph.nodes.entries()) {
        const t = (node.type || 'unknown').toLowerCase();
        if (nodePositions.has(nodeId)) {
          positionedTypes[t] = (positionedTypes[t] || 0) + 1;
        } else {
          unpositionedTypes[t] = (unpositionedTypes[t] || 0) + 1;
        }
      }
      console.log('[object-histogram] graph nodes total =', graph.nodes.size);
      console.log('[object-histogram] positioned by type =', positionedTypes);
      console.log('[object-histogram] UNPOSITIONED by type =', unpositionedTypes);
    }

    // Objects are persisted to the DB via bulk import and synced to
    // the store incrementally as they're built.  The spatial system
    // later manages which objects are mounted/unmounted.

    const OBJECT_BATCH_SIZE = 200;
    // Yield to the main thread every N batches to keep the UI responsive.
    // Flush accumulated objects to the Zustand store every STORE_FLUSH_SIZE items
    // so React can start progressive mounting while more objects are being built.
    const STORE_FLUSH_SIZE = 1000;

    // Build a lookup map of existing objects by merfolkData.nodeId to avoid re-creating
    const existingObjects = useObjectsStore.getState().objects;
    const existingNodeIdMap = new Map();
    for (const obj of existingObjects) {
      if (obj.merfolkData?.nodeId) {
        existingNodeIdMap.set(obj.merfolkData.nodeId, obj.id);
      }
    }

    // Collect position updates for existing objects during rescan (reprocessed merged markdown)
    const positionUpdates = new Map();

    const nodeEntries = Array.from(nodePositions);
    let objectsCreated = 0;
    let storeBatch = [];
    let pendingAllObjects = [];

    for (let i = 0; i < nodeEntries.length; i += OBJECT_BATCH_SIZE) {
      const batch = nodeEntries.slice(i, i + OBJECT_BATCH_SIZE);

      const batchData = batch
        .map(([nodeId, position]) => {
          const node = graph.nodes.get(nodeId);
          const scale = nodeScales.get(nodeId);
          const isInternalComponent = node.type === 'component' && internalComponentChildren.has(nodeId);
          const objectType = this.getObjectTypeForNode(node, isInternalComponent);

          if (!objectType || !node) return null;

          const calculateHeaderStyle = (scale, objectType, nodeId) => {
            if (!scale) {
              return { fontSize: 1.5, color: 'black', underline: false };
            }

            const isParent = parentChildMap.has(nodeId) && parentChildMap.get(nodeId).size > 0;

            if (objectType === 'dodecahedron' || isParent) {
              const scaleFactor = Math.max(...scale);
              const uiValue = Math.min(10, Math.max(1, Math.round(1 + scaleFactor * 1.5)));
              const fontSize = uiValue * 0.7;
              return { fontSize: fontSize, color: 'black', underline: false };
            }

            return { fontSize: 1.5, color: 'black', underline: false };
          };

          const headerStyle = calculateHeaderStyle(scale, objectType, nodeId);

          return {
            nodeId,
            type: objectType,
            position,
            extraData: {
              scale,
              headerText: node.name || node.id || 'Node',
              headerStyle: headerStyle,
              color: node.visual?.color,
              opacity: node.visual?.opacity,
              ...(node.properties || {}),
              ...(node.metadata || {}),
            },
          };
        })
        .filter(Boolean);

      for (const data of batchData) {
        try {
          if (!Array.isArray(data.position) || data.position.length < 3 ||
              !Number.isFinite(data.position[0]) ||
              !Number.isFinite(data.position[1]) ||
              !Number.isFinite(data.position[2])) {
            console.warn('⚠️ Skipping object with invalid position:', data.nodeId, data.position);
            continue;
          }

          if (existingNodeIdMap.has(data.nodeId)) {
            nodeToObjectIdMap.set(data.nodeId, existingNodeIdMap.get(data.nodeId));
            positionUpdates.set(existingNodeIdMap.get(data.nodeId), data.position);
            continue;
          }

          const objectId = `merfolk-obj-${Date.now()}-${Math.random()
            .toString(36)
            .substr(2, 9)}`;

          const cellCoords = getCellCoordinates(data.position);
          const cellId = getCellId(cellCoords.x, cellCoords.y, cellCoords.z);

          const isPlanned = data.extraData.planned === true;
          const intendedColor = data.extraData.color || '#4a90e2';
          const objectColor = isPlanned ? '#ef5350' : intendedColor;

          const objectData = {
            id: objectId,
            type: data.type,
            position: data.position,
            scale: data.extraData.scale || [1, 1, 1],
            color: objectColor,
            cellId: cellId,
            createdAt: Date.now(),
            ...(data.type === 'dodecahedron'
              ? {
                  headerText: data.extraData.headerText || '',
                  headerStyle: data.extraData.headerStyle || {
                    fontSize: 1.5, color: 'black', underline: false,
                  },
                  faceColors: {},
                  faceTexts: Array(12).fill('').reduce((acc, _, idx) => {
                    acc[idx] = ''; return acc;
                  }, {}),
                  faceTextStyles: Array(12).fill(null).reduce((acc, _, idx) => {
                    acc[idx] = { fontSize: 0.5, color: 'black', underline: false };
                    return acc;
                  }, {}),
                }
              : data.type === 'cube'
              ? {
                  headerText: data.extraData.headerText || '',
                  faceColors: {},
                  faceTexts: { front: '', back: '', top: '', bottom: '', right: '', left: '' },
                  textStyle: data.extraData.headerStyle || {
                    fontSize: 1.5, color: 'black', underline: false,
                  },
                }
              : data.type === 'octahedron'
              ? {
                  headerText: data.extraData.headerText || '',
                  faceColors: {},
                  faceTexts: { f0: '', f1: '', f2: '', f3: '', f4: '', f5: '', f6: '', f7: '' },
                  textStyle: data.extraData.headerStyle || {
                    fontSize: 1.5, color: 'black', underline: false,
                  },
                }
              : data.type === 'tetrahedron'
              ? {
                  headerText: data.extraData.headerText || '',
                  faceColors: {},
                  faceTexts: { front: '', back: '', left: '', right: '' },
                  textStyle: data.extraData.headerStyle || {
                    fontSize: 1.5, color: 'black', underline: false,
                  },
                }
              : data.type === 'sphere'
              ? {
                  headerText: data.extraData.headerText || '',
                  headerStyle: data.extraData.headerStyle || {
                    fontSize: 1.5, color: 'black', underline: false,
                  },
                  faceColors: {},
                  faceTexts: Array(12).fill('').reduce((acc, _, idx) => {
                    acc[idx] = ''; return acc;
                  }, {}),
                  faceTextStyles: Array(12).fill(null).reduce((acc, _, idx) => {
                    acc[idx] = { fontSize: 0.5, color: 'black', underline: false };
                    return acc;
                  }, {}),
                }
              : data.type === 'plane'
              ? {
                  content: data.extraData.headerText || '',
                  textStyle: data.extraData.headerStyle || {
                    fontSize: 1.5, color: 'black', underline: false,
                  },
                }
              : {}),
            merfolkData: {
              nodeId: data.nodeId,
              codeFilePath: data.extraData.codeFilePath || '',
              exports: data.extraData.exports || '',
              htmlElements: data.extraData.htmlElements || '',
              cssClasses: data.extraData.cssClasses || '',
              jsxRefs: data.extraData.jsxRefs || '',
              ...(isPlanned && { planned: true, originalColor: intendedColor }),
              ...(data.extraData.merfolkData || {}),
            },
          };

          // Add every object to the store immediately — progressive mounting
          // in ObjectsRenderer handles per-frame rendering costs.
          storeBatch.push(objectData);

          // Cell tracking is batched at flush time (trackObjectsInCellBatch)
          // instead of cloning the whole objectsByCell map once per object.

          const objectForSave = {
            id: objectId,
            position: data.position,
            size: data.extraData.scale || [1, 1, 1],
            scale: data.extraData.scale || [1, 1, 1],
            type: data.type,
            color: objectColor,
            content: data.extraData.headerText || '',
            createdAt: Date.now(),
            cellId: cellId,
            ...(data.extraData.rotation && { rotation: data.extraData.rotation }),
            ...(data.extraData.headerStyle && { textStyle: data.extraData.headerStyle }),
            ...(data.type === 'dodecahedron' && {
              headerText: data.extraData.headerText || '',
              headerStyle: data.extraData.headerStyle || {
                fontSize: 1.5, color: 'black', underline: false,
              },
              faceColors: {},
              faceTexts: Array(12).fill('').reduce((acc, _, idx) => {
                acc[idx] = ''; return acc;
              }, {}),
              faceTextStyles: Array(12).fill(null).reduce((acc, _, idx) => {
                acc[idx] = { fontSize: 0.5, color: 'black', underline: false };
                return acc;
              }, {}),
            }),
            ...(data.type === 'cube' && {
              headerText: data.extraData.headerText || '',
              faceColors: {},
              faceTexts: { front: '', back: '', top: '', bottom: '', right: '', left: '' },
            }),
            ...(data.type === 'octahedron' && {
              headerText: data.extraData.headerText || '',
              faceColors: {},
              faceTexts: { f0: '', f1: '', f2: '', f3: '', f4: '', f5: '', f6: '', f7: '' },
            }),
            ...(data.type === 'tetrahedron' && {
              headerText: data.extraData.headerText || '',
              faceColors: {},
              faceTexts: { front: '', back: '', left: '', right: '' },
            }),
            ...(data.type === 'sphere' && {
              headerText: data.extraData.headerText || '',
              headerStyle: data.extraData.headerStyle || {
                fontSize: 1.5, color: 'black', underline: false,
              },
              faceColors: {},
              faceTexts: Array(12).fill('').reduce((acc, _, idx) => {
                acc[idx] = ''; return acc;
              }, {}),
            }),
            merfolkData: {
              nodeId: data.nodeId,
              codeFilePath: data.extraData.codeFilePath || '',
              exports: data.extraData.exports || '',
              htmlElements: data.extraData.htmlElements || '',
              cssClasses: data.extraData.cssClasses || '',
              jsxRefs: data.extraData.jsxRefs || '',
              ...(isPlanned && { planned: true, originalColor: intendedColor }),
              ...(data.extraData.merfolkData || {}),
            },
          };

          allObjectsToSave.push(objectForSave);

          nodeToObjectIdMap.set(data.nodeId, objectId);
          if (nodeDataMap) {
            nodeDataMap.set(data.nodeId, {
              position: data.position,
              scale: data.extraData.scale || [1, 1, 1],
              type: data.type,
            });
          }
          objectsCreated++;
        } catch (err) {
          console.error(
            `Failed to create object for node ${data.nodeId}:`,
            err
          );
        }
      }

      // ── Yield to the browser so the tab stays responsive ─────────────
      if (i + OBJECT_BATCH_SIZE < nodeEntries.length) {
        await new Promise(r => setTimeout(r, 0));
      }

      // ── Early-warning if the heap is running out during creation ────
      if (i % (OBJECT_BATCH_SIZE * 5) === 0) {
        reportMemoryPressureOnce('object creation');
      }

      // ── Flush accumulated objects to the store incrementally ────────
      //     This lets React / ObjectsRenderer start progressive mounting
      //     while more objects are still being built.  Every created object
      //     is pushed to the store (no loaded-cell cap) so all groups render
      //     during the scan; the earlier cap that only pushed objects whose
      //     cell was already loaded left services/utils/hooks etc. invisible.
      if (storeBatch.length >= STORE_FLUSH_SIZE ||
          i + OBJECT_BATCH_SIZE >= nodeEntries.length) {
        if (storeBatch.length > 0) {
          // Cell tracking (cheap) runs incrementally.  The store flush is
          // deferred to after the creation loop — the old pattern spread the
          // entire growing array on every flush, causing O(N²) copies.
          const byCell = new Map();
          for (const obj of storeBatch) {
            if (obj.cellId) {
              let cellObjs = byCell.get(obj.cellId);
              if (!cellObjs) { cellObjs = []; byCell.set(obj.cellId, cellObjs); }
              cellObjs.push(obj);
            }
          }
          for (const [cellId, objects] of byCell) {
            addToAllCellObjects(currentSpaceId, cellId, objects);
          }
          useSpatialManagerStore.getState().trackObjectsInCellBatch?.(
            storeBatch.map((obj) => ({ objectId: obj.id, cellId: obj.cellId }))
          );
          pendingAllObjects.push(...storeBatch);
          storeBatch = [];
        }
      }
    }

    // Cell tracking for any remaining batch (no store flush yet)
    if (storeBatch.length > 0) {
      const byCell = new Map();
      for (const obj of storeBatch) {
        if (obj.cellId) {
          let cellObjs = byCell.get(obj.cellId);
          if (!cellObjs) { cellObjs = []; byCell.set(obj.cellId, cellObjs); }
          cellObjs.push(obj);
        }
      }
      for (const [cellId, objects] of byCell) {
        addToAllCellObjects(currentSpaceId, cellId, objects);
      }
      useSpatialManagerStore.getState().trackObjectsInCellBatch?.(
        storeBatch.map((obj) => ({ objectId: obj.id, cellId: obj.cellId }))
      );
      pendingAllObjects.push(...storeBatch);
      storeBatch = [];
    }

    // Single O(N) store flush — one array copy for all N created objects
    // instead of ~N/1000 copies that previously accumulated to O(N²).
    if (pendingAllObjects.length > 0) {
      const currentObjects = useObjectsStore.getState().objects;
      const updated = [...currentObjects, ...pendingAllObjects];
      useObjectsStore.getState().setObjects(updated);
    }

    // ── Apply position updates in a single pass ──────────────────────
    if (positionUpdates.size > 0) {
      const currentObjects = useObjectsStore.getState().objects;
      for (let i = 0; i < currentObjects.length; i++) {
        const obj = currentObjects[i];
        if (positionUpdates.has(obj.id)) {
          currentObjects[i] = { ...obj, position: positionUpdates.get(obj.id) };
        }
      }
      useObjectsStore.getState().setObjects(currentObjects);

      // Persist position updates for existing objects that were repositioned
      for (const [objId, newPos] of positionUpdates) {
        const updated = currentObjects.find(o => o.id === objId);
        if (updated) {
          allObjectsToSave.push({
            ...updated,
            position: newPos,
          });
        }
      }

      await new Promise(r => setTimeout(r, 0));
    }

    // ── Defer container creation to let React start mounting core objects ─
    //     Progressive mounting in ObjectsRenderer will already be rendering
    //     the first STORE_FLUSH_SIZE objects while containers are built here.
    await new Promise(r => setTimeout(r, 0));

    // Calculate container dimensions for component child groupings
    const containerDimensions = this.calculateContainerDimensions(
      parentChildMap,
      childParentMap,
      graph.nodes,
      nodePositions,
      nodeScales,
      internalComponentChildren
    );

    // These are already async and call setObjects() internally, so they
    // naturally yield to the event loop between each step.
    await this.createContainerCubesAtPositions(
      containerDimensions,
      graph.nodes,
      allObjectsToSave,
      currentSpaceId
    );

    await new Promise(r => setTimeout(r, 0));
    await this.createGroupContainers(context, allObjectsToSave);
    await new Promise(r => setTimeout(r, 0));
    await this.createBoundaryContainers(context, allObjectsToSave);
    await new Promise(r => setTimeout(r, 0));
    await this.createRootHierarchyContainer(context, allObjectsToSave);

    return objectsCreated;
  },
};
