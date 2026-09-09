import {
  NODE_TYPE_COMPONENT,
  NODE_TYPE_FUNCTION,
  NODE_TYPE_HOOK,
  NODE_TYPE_SERVICE,
  NODE_TYPE_STORE,
  NODE_TYPE_DATAPATH,
  NODE_TYPE_LIBRARY,
  NODE_TYPE_MODULE,
  NODE_TYPE_PERSON,
  NODE_TYPE_BOUNDARY,
  NODE_TYPE_JUNCTION,
  OBJECT_TYPE_DODECAHEDRON,
  OBJECT_TYPE_OCTAHEDRON,
  DEFAULT_CONTAINER_SIZE,
  BASE_DODECAHEDRON_RADIUS,
  JUNCTION_MARKER_SCALE,
} from './constants.js';

export const positionMethods = {
  /**
   * Calculate position for a node in the hierarchy
   */
  calculateNodePosition(
    nodeId,
    basePosition,
    level,
    siblingIndex,
    siblingCount,
    parentPosition,
    containerSize,
    rootNodes,
    graphNodes,
    parentChildMap,
    internalComponentChildren,
    siblingIds = []
  ) {
    const node = graphNodes.get(nodeId);
    const nodeType = node ? node.type : 'unknown';

    const componentYOffset = 0;

    if (level === 0) {
      const rootArray = Array.from(rootNodes);
      const rootIndex = rootArray.indexOf(nodeId);

      if (rootArray.length === 1) {
        return [
          basePosition[0],
          basePosition[1] + componentYOffset,
          basePosition[2],
        ];
      } else {
        const gridSize = Math.ceil(Math.sqrt(rootArray.length));
        const row = Math.floor(rootIndex / gridSize);
        const col = rootIndex % gridSize;

        const spacing = 250;

        return [
          basePosition[0] + (col - (gridSize - 1) / 2) * spacing,
          basePosition[1] + componentYOffset,
          basePosition[2] + (row - (gridSize - 1) / 2) * spacing,
        ];
      }
    } else {
      const isInternalComponent =
        nodeType === 'component' && internalComponentChildren.has(nodeId);

      const objectType = this.getObjectTypeForNode(node, isInternalComponent);
    const isOctahedron = objectType === OBJECT_TYPE_OCTAHEDRON;

    if (isOctahedron) {
      const parentRadius = containerSize / 2;
      const octahedronRadius = 10;
      const gap = 30;

      const internalSiblings = siblingIds.filter((sibId) => {
        const sibNode = graphNodes.get(sibId);
        return sibNode && sibNode.type === 'component' && internalComponentChildren.has(sibId);
      });

      const octaSiblingIndex = internalSiblings.indexOf(nodeId);
      const side = octaSiblingIndex % 2 === 0 ? -1 : 1;
      const offsetX = side * (parentRadius + octahedronRadius + gap);
      const extraOffset = Math.floor(octaSiblingIndex / 2) * (octahedronRadius * 2 + gap) * side;

      return [
        parentPosition[0] + offsetX + extraOffset,
        parentPosition[1],
        parentPosition[2],
      ];
    }

    if (nodeType === 'component' && !isInternalComponent) {
        const baseDodecahedronRadius = 10;

        const componentScale = this.calculateDodecahedronScale(
          nodeId,
          parentChildMap,
          graphNodes,
          internalComponentChildren,
          level
        );
        const actualComponentSize =
          baseDodecahedronRadius * Math.max(...componentScale.nodeScale);

        const externalComponentSiblings = siblingIds.filter((sibId) => {
          const sibNode = graphNodes.get(sibId);
          return sibNode && sibNode.type === 'component' && !internalComponentChildren.has(sibId);
        });

        const componentSiblingIndex = externalComponentSiblings.indexOf(nodeId);
        const componentSiblingCount = externalComponentSiblings.length;

        // Collect each sibling's actual dodecahedron radius so we can pack
        // tightly when siblings are unequal in size. Cell spacing must be
        // wide enough that the two LARGEST radii fit edge-to-edge with a
        // gap — not 2*max which over-pads when sizes are unequal (e.g. App
        // radius ≈ 378 vs LandingApp radius ≈ 50).
        const siblingSizes = externalComponentSiblings.map((sibId) => {
          if (sibId === nodeId) return actualComponentSize;
          const sibScale = this.calculateDodecahedronScale(
            sibId,
            parentChildMap,
            graphNodes,
            internalComponentChildren,
            level
          );
          return baseDodecahedronRadius * Math.max(...sibScale.nodeScale);
        });
        const sortedSizesDesc = [...siblingSizes].sort((a, b) => b - a);
        const largestSize = sortedSizesDesc[0] || actualComponentSize;
        const secondLargestSize = sortedSizesDesc[1] !== undefined
          ? sortedSizesDesc[1]
          : largestSize;
        const maxSiblingSize = largestSize;

        const levelFactor = level <= 2 ? 0.15 : 0.3;
        const baseMinGap = level <= 2 ? 30 : 20;
        const proportionalGap = maxSiblingSize * 0.5 * levelFactor;
        const gapBetweenEdges = Math.max(baseMinGap, proportionalGap);

        // Spacing = sum of two largest radii + gap. This is the minimum
        // center-to-center distance that prevents the two biggest siblings
        // from overlapping, with no wasted padding when sizes are unequal.
        let spacingBetweenComponents =
          largestSize + secondLargestSize + gapBetweenEdges;

        // Subtree-aware widening (dampened): subtrees can be wide, but we
        // don't need full horizontal clearance because subtrees sit at a
        // LOWER y-level than their parent siblings. We allow horizontal
        // overlap of subtree branches and rely on increased depthOffset
        // (below) to separate them vertically instead.
        //
        // SUBTREE_DAMPING < 1 lets App and LandingApp sit much closer to
        // AppShell while still preventing their dodecahedron hulls from
        // overlapping (the largestSize+secondLargestSize floor above
        // guarantees that). Tune this single number to trade horizontal
        // spacing for visual subtree overlap.
        const SUBTREE_DAMPING = 0.15;
        if (componentSiblingCount > 1) {
          const halfWidths = externalComponentSiblings.map((sibId, i) =>
            this.estimateSubtreeHalfWidth(
              sibId,
              parentChildMap,
              graphNodes,
              internalComponentChildren,
              level,
              siblingSizes[i]
            )
          );
          const sortedHalvesDesc = [...halfWidths].sort((a, b) => b - a);
          const largestHalf = sortedHalvesDesc[0];
          const secondLargestHalf = sortedHalvesDesc[1] !== undefined
            ? sortedHalvesDesc[1]
            : largestHalf;
          const dampedRequired =
            SUBTREE_DAMPING * (largestHalf + secondLargestHalf) +
            gapBetweenEdges;
          if (dampedRequired > spacingBetweenComponents) {
            spacingBetweenComponents = dampedRequired;
          }
        }

        // Push subtrees further DOWN vertically. This is "vertical is fine"
        // — subtrees of adjacent siblings won't visually collide because
        // they live at noticeably different y-levels.
        let depthOffset = 500;
        if (containerSize && typeof containerSize === 'number') {
          depthOffset = Math.max(500, 500 * Math.log2(containerSize / 25 + 1));
        }

        if (nodeId === 'TextStyleUI' || nodeId === 'ObjectUI' || nodeId === 'TetrahedronFace' || nodeId === 'TextSprite') {
          console.log(`📐 ${nodeId} spacing: maxSiblingSize=${maxSiblingSize.toFixed(1)}, level=${level}, spacing=${spacingBetweenComponents.toFixed(1)}, siblingCount=${componentSiblingCount}, siblingIndex=${componentSiblingIndex}, depthOffset=${depthOffset.toFixed(1)}`);
        }

        if (componentSiblingCount <= 1) {
          const totalSpacing = spacingBetweenComponents;
          const position = [
            parentPosition[0] + totalSpacing,
            parentPosition[1] - depthOffset,
            parentPosition[2],
          ];
          return position;
        } else {
          const gridSize = Math.ceil(Math.sqrt(componentSiblingCount));
          const row = Math.floor(componentSiblingIndex / gridSize);
          const col = componentSiblingIndex % gridSize;

          const offsetX = (col - (gridSize - 1) / 2) * spacingBetweenComponents;
          const offsetZ = (row - (gridSize - 1) / 2) * spacingBetweenComponents;

          const position = [
            parentPosition[0] + offsetX,
            parentPosition[1] - depthOffset,
            parentPosition[2] + offsetZ,
          ];

          if (nodeId === 'TextStyleUI' || nodeId === 'ObjectUI' || nodeId === 'TetrahedronFace' || nodeId === 'TextSprite') {
            console.log(`📍 ${nodeId} position: [${position.map(p => p.toFixed(1)).join(', ')}], parent: [${parentPosition.map(p => p.toFixed(1)).join(', ')}]`);
          }

          return position;
        }
      } else {
        if (siblingCount === 1) {
          return [...parentPosition];
        } else {
          const gridSize = Math.ceil(Math.pow(siblingCount, 1 / 3));
          const layer = Math.floor(siblingIndex / (gridSize * gridSize));
          const remaining = siblingIndex % (gridSize * gridSize);
          const row = Math.floor(remaining / gridSize);
          const col = remaining % gridSize;

          const spacing = 50;

          return [
            parentPosition[0] + (col - (gridSize - 1) / 2) * spacing,
            parentPosition[1] + (row - (gridSize - 1) / 2) * spacing,
            parentPosition[2] + (layer - (gridSize - 1) / 2) * spacing,
          ];
        }
      }
    }
  },

  /**
   * Estimate the rendered half-width of a component's subtree by recursively
   * mirroring the per-level spacing formula used in calculateNodePosition.
   *
   * Uses the actual dodecahedron radius (not the inflated `containerSize`
   * from calculateDodecahedronScale) so the estimate matches what's drawn.
   * Cached per (nodeId, level).
   */
  estimateSubtreeHalfWidth(
    nodeId,
    parentChildMap,
    graphNodes,
    internalComponentChildren,
    level,
    ownRadiusOverride
  ) {
    if (!this._subtreeHalfWidthCache) {
      this._subtreeHalfWidthCache = new Map();
    }
    const cacheKey = `${nodeId}-${level}`;
    if (this._subtreeHalfWidthCache.has(cacheKey)) {
      return this._subtreeHalfWidthCache.get(cacheKey);
    }
    if (level > 10) return 15;

    // Own dodecahedron radius — use the actual scaled radius if provided
    // (this is the rendered size of the dodecahedron itself).
    let OWN_HALF;
    if (typeof ownRadiusOverride === 'number') {
      OWN_HALF = ownRadiusOverride;
    } else {
      const scale = this.calculateDodecahedronScale(
        nodeId,
        parentChildMap,
        graphNodes,
        internalComponentChildren,
        level
      );
      OWN_HALF = 10 * Math.max(...scale.nodeScale);
    }

    const children = parentChildMap.get(nodeId) || new Set();
    const externalChildren = Array.from(children).filter((cid) => {
      const c = graphNodes.get(cid);
      return (
        c &&
        c.type === 'component' &&
        !(internalComponentChildren && internalComponentChildren.has(cid))
      );
    });

    if (externalChildren.length === 0) {
      this._subtreeHalfWidthCache.set(cacheKey, OWN_HALF);
      return OWN_HALF;
    }

    const childLevel = level + 1;

    // Recursive child subtree half-widths (mirrors the main-path formula).
    const childHalfWidths = externalChildren.map((cid) =>
      this.estimateSubtreeHalfWidth(
        cid,
        parentChildMap,
        graphNodes,
        internalComponentChildren,
        childLevel
      )
    );
    const sortedDesc = [...childHalfWidths].sort((a, b) => b - a);
    const largestHalf = sortedDesc[0];
    const secondLargestHalf = sortedDesc[1] !== undefined
      ? sortedDesc[1]
      : largestHalf;

    // Same per-level gap formula used in calculateNodePosition.
    const levelFactor = childLevel <= 2 ? 0.15 : 0.3;
    const baseMinGap = childLevel <= 2 ? 30 : 20;
    const proportionalGap = largestHalf * 0.5 * levelFactor;
    const gapBetweenEdges = Math.max(baseMinGap, proportionalGap);

    // Cell spacing: two largest subtree "radii" + gap (matches main path).
    const cellSpacing = largestHalf + secondLargestHalf + gapBetweenEdges;

    const gridSize = Math.ceil(Math.sqrt(externalChildren.length));
    const halfWidth =
      ((gridSize - 1) / 2) * cellSpacing + largestHalf;

    const result = Math.min(Math.max(OWN_HALF, halfWidth), 5000);
    this._subtreeHalfWidthCache.set(cacheKey, result);
    return result;
  },

  /**
   * Get corner positions for small groups (up to 8 objects)
   */
  getCornerPositions(radius) {
    return [
      [-radius, -radius, -radius],
      [radius, -radius, -radius],
      [-radius, radius, -radius],
      [radius, radius, -radius],
      [-radius, -radius, radius],
      [radius, -radius, radius],
      [-radius, radius, radius],
      [radius, radius, radius],
    ];
  },

  /**
   * Process hierarchical node positioning
   */
  positionNodeHierarchy(
    nodeId,
    context,
    parentPosition,
    level = 0,
    siblingIndex = 0,
    siblingCount = 1,
    parentContainerSize = 50
  ) {
    const {
      parentChildMap,
      childParentMap,
      graphNodes,
      rootNodes,
      basePosition,
      nodePositions,
      nodeScales,
      processedNodes,
    } = context;

    if (processedNodes.has(nodeId)) return;

    const node = graphNodes.get(nodeId);
    if (!node) return;

    processedNodes.add(nodeId);

    if (node.type === NODE_TYPE_DATAPATH) {
      return;
    }

    const nodeType = (node.type || '').toLowerCase().trim();
    const isTopLevel = !childParentMap.has(nodeId);

    if (
      context.internalComponentChildren &&
      context.internalComponentChildren.has(nodeId) &&
      isTopLevel
    ) {
      console.log(
        `   ⏭️ SKIPPING root-level internal component: ${nodeId} (should only appear inside parent)`
      );
      return;
    }

    // Top-level STORE/SERVICE/HOOK/MODULE/LIBRARY that have no parent are handled
    // by positionGroupedNodes — skip them here. But if they have a parent (i.e. they
    // are children of a COMPONENT), we must still position them and recurse into
    // their own children.
    const isGroupedType =
      nodeType === NODE_TYPE_SERVICE ||
      nodeType === NODE_TYPE_STORE ||
      nodeType === NODE_TYPE_HOOK ||
      nodeType === NODE_TYPE_LIBRARY ||
      nodeType === NODE_TYPE_MODULE;

    if (isGroupedType && isTopLevel) {
      return;
    }

    if (
      (nodeType === NODE_TYPE_FUNCTION || nodeType === NODE_TYPE_HOOK) &&
      isTopLevel
    ) {
      return;
    }

    const objectType = this.getObjectTypeForNode(node);
    // Boundaries produce no object of their own but still occupy a root grid
    // slot and recurse into their members — so let them through here.
    if (!objectType && nodeType !== NODE_TYPE_BOUNDARY) return;

    let nodeScale = [1, 1, 1];
    let containerSize = DEFAULT_CONTAINER_SIZE;

    if (nodeType === NODE_TYPE_JUNCTION) {
      // Junctions are tiny markers — renderpoint scale handled in objectMethods.
      nodeScale = [JUNCTION_MARKER_SCALE, JUNCTION_MARKER_SCALE, JUNCTION_MARKER_SCALE];
    } else if (objectType === OBJECT_TYPE_DODECAHEDRON) {
      const scaleResult = this.calculateDodecahedronScale(
        nodeId,
        parentChildMap,
        graphNodes,
        context?.internalComponentChildren || new Set(),
        level
      );
      nodeScale = scaleResult.nodeScale;
      containerSize = scaleResult.containerSize;
    }

    const parentId = context.childParentMap.get(nodeId);
    let siblingIds = [];
    if (parentId && parentId !== nodeId) {
      const allParentChildren = Array.from(parentChildMap.get(parentId) || new Set());
      siblingIds = allParentChildren.filter((sibId) => {
        const sibNode = graphNodes.get(sibId);
        const isComponent = sibNode && sibNode.type === 'component';
        const hasSameParent = context.childParentMap.get(sibId) === parentId;
        return isComponent && hasSameParent;
      }).sort();

      const groupKey = siblingIds.join(',');
      if (!this._loggedGroups) this._loggedGroups = new Set();
      if (siblingIds.length > 0 && !this._loggedGroups.has(groupKey)) {
        this._loggedGroups.add(groupKey);
        console.log(`👥 Sibling group at level ${level}: [${siblingIds.join(', ')}]`);
      }
    }

    const nodePosition = this.calculateNodePosition(
      nodeId,
      basePosition,
      level,
      siblingIndex,
      siblingCount,
      parentPosition,
      parentContainerSize,
      rootNodes,
      graphNodes,
      parentChildMap,
      context?.internalComponentChildren || new Set(),
      siblingIds
    );

    nodePositions.set(nodeId, nodePosition);
    nodeScales.set(nodeId, nodeScale);

    const children = parentChildMap.get(nodeId) || new Set();
    if (children.size > 0) {
      const childArray = Array.from(children).sort();

      childArray.forEach((childId, index) => {
        this.positionNodeHierarchy(
          childId,
          context,
          nodePosition,
          level + 1,
          index,
          childArray.length,
          containerSize
        );
      });
    }
  },

  /**
   * Resolve collisions between CONTAINER CUBES and grouped-node clusters.
   *
   * Virtual containers are now discovered dynamically from
   * `context.discoveredGroups` (populated by positionGroupedNodes) so any new
   * node type automatically participates in collision resolution.
   */
  resolveCollisions(context) {
    const {
      parentChildMap,
      graphNodes,
      nodePositions,
      internalComponentChildren,
      ungroupedComponents = [],
    } = context;

    // ── helpers ───────────────────────────────────────────────────────────

    const moveComponentTree = (nodeId, offsetX, offsetZ, visited = new Set()) => {
      if (visited.has(nodeId)) return;
      visited.add(nodeId);

      const position = nodePositions.get(nodeId);
      if (!position) return;

      nodePositions.set(nodeId, [
        position[0] + offsetX,
        position[1],
        position[2] + offsetZ,
      ]);

      const children = parentChildMap.get(nodeId);
      if (children) {
        for (const childId of children) {
          moveComponentTree(childId, offsetX, offsetZ, visited);
        }
      }
    };

    const getComponentChildren = (nodeId) => {
      const children = parentChildMap.get(nodeId);
      if (!children) return [];

      return Array.from(children).filter((childId) => {
        if (internalComponentChildren && internalComponentChildren.has(childId)) return false;
        const childNode = graphNodes.get(childId);
        return childNode && childNode.type === NODE_TYPE_COMPONENT;
      });
    };

    const checkOverlap = (bbox1, bbox2) => {
      return !(
        bbox1.maxX < bbox2.minX ||
        bbox1.minX > bbox2.maxX ||
        bbox1.maxZ < bbox2.minZ ||
        bbox1.minZ > bbox2.maxZ
      );
    };

    // ── 1. Component-hierarchy containers (unchanged) ─────────────────────

    const containerParents = [];

    for (const [nodeId, node] of graphNodes.entries()) {
      if (node.type !== NODE_TYPE_COMPONENT) continue;
      if (internalComponentChildren && internalComponentChildren.has(nodeId)) continue;
      if (!nodePositions.has(nodeId)) continue;

      if (getComponentChildren(nodeId).length >= 2) {
        containerParents.push(nodeId);
      }
    }

    // ── 2. Build virtual containers from dynamic groups ───────────────────

    const containersByLevel = new Map();

    for (const containerId of containerParents) {
      let level = 0;
      let currentId = containerId;

      while (context.childParentMap.has(currentId)) {
        level++;
        currentId = context.childParentMap.get(currentId);
        if (level > 20) break;
      }

      // Resolve overlaps at the top two hierarchy levels only.
      //   level 0: root containers (e.g. AppShell) vs other root containers / groups
      //   level 1: siblings under a single root (e.g. App vs LandingApp), where
      //            each sibling's full child-grid extent is captured by its
      //            immediate-children bbox.
      // Deeper levels are intentionally excluded to avoid cascading shifts
      // (each level's bbox depends on the previous level's positions).
      if (level <= 1) {
        if (!containersByLevel.has(level)) containersByLevel.set(level, []);
        containersByLevel.get(level).push(containerId);
      }
    }

    if (!containersByLevel.has(-1)) containersByLevel.set(-1, []);

    if (ungroupedComponents.length > 0) {
      containersByLevel.get(-1).push('__UNGROUPED__');
    }

    // Read dynamically-discovered groups set by positionGroupedNodes
    const discoveredGroups = context.discoveredGroups || new Map();
    for (const [groupKey, nodes] of discoveredGroups) {
      if (nodes.length > 0) {
        containersByLevel.get(-1).push(`__GROUP_${groupKey}__`);
      }
    }

    // ── 3. Build bounding boxes ───────────────────────────────────────────

    const levels = Array.from(containersByLevel.keys()).sort((a, b) => b - a);

    for (const level of levels) {
      const containers = containersByLevel.get(level);
      if (containers.length < 2) continue;

      const containerBBoxes = [];

      for (const containerId of containers) {
        let minX = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxZ = -Infinity;

        let nodeList = null;

        if (containerId === '__UNGROUPED__') {
          nodeList = ungroupedComponents;
        } else if (containerId.startsWith('__GROUP_')) {
          const groupKey = containerId.slice(8, -2); // extract key from __GROUP_xxx__
          nodeList = discoveredGroups.get(groupKey) || [];
        }

        if (nodeList) {
          for (const nodeId of nodeList) {
            const pos = nodePositions.get(nodeId);
            if (!pos) continue;

            const nodeScale = context.nodeScales?.get(nodeId) || [1, 1, 1];
            const nodeSize = BASE_DODECAHEDRON_RADIUS * Math.max(...nodeScale);

            minX = Math.min(minX, pos[0] - nodeSize);
            maxX = Math.max(maxX, pos[0] + nodeSize);
            minZ = Math.min(minZ, pos[2] - nodeSize);
            maxZ = Math.max(maxZ, pos[2] + nodeSize);
          }
        } else {
          // Use the full subtree extent (all descendants, not just direct children)
          // so that large child grids are accounted for in the bounding box.
          const componentChildren = getComponentChildren(containerId);
          if (componentChildren.length < 2) continue;

          const collectAllDescendants = (id, visited) => {
            const kids = parentChildMap.get(id);
            if (!kids) return;
            for (const kid of kids) {
              if (visited.has(kid)) continue;
              visited.add(kid);
              collectAllDescendants(kid, visited);
            }
          };

          const allDescendants = new Set();
          collectAllDescendants(containerId, allDescendants);

          for (const descId of allDescendants) {
            const descPos = nodePositions.get(descId);
            if (!descPos) continue;

            const descScale = context.nodeScales?.get(descId) || [1, 1, 1];
            const descSize = BASE_DODECAHEDRON_RADIUS * Math.max(...descScale);

            minX = Math.min(minX, descPos[0] - descSize);
            maxX = Math.max(maxX, descPos[0] + descSize);
            minZ = Math.min(minZ, descPos[2] - descSize);
            maxZ = Math.max(maxZ, descPos[2] + descSize);
          }
        }

        if (minX === Infinity || maxX === -Infinity) continue;

        const padding = 120;
        minX -= padding; maxX += padding;
        minZ -= padding; maxZ += padding;

        containerBBoxes.push({
          nodeId: containerId,
          minX, maxX, minZ, maxZ,
          width: maxX - minX,
          height: maxZ - minZ,
        });
      }

      // ── 4. Pairwise overlap resolution ──────────────────────────────────

      const resolveNodeMove = (bbox, offsetX, offsetZ) => {
        if (bbox.nodeId === '__UNGROUPED__') {
          for (const nId of ungroupedComponents) moveComponentTree(nId, offsetX, offsetZ);
        } else if (bbox.nodeId.startsWith('__GROUP_')) {
          const groupKey = bbox.nodeId.slice(8, -2);
          const nodes = discoveredGroups.get(groupKey) || [];
          for (const nId of nodes) moveComponentTree(nId, offsetX, offsetZ);
        } else {
          moveComponentTree(bbox.nodeId, offsetX, offsetZ);
        }
      };

      for (let i = 0; i < containerBBoxes.length; i++) {
        for (let j = i + 1; j < containerBBoxes.length; j++) {
          const bbox1 = containerBBoxes[i];
          const bbox2 = containerBBoxes[j];

          if (!checkOverlap(bbox1, bbox2)) continue;

          const overlapX =
            Math.min(bbox1.maxX, bbox2.maxX) - Math.max(bbox1.minX, bbox2.minX);
          const overlapZ =
            Math.min(bbox1.maxZ, bbox2.maxZ) - Math.max(bbox1.minZ, bbox2.minZ);

          if (overlapX < 1 && overlapZ < 1) continue;

          const center1X = (bbox1.minX + bbox1.maxX) / 2;
          const center1Z = (bbox1.minZ + bbox1.maxZ) / 2;
          const center2X = (bbox2.minX + bbox2.maxX) / 2;
          const center2Z = (bbox2.minZ + bbox2.maxZ) / 2;

          const minGap = 150;

          if (overlapX < overlapZ) {
            const direction = center2X > center1X ? 1 : -1;
            const requiredDistance = bbox1.width / 2 + bbox2.width / 2 + minGap;
            const moveDistance = requiredDistance - Math.abs(center2X - center1X);

            if (moveDistance > 0) {
              const offsetX = direction * Math.min(moveDistance, 2000);
              resolveNodeMove(bbox2, offsetX, 0);
              bbox2.minX += offsetX;
              bbox2.maxX += offsetX;
            }
          } else {
            const direction = center2Z > center1Z ? 1 : -1;
            const requiredDistance = bbox1.height / 2 + bbox2.height / 2 + minGap;
            const moveDistance = requiredDistance - Math.abs(center2Z - center1Z);

            if (moveDistance > 0) {
              const offsetZ = direction * Math.min(moveDistance, 2000);
              resolveNodeMove(bbox2, 0, offsetZ);
              bbox2.minZ += offsetZ;
              bbox2.maxZ += offsetZ;
            }
          }
        }
      }
    }
  },

  /**
   * Calculate the bounding box and dimensions of the root hierarchy container
   */
  calculateRootHierarchyContainerBounds(
    context,
    graphNodes,
    childParentMap,
    nodePositions,
    nodeScales,
    rootNodes
  ) {
    const hierarchyNodes = [];

    const reachableFromRootModules = new Set();
    const rootModuleNames = ['main', 'index', 'firebase', 'App'];
    const actualRootModules = Array.from(rootNodes).filter((nodeId) => {
      return rootModuleNames.includes(nodeId) || nodeId.endsWith('_root');
    });

    const markReachable = (nodeId) => {
      if (reachableFromRootModules.has(nodeId)) return;
      const node = graphNodes.get(nodeId);
      if (!node) return;
      if (node.type !== NODE_TYPE_DATAPATH) {
        reachableFromRootModules.add(nodeId);
      }
      const children = context.parentChildMap.get(nodeId) || new Set();
      children.forEach((childId) => markReachable(childId));
    };

    actualRootModules.forEach((rootModuleId) => {
      markReachable(rootModuleId);
    });

    // Store the reachable set on context so positionGroupedNodes can identify
    // orphan root components that were positioned at Y=0 but aren't in the
    // reachable hierarchy — they belong in the Unused Components container.
    if (context) context.hierarchyReachableNodes = reachableFromRootModules;

    for (const [nodeId, position] of nodePositions.entries()) {
      if (!position) continue;

      const node = graphNodes.get(nodeId);
      if (!node) continue;

      const nodeType = (node.type || '').toLowerCase().trim();

      if (nodeType === NODE_TYPE_COMPONENT && reachableFromRootModules.has(nodeId)) {
        hierarchyNodes.push(nodeId);
      }
    }

    if (hierarchyNodes.length === 0) {
      console.log('⚠️ No named-entry-point hierarchy nodes found — scanning all positioned components for orbit center');
      // Fallback: compute the actual bounding box of every positioned component
      // so the orbit circle centres on the real component tree, regardless of
      // what the root component files are called.
      let fbMinX = Infinity, fbMaxX = -Infinity;
      let fbMinY = Infinity, fbMaxY = -Infinity;
      let fbMinZ = Infinity, fbMaxZ = -Infinity;

      for (const [nodeId, position] of nodePositions.entries()) {
        if (!position) continue;
        const node = graphNodes.get(nodeId);
        if (!node || (node.type || '').toLowerCase().trim() !== NODE_TYPE_COMPONENT) continue;
        const scale = nodeScales.get(nodeId) || [1, 1, 1];
        const nodeSize = Math.max(...scale) * 10;
        fbMinX = Math.min(fbMinX, position[0] - nodeSize);
        fbMaxX = Math.max(fbMaxX, position[0] + nodeSize);
        fbMinY = Math.min(fbMinY, position[1] - nodeSize);
        fbMaxY = Math.max(fbMaxY, position[1] + nodeSize);
        fbMinZ = Math.min(fbMinZ, position[2] - nodeSize);
        fbMaxZ = Math.max(fbMaxZ, position[2] + nodeSize);
      }

      if (Number.isFinite(fbMinX)) {
        const p = 15;
        fbMinX -= p; fbMaxX += p;
        fbMinY -= p; fbMaxY += p;
        fbMinZ -= p; fbMaxZ += p;
        return {
          centerX: (fbMinX + fbMaxX) / 2,
          centerY: (fbMinY + fbMaxY) / 2,
          centerZ: (fbMinZ + fbMaxZ) / 2,
          width: fbMaxX - fbMinX,
          height: fbMaxY - fbMinY,
          depth: fbMaxZ - fbMinZ,
          minX: fbMinX, maxX: fbMaxX,
          minY: fbMinY, maxY: fbMaxY,
          minZ: fbMinZ, maxZ: fbMaxZ,
        };
      }

      // Absolute last resort — no components positioned at all; use basePosition
      const bp = context.basePosition;
      return {
        centerX: bp[0], centerY: bp[1], centerZ: bp[2],
        width: 100, height: 100, depth: 100,
        minX: bp[0] - 50, maxX: bp[0] + 50,
        minY: bp[1] - 50, maxY: bp[1] + 50,
        minZ: bp[2] - 50, maxZ: bp[2] + 50,
      };
    }

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;

    hierarchyNodes.forEach((nodeId) => {
      const pos = nodePositions.get(nodeId);
      if (!pos) return;

      const scale = nodeScales.get(nodeId) || [1, 1, 1];
      const node = graphNodes.get(nodeId);
      const nodeType = node ? (node.type || '').toLowerCase().trim() : '';

      let nodeSize = 5;
      if (nodeType === NODE_TYPE_COMPONENT) {
        nodeSize = Math.max(...scale) * 10;
      }

      minX = Math.min(minX, pos[0] - nodeSize);
      maxX = Math.max(maxX, pos[0] + nodeSize);
      minY = Math.min(minY, pos[1] - nodeSize);
      maxY = Math.max(maxY, pos[1] + nodeSize);
      minZ = Math.min(minZ, pos[2] - nodeSize);
      maxZ = Math.max(maxZ, pos[2] + nodeSize);
    });

    const padding = 15;
    minX -= padding; maxX += padding;
    minY -= padding; maxY += padding;
    minZ -= padding; maxZ += padding;

    return {
      centerX: (minX + maxX) / 2,
      centerY: (minY + maxY) / 2,
      centerZ: (minZ + maxZ) / 2,
      width: maxX - minX,
      height: maxY - minY,
      depth: maxZ - minZ,
      minX, maxX, minY, maxY, minZ, maxZ
    };
  },

  /**
   * Position grouped nodes (utilities, services, stores, hooks, workers, etc.)
   * in square grids arranged around the root component hierarchy.
   *
   * Groups are discovered dynamically from the node types present in the graph
   * rather than being hard-coded, so any new folder / node type automatically
   * gets its own positioned group and container.
   */
  positionGroupedNodes(context) {
    const {
      graphNodes,
      childParentMap,
      nodePositions,
      nodeScales,
      basePosition,
      rootNodes,
      internalComponentChildren,
    } = context;

    // ── 1. Dynamic group discovery ────────────────────────────────────────
    const groupedByType = new Map(); // groupKey → [nodeId, …]
    const ungroupedComponents = [];

    for (const [nodeId, node] of graphNodes.entries()) {
      // Skip nodes that are children of another node
      if (childParentMap.has(nodeId)) continue;

      const nodeType = (node.type || '').toLowerCase().trim();

      // Components are handled by hierarchy or collected as ungrouped
      if (nodeType === NODE_TYPE_COMPONENT) {
        if (
          nodeId !== 'MainEntry' &&
          !(internalComponentChildren && internalComponentChildren.has(nodeId)) &&
          !nodePositions.has(nodeId)
        ) {
          ungroupedComponents.push(nodeId);
        }
        continue;
      }

      // Datapaths don't produce 3D objects
      if (nodeType === NODE_TYPE_DATAPATH) continue;

      // People, boundaries and junctions are not type-grouped — people keep
      // their positionNodeHierarchy root-grid slot, boundaries become
      // boundary containers, junctions are markers.
      if (
        nodeType === NODE_TYPE_PERSON ||
        nodeType === NODE_TYPE_BOUNDARY ||
        nodeType === NODE_TYPE_JUNCTION
      ) {
        continue;
      }

      // Determine group key — preserve backend/worker/shader splitting
      let groupKey = nodeType;
      if (nodeType === NODE_TYPE_SERVICE && nodeId.startsWith('backend_')) {
        groupKey = 'backend';
      } else if (nodeType === NODE_TYPE_FUNCTION && nodeId.startsWith('worker_')) {
        groupKey = 'worker';
      } else if (nodeType === NODE_TYPE_FUNCTION && nodeId.startsWith('shader_')) {
        groupKey = 'shader';
      }

      if (!groupedByType.has(groupKey)) {
        groupedByType.set(groupKey, []);
      }
      groupedByType.get(groupKey).push(nodeId);
    }

    // ── 1b. Community-based grouping for ungrouped components ─────────────
    // If community assignments are available (from Louvain detection),
    // group ungrouped components by their community to create spatial clusters.
    const communityAssignments = context.communityAssignments || null;
    if (communityAssignments && ungroupedComponents.length >= 3) {
      const communityGroups = new Map(); // communityId → [nodeId, …]
      const orphanComponents = [];

      ungroupedComponents.forEach(nodeId => {
        const commId = communityAssignments.get(nodeId);
        if (commId !== undefined) {
          if (!communityGroups.has(commId)) communityGroups.set(commId, []);
          communityGroups.get(commId).push(nodeId);
        } else {
          orphanComponents.push(nodeId);
        }
      });

      // Only use community groups with 2+ members
      communityGroups.forEach((nodes, commId) => {
        if (nodes.length >= 2) {
          groupedByType.set(`community_${commId}`, nodes);
        } else {
          orphanComponents.push(nodes[0]);
        }
      });

      // Replace ungrouped list with only true orphans
      ungroupedComponents.length = 0;
      ungroupedComponents.push(...orphanComponents);
    }

    // ── 2. Unified scale calculation for all grouped nodes ────────────────
    const calculateNodeScaleFromChildren = (nodeId) => {
      const children = context.parentChildMap.get(nodeId) || new Set();
      if (children.size > 0) {
        const childCount = children.size;
        const gridSize3D = Math.ceil(Math.pow(childCount, 1 / 3));
        const childSize = 10;
        const spacing = 50;
        const requiredSpace = (gridSize3D - 1) * spacing + childSize * 2;
        const baseCubeSize = 20;
        const generousPadding = Math.max(30, childCount * 8);
        const totalRequiredSize = requiredSpace + generousPadding * 2;
        const minScaleFactor = Math.max(1.5, 1 + Math.sqrt(childCount) * 0.5);
        const calculatedScaleFactor = totalRequiredSize / baseCubeSize;
        const scaleFactor = Math.max(minScaleFactor, calculatedScaleFactor);
        nodeScales.set(nodeId, [scaleFactor, scaleFactor, scaleFactor]);
      } else {
        nodeScales.set(nodeId, [1, 1, 1]);
      }
    };

    for (const [, nodes] of groupedByType) {
      nodes.forEach(calculateNodeScaleFromChildren);
    }

    // ── 3. Layout helpers ─────────────────────────────────────────────────
    const calculateGroupSpacing = (nodes) => {
      let maxScale = 1;
      nodes.forEach((nodeId) => {
        const scale = nodeScales.get(nodeId);
        if (scale) {
          const nodeScale = Math.max(...scale);
          maxScale = Math.max(maxScale, nodeScale);
        }
      });
      const nodeHalfSize = maxScale * 5;
      const gap = 80;
      return Math.max(100, nodeHalfSize * 2 + gap);
    };

    const calculateGroupBounds = (nodes) => {
      if (nodes.length === 0) return { width: 0, height: 0, depth: 0 };

      const nodeSpacing = calculateGroupSpacing(nodes);
      const gridSize = Math.ceil(Math.sqrt(nodes.length));

      let minX = Infinity, maxX = -Infinity;
      let minY = Infinity, maxY = -Infinity;
      let minZ = Infinity, maxZ = -Infinity;

      nodes.forEach((nodeId, index) => {
        const row = Math.floor(index / gridSize);
        const col = index % gridSize;
        const x = col * nodeSpacing;
        const z = row * nodeSpacing;

        const scale = nodeScales.get(nodeId) || [1, 1, 1];
        const node = graphNodes.get(nodeId);
        const nType = node ? (node.type || '').toLowerCase().trim() : '';
        const nodeHalfSize = nType === NODE_TYPE_COMPONENT
          ? Math.max(...scale) * 10
          : Math.max(...scale) * 5;

        minX = Math.min(minX, x - nodeHalfSize);
        maxX = Math.max(maxX, x + nodeHalfSize);
        minY = Math.min(minY, -nodeHalfSize);
        maxY = Math.max(maxY, nodeHalfSize);
        minZ = Math.min(minZ, z - nodeHalfSize);
        maxZ = Math.max(maxZ, z + nodeHalfSize);
      });

      const padding = 15;
      return {
        width: (maxX - minX) + padding * 2,
        height: (maxY - minY) + padding * 2,
        depth: (maxZ - minZ) + padding * 2,
      };
    };

    const positionGroup = (nodes, xOffset, yOffset, zOffset) => {
      if (nodes.length === 0) return;
      const nodeSpacing = calculateGroupSpacing(nodes);
      const gridSize = Math.ceil(Math.sqrt(nodes.length));
      const numRows = Math.ceil(nodes.length / gridSize);

      // Center the grid around the offset point so (xOffset, zOffset)
      // is the group's centre, not its top-left corner.
      const gridWidth = (gridSize - 1) * nodeSpacing;
      const gridDepth = (numRows - 1) * nodeSpacing;
      const startX = xOffset - gridWidth / 2;
      const startZ = zOffset - gridDepth / 2;

      nodes.forEach((nodeId, index) => {
        const row = Math.floor(index / gridSize);
        const col = index % gridSize;
        const position = [
          basePosition[0] + startX + col * nodeSpacing,
          basePosition[1] + yOffset,
          basePosition[2] + startZ + row * nodeSpacing,
        ];
        nodePositions.set(nodeId, position);
        if (!nodeScales.has(nodeId)) {
          nodeScales.set(nodeId, [1, 1, 1]);
        }
      });
    };

    // ── 4. Root hierarchy bounds ──────────────────────────────────────────
    const rootHierarchyBounds = this.calculateRootHierarchyContainerBounds(
      context,
      graphNodes,
      childParentMap,
      nodePositions,
      nodeScales,
      rootNodes
    );

    const groupContainerYOffset = rootHierarchyBounds.centerY - basePosition[1];
    const ungroupedYOffset = (rootHierarchyBounds.maxY - basePosition[1]) + 100;
    const edgeSpacing = 100;

    // ── 5. Position discovered groups in a circle around root hierarchy ───
    const groupEntries = Array.from(groupedByType.entries())
      .filter(([, nodes]) => nodes.length > 0)
      .sort(([a], [b]) => a.localeCompare(b)); // deterministic ordering

    if (groupEntries.length > 0) {
      const rootWidth = rootHierarchyBounds.maxX - rootHierarchyBounds.minX;
      const rootDepth = rootHierarchyBounds.maxZ - rootHierarchyBounds.minZ;
      // Use the circumscribed-circle radius (half the diagonal) rather than
      // half the largest side, otherwise groups placed at diagonal angles
      // overlap the corners of the rectangular root hierarchy container.
      const rootRadius =
        Math.sqrt(rootWidth * rootWidth + rootDepth * rootDepth) / 2;
      const rootCenterXOffset = rootHierarchyBounds.centerX - basePosition[0];
      const rootCenterZOffset = rootHierarchyBounds.centerZ - basePosition[2];

      const angleStep = (2 * Math.PI) / groupEntries.length;

      // Pre-compute the bounding radius of each group using the diagonal so
      // a group's inward-facing corner is fully accounted for at any angle.
      const groupRadii = groupEntries.map(([, nodes]) => {
        const bounds = calculateGroupBounds(nodes);
        return (
          Math.sqrt(bounds.width * bounds.width + bounds.depth * bounds.depth) /
          2
        );
      });

      const maxGroupRadius = Math.max(...groupRadii, 0);
      const minGapBetweenGroups = 100;

      // Calculate the minimum circle radius so that:
      //  a) every group clears the root hierarchy
      //  b) adjacent groups on the circle don't overlap
      let minPlacementRadius = rootRadius + edgeSpacing + maxGroupRadius;

      if (groupEntries.length >= 2) {
        // For each pair of adjacent groups (including wrap-around),
        // 2R·sin(Δθ/2) must be ≥ r_i + r_{i+1} + gap
        const sinHalfAngle = Math.sin(angleStep / 2);
        if (sinHalfAngle > 0.001) {
          for (let i = 0; i < groupEntries.length; i++) {
            const j = (i + 1) % groupEntries.length;
            const requiredSeparation =
              groupRadii[i] + groupRadii[j] + minGapBetweenGroups;
            const requiredR = requiredSeparation / (2 * sinHalfAngle);
            minPlacementRadius = Math.max(minPlacementRadius, requiredR);
          }
        }
      }

      groupEntries.forEach(([, nodes], index) => {
        // Start from left side (−π) and distribute evenly
        const angle = -Math.PI + index * angleStep;
        const xOffset =
          Math.cos(angle) * minPlacementRadius + rootCenterXOffset;
        const zOffset =
          Math.sin(angle) * minPlacementRadius + rootCenterZOffset;

        positionGroup(nodes, xOffset, groupContainerYOffset, zOffset);
      });
    }

    // Store discovered groups on context so resolveCollisions can use them
    context.discoveredGroups = groupedByType;

    // ── 5b. Pass 2: orphan root components ────────────────────────────────
    // Root-level components that were positioned by positionNodeHierarchy at
    // Y = basePosition[1] but are NOT reachable from entry points AND have no
    // children of their own should be moved into the ungrouped set so they
    // (and their descendants, if any) are repositioned at the ungrouped Y
    // offset instead of sitting at the root hierarchy's Y level.
    const hierarchyReachable = context.hierarchyReachableNodes || new Set();
    for (const [nodeId, node] of graphNodes.entries()) {
      if (childParentMap.has(nodeId)) continue;        // not root-level
      if ((node.type || '').toLowerCase().trim() !== NODE_TYPE_COMPONENT) continue;
      if (nodeId === 'MainEntry') continue;
      if (internalComponentChildren?.has(nodeId)) continue;
      if (!nodePositions.has(nodeId)) continue;         // already in pass 1
      const children = context.parentChildMap?.get(nodeId);
      let hasComponentChildren = false;
      if (children) {
        for (const childId of children) {
          const childNode = graphNodes.get(childId);
          if (childNode && (childNode.type || '').toLowerCase().trim() === NODE_TYPE_COMPONENT) {
            hasComponentChildren = true;
            break;
          }
        }
      }
      if (hasComponentChildren) continue;
      if (!hierarchyReachable.has(nodeId)) {
        if (!ungroupedComponents.includes(nodeId)) {
          ungroupedComponents.push(nodeId);
        }
      }
    }

    // ── 6. Ungrouped components ───────────────────────────────────────────
    ungroupedComponents.forEach((componentId) => {
      const scaleResult = this.calculateDodecahedronScale(
        componentId,
        context.parentChildMap,
        graphNodes,
        context?.internalComponentChildren || new Set(),
        0
      );
      nodeScales.set(componentId, scaleResult.nodeScale);
    });

    if (ungroupedComponents.length > 0) {
      const gridSize = Math.ceil(Math.sqrt(ungroupedComponents.length));
      const baseSpacing = 40;

      ungroupedComponents.forEach((nodeId, index) => {
        const row = Math.floor(index / gridSize);
        const col = index % gridSize;
        const scale = nodeScales.get(nodeId) || [1, 1, 1];
        const scaleFactor = Math.max(...scale);
        const nodeSpacing = baseSpacing * scaleFactor;

        const position = [
          basePosition[0] + col * nodeSpacing,
          basePosition[1] + ungroupedYOffset,
          basePosition[2] + 50 + row * nodeSpacing,
        ];
        nodePositions.set(nodeId, position);
      });
    }

    // ── 7. Position children of ungrouped components ──────────────────────
    ungroupedComponents.forEach((componentId) => {
      const children = context.parentChildMap.get(componentId) || new Set();
      if (children.size > 0) {
        const componentPosition = nodePositions.get(componentId);

        const scaleResult = this.calculateDodecahedronScale(
          componentId,
          context.parentChildMap,
          graphNodes,
          context?.internalComponentChildren || new Set(),
          0
        );
        const containerSize = scaleResult.containerSize;

        const childArray = Array.from(children).sort();
        childArray.forEach((childId, index) => {
          const childNode = graphNodes.get(childId);
          if (!childNode) return;

          const childType = (childNode.type || '').toLowerCase().trim();

          if (
            childType === NODE_TYPE_FUNCTION ||
            (childType === NODE_TYPE_COMPONENT &&
              context.internalComponentChildren &&
              context.internalComponentChildren.has(childId))
          ) {
            const childPosition = this.calculateNodePosition(
              childId,
              basePosition,
              1,
              index,
              childArray.length,
              componentPosition,
              containerSize,
              new Set(),
              graphNodes,
              context.parentChildMap,
              context?.internalComponentChildren || new Set()
            );

            nodePositions.set(childId, childPosition);
            nodeScales.set(childId, [1, 1, 1]);
            context.processedNodes.add(childId);
          }
        });
      }
    });

    // ── 8. Position children of ALL grouped nodes (unified) ───────────────
    for (const [, nodes] of groupedByType) {
      nodes.forEach((groupNodeId) => {
        const children = context.parentChildMap.get(groupNodeId) || new Set();
        if (children.size === 0) return;

        const parentPosition = nodePositions.get(groupNodeId);
        const childArray = Array.from(children).sort();

        childArray.forEach((childId, index) => {
          const childNode = graphNodes.get(childId);
          if (!childNode) return;

          const childType = (childNode.type || '').toLowerCase().trim();

          // Position any non-component, non-datapath child inside its parent.
          // Also position internal component children.
          if (
            childType !== NODE_TYPE_COMPONENT &&
            childType !== NODE_TYPE_DATAPATH
          ) {
            const childPosition = this.calculateNodePosition(
              childId,
              basePosition,
              1,
              index,
              childArray.length,
              parentPosition,
              50,
              new Set(),
              graphNodes,
              context.parentChildMap,
              context?.internalComponentChildren || new Set()
            );

            nodePositions.set(childId, childPosition);
            nodeScales.set(childId, [1, 1, 1]);
            context.processedNodes.add(childId);
          }
        });
      });
    }

    // Store the final ungrouped list so containerMethods.js can use the same
    // set of nodes when creating the "Unused Components" container, instead
    // of re-calculating with a different (broader) condition.
    context.ungroupedComponents = ungroupedComponents;
  },

  /**
   * Apply `align row|column` directives after positions are resolved.
   *
   *   align row    A B C  →  shared Y (same height, horizontal row)
   *   align column D E F  →  shared X (same lateral plane, vertical column)
   *
   * Pure — operates only on the maps handed to it, so it is safe to run in
   * the layout worker (which bridges only constants + hierarchy + scale +
   * position methods).
   */
  applyAlignments(context) {
    const { nodePositions, alignments } = context;
    if (!alignments || alignments.length === 0) return;

    for (const alignment of alignments) {
      const ids = alignment.nodeIds || [];
      if (ids.length < 2) continue;

      const positioned = [];
      for (const id of ids) {
        const pos = nodePositions.get(id);
        if (!pos) continue;
        positioned.push(pos);
      }
      if (positioned.length < 2) continue;

      if (alignment.mode === 'row') {
        const avgY =
          positioned.reduce((s, p) => s + p[1], 0) / positioned.length;
        positioned.forEach((p) => {
          p[1] = avgY;
        });
      } else {
        // column
        const avgX =
          positioned.reduce((s, p) => s + p[0], 0) / positioned.length;
        positioned.forEach((p) => {
          p[0] = avgX;
        });
      }
    }
  },
};
