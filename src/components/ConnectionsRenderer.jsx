import React, { useMemo, useCallback, useRef, useEffect, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { acquireBudget, isCameraMoving, isFrameBudgetExhausted } from '../utils/renderWorkScheduler';

import InstancedLine from './InstancedLine';
import BatchedConnectionLines from './BatchedConnectionLines';
import BatchedCurvedLines from './BatchedCurvedLines';
import ConnectionArrowheads from './ConnectionArrowheads';
import AtlasTextSprite from './AtlasTextSprite';
import DistanceFilteredTextLabels from './DistanceFilteredTextLabels';
import LineUI from './LineUI';
import HeaderInput from './HeaderInput';
import TextStyleUI from './TextStyleUI';
import AnimatedConnectionLine from './AnimatedConnectionLine';
import {
  invalidatePathfindingCaches,
  computeConnectionPath,
  precomputePathsBatch,
  isWorkerBusy,
  hasPrecomputedPathCache,
} from '../utils/pathfindingUtils';
import { bulkImportState } from '../utils/bulkImportState';
import { calculateMidpoint } from '../utils/positionUtils';
import { calculateFacePosition } from '../utils/facePositionUtils';
import { saveConnection } from '../services/connectionsService';
import { useConnectionObjectPositions } from '../hooks/useConnectionObjects';
import { 
  useConnectionState, 
  useConnectionActions,
  useConnectionsRendererStore 
} from '../hooks/useConnectionsRendererStore';
import { useFrustumCulledConnections } from '../hooks/useFrustumCulling';
import useConnectionStore from '../stores/connectionStore';
import useDiagramStore from '../stores/diagramStore';

// PERFORMANCE: Hoisted pointer handlers — identical for every connection,
// avoids creating new closures on each render.
const handlePointerOver = (e) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; };
const handlePointerOut = (e) => { e.stopPropagation(); document.body.style.cursor = 'auto'; };

/**
 * PERFORMANCE: Distance-filtered text for individual Connection components
 * Only renders text when camera is within maxDistance units
 */
const DistanceFilteredConnectionText = React.memo(({ 
  position, 
  maxDistance = 500,
  children 
}) => {
  // GPU RESOURCE FIX: Use a ref + group visibility instead of useState which
  // caused rapid mount/unmount of AtlasTextSprite children (creating and
  // disposing PlaneGeometry on every visibility toggle during camera movement).
  const groupRef = useRef();
  const lastCheckRef = useRef(0);
  const maxDistanceSquared = maxDistance * maxDistance;
  
  useFrame(({ camera }) => {
    // Throttle checks to every 200ms (was 100ms — reduced frequency during fast panning)
    const now = Date.now();
    if (now - lastCheckRef.current < 200) return;
    // FREEZE FIX: Skip visibility checks when main thread is lagging
    if (isFrameBudgetExhausted()) return;
    lastCheckRef.current = now;
    
    if (!groupRef.current) return;
    
    if (!position) {
      groupRef.current.visible = false;
      return;
    }
    
    const dx = camera.position.x - position[0];
    const dy = camera.position.y - position[1];
    const dz = camera.position.z - position[2];
    const distanceSquared = dx * dx + dy * dy + dz * dz;
    
    groupRef.current.visible = distanceSquared <= maxDistanceSquared;
  });
  
  return <group ref={groupRef}>{children}</group>;
});

DistanceFilteredConnectionText.displayName = 'DistanceFilteredConnectionText';

/**
 * Compute a deterministic parametric t-value for positioning text along a
 * connection line.  Instead of always placing text at the midpoint (t=0.5),
 * this gives each connection a unique t so that connections sharing the same
 * line (identical start/end positions) have their labels spread out rather
 * than stacking on top of each other.
 *
 * The t-value is derived from a hash of the connection ID and mapped into
 * the range [0.25, 0.75] with 13 distinct slots.  13 is large enough to
 * handle the "10+ headers stacked" scenario the user reported.
 *
 * @param {string} connectionId
 * @returns {number} t ∈ [0.25 .. 0.75]
 */
function getTextParametricT(connectionId) {
  let hash = 0;
  const str = String(connectionId);
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = hash & hash; // 32-bit
  }
  // 13 slots in [0.25, 0.75]
  return 0.25 + (Math.abs(hash) % 13) * (0.5 / 12);
}

/**
 * Redistribute faces at render time for connections that share the same
 * object + face combination.  Returns a Map<connectionId, {startFace, endFace}>
 * with potentially reassigned face values so that no two connections from/to
 * the same endpoint object use the same face.
 *
 * This fixes existing connections loaded from Firestore that were saved with
 * face='front' before the face-distribution fix in markdownDiagramService.
 */
const CUBE_FACE_NAMES = ['front', 'back', 'left', 'right', 'top', 'bottom'];
const TETRA_FACE_NAMES = ['front', 'left', 'right', 'bottom'];

function redistributeFaces(connections, objectsById) {
  const redistributed = new Map();

  // Group by (objectId, endpoint) to find conflicts
  // key = "objectId_start" or "objectId_end"
  const endpointGroups = new Map();
  for (const conn of connections) {
    const sk = conn.start?.objectId && `${conn.start.objectId}_start`;
    const ek = conn.end?.objectId && `${conn.end.objectId}_end`;
    if (sk) {
      if (!endpointGroups.has(sk)) endpointGroups.set(sk, []);
      endpointGroups.get(sk).push({ connId: conn.id, side: 'start', face: conn.start?.face, type: conn.start?.type });
    }
    if (ek) {
      if (!endpointGroups.has(ek)) endpointGroups.set(ek, []);
      endpointGroups.get(ek).push({ connId: conn.id, side: 'end', face: conn.end?.face, type: conn.end?.type });
    }
  }

  for (const [key, items] of endpointGroups) {
    if (items.length <= 1) continue; // no conflict

    // Check if all items share the same face (conflict)
    const faces = new Set(items.map(it => String(it.face)));
    if (faces.size >= items.length) continue; // already unique

    // Determine the face list for this object type
    const objectId = key.split('_')[0];
    const obj = objectsById.get(objectId);
    const objType = items[0]?.type || obj?.type || 'cube';
    let faceList;
    if (objType === 'dodecahedron') {
      faceList = Array.from({ length: 12 }, (_, i) => i);
    } else if (objType === 'tetrahedron') {
      faceList = TETRA_FACE_NAMES;
    } else {
      faceList = CUBE_FACE_NAMES;
    }

    // Assign faces round-robin
    items.forEach((item, i) => {
      const newFace = faceList[i % faceList.length];
      if (!redistributed.has(item.connId)) redistributed.set(item.connId, {});
      redistributed.get(item.connId)[item.side === 'start' ? 'startFace' : 'endFace'] = newFace;
    });
  }

  return redistributed;
}

/**
 * Convert a path of connected points into line segments for InstancedLine
 * Path: [p0, p1, p2, p3] -> Segments: [p0, p1, p1, p2, p2, p3]
 * This allows InstancedLine to render connected line segments
 */
function pathToLineSegments(path) {
  if (!path || path.length < 2) return path;

  const segments = [];
  for (let i = 0; i < path.length - 1; i++) {
    segments.push(path[i], path[i + 1]);
  }
  return segments;
}

/**
 * Resolve the world position for a connection endpoint.
 * ALWAYS computes face positions from current object geometry when face data
 * is available – stored positions from Firestore / RealTimeConnectionUpdater
 * may be stale (saved before objects moved) or wrong (face-0 falsiness bug in
 * the old connectionPositionResolver).
 *
 * Priority:
 *   1. Calculate from face index + current object geometry (most accurate)
 *   2. Stored position (set by RealTimeConnectionUpdater or Firestore)
 *   3. Object center (last resort)
 *
 * @param {Object}  endpointData - conn.start or conn.end
 * @param {Map}     objectsById  - Map<objectIdString, objectData>
 * @param {Array}   objects      - Full objects array (needed by calculateFacePosition)
 * @returns {Array|null} [x, y, z] or null
 */
function resolveEndpointPosition(endpointData, objectsById, objects) {
  if (!endpointData) return null;

  const objId = endpointData.objectId?.toString();

  // 1. Has face data + object available → compute fresh position from geometry
  //    This is the most accurate path and avoids stale stored positions
  if (endpointData.face !== undefined && objId) {
    const obj = objectsById.get(objId);
    if (obj?.position) {
      try {
        return calculateFacePosition(
          {
            type: endpointData.type || obj.type || 'cube',
            face: endpointData.face,
            objectId: endpointData.objectId,
            faceCenter: endpointData.faceCenter,
            cube: { position: obj.position, scale: obj.scale || [1, 1, 1] },
            plane: obj.type === 'plane'
              ? { position: obj.position, scale: obj.scale || [1, 1, 1] }
              : undefined,
          },
          objects
        );
      } catch {
        // Fall through to stored / center
      }
    }
  }

  // 2. Stored position (fallback when face data isn't available or calc failed)
  const stored = endpointData.position || endpointData.facePosition || endpointData.worldPosition;
  if (stored) return stored;

  // 3. Object center (last resort)
  if (!objId) return null;
  const obj = objectsById.get(objId);
  return obj?.position || null;
}

// Separate connection rendering into a sub-component to fix the hooks issue
const Connection = React.memo(
  ({
    connection,
    allObjectsForPathfinding,
    onLineStyleChange,
    onLineColorChange,
    onConnectionClick,
    onLineTextClick,
    onLineTextSubmit,
    onLineTextStyleChange,
    // PERFORMANCE: Pass store state as props to avoid individual subscriptions
    _selectedConnection,
    // PERFORMANCE: Single hash computed once in the parent for ALL objects,
    // replaces the per-Connection O(N) nearbyObjectsHash loop.
    objectsPositionHash,
  }) => {
    // Get only the specific objects needed for this connection
    const { startObject, endObject } = useConnectionObjectPositions(
      connection?.start?.objectId,
      connection?.end?.objectId
    );
    
    // PERFORMANCE: Use batched state hook instead of 7+ individual subscriptions
    const connectionState = useConnectionState(connection?.id);
    const actions = useConnectionActions();
    
    // Destructure for easier access
    const { isSelected, isFlowPathHighlighted, isDeleting, lineText, showTextInput, showStyleUI } = connectionState;
    const { 
      setShowLineTextStyleUI, 
      setShowLineTextInput, 
      selectConnectionWithFlowPath, 
      selectConnection,
      setLineText, 
      updateConnection 
    } = actions;

    // Consolidated line width calculation - consistent across all line types
    const getLineWidth = useCallback(
      () => {
        if (isSelected) return 2.5;
        if (isFlowPathHighlighted) return 2;
        return 1;
      },
      [isSelected, isFlowPathHighlighted]
    );

    // Handler function - always use passed onConnectionClick if available for consistency
    const handleConnectionClick = useCallback(
      (e, connectionId) => {
        e.stopPropagation();
        if (onConnectionClick) {
          onConnectionClick(e, connectionId);
        } else {
          selectConnectionWithFlowPath(connectionId);
        }
      },
      [onConnectionClick, selectConnectionWithFlowPath]
    );

    const handleLineTextClick = (e, connectionId) => {
      if (onLineTextClick) {
        onLineTextClick(e, connectionId);
      } else {
        e.stopPropagation();
        setShowLineTextStyleUI(connectionId);
      }
    };

    const handleLineTextSubmit = (connectionId, text) => {
      if (onLineTextSubmit) {
        return onLineTextSubmit(connectionId, text);
      } else {
        // Check if connection is being deleted before saving
        if (isDeleting) {
          return false;
        }

        setLineText(connectionId, text);
        setShowLineTextInput(null);
        // Update both store and database
        updateConnection(connectionId, { text });
        // PERFORMANCE: Read latest connection from store at save time instead of
        // receiving the entire connections array as a prop (which broke React.memo).
        const updatedConnection = useConnectionStore.getState().connections.find(
          (conn) => conn.id === connectionId
        );
        if (updatedConnection) {
          saveConnection(window.currentUser?.uid, window.currentSpaceId, {
            ...updatedConnection,
            text,
          });
        }
        return true;
      }
    };

    const handleLineTextStyleChange = (connectionId, style) => {
      if (onLineTextStyleChange) {
        onLineTextStyleChange(connectionId, style);
      } else {
        // Check if connection is being deleted before saving
        if (isDeleting) {
          return;
        }

        // Get current connection to merge with existing textStyle (like cube header text)
        const currentConnection = useConnectionStore.getState().connections.find(
          (conn) => conn.id === connectionId
        );
        const mergedTextStyle = {
          ...(currentConnection?.textStyle || {}),
          ...style,
        };

        // Update both store and database
        updateConnection(connectionId, { textStyle: mergedTextStyle });
        const updatedConnection = useConnectionStore.getState().connections.find(
          (conn) => conn.id === connectionId
        );
        if (updatedConnection) {
          saveConnection(window.currentUser?.uid, window.currentSpaceId, {
            ...updatedConnection,
            textStyle: mergedTextStyle,
          });
        }
      }
    };
    const handleLineStyleChange = (connectionId, styleType) => {
      if (onLineStyleChange) {
        onLineStyleChange(connectionId, styleType);
      } else {
        // Check if connection is being deleted before saving
        if (isDeleting) {
          return;
        }

        // Parse the styleType to separate base style and direction
        let baseStyle = styleType;
        let direction = null;

        if (styleType.includes('-')) {
          const parts = styleType.split('-');
          baseStyle = parts[0];
          direction = parts[1];
        }

        // Update both styleType and dashDirection with timestamp to force re-render
        updateConnection(connectionId, {
          styleType: baseStyle,
          dashDirection: direction,
          _lastStyleUpdate: Date.now(),
        });

        const updatedConnection = useConnectionStore.getState().connections.find(
          (conn) => conn.id === connectionId
        );
        if (updatedConnection) {
          saveConnection(window.currentUser?.uid, window.currentSpaceId, {
            ...updatedConnection,
            styleType: baseStyle,
            dashDirection: direction,
            _lastStyleUpdate: Date.now(),
          });
        }
      }
    };

    const handleLineColorChange = (connectionId, color) => {
      if (onLineColorChange) {
        onLineColorChange(connectionId, color);
      } else {
        // Check if connection is being deleted before saving
        if (isDeleting) {
          return;
        }

        // Update store with correct color property name
        updateConnection(connectionId, { color: color });
        const updatedConnection = useConnectionStore.getState().connections.find(
          (conn) => conn.id === connectionId
        );
        if (updatedConnection) {
          saveConnection(window.currentUser?.uid, window.currentSpaceId, {
            ...updatedConnection,
            color: color, // Use 'color' not 'lineColor'
          });
        }
      }
    };

    // Always call hooks first, before any conditional returns
    // Declare all useMemo hooks unconditionally
    // First hook: Calculate basic connection data with real-time object positions
    const connectionData = useMemo(() => {
      // Early validation with minimal computation
      if (!connection?.start?.objectId || !connection?.end?.objectId) {
        return {
          isValid: false,
          midpoint: [0, 0, 0],
          startPosition: [0, 0, 0],
          endPosition: [0, 0, 0],
        };
      }

      // Cache object lookups to avoid repeated searches
      const startObj = startObject;
      const endObj = endObject;

      // Simplified position calculation with early returns
      const startPosition =
        startObj?.position && connection.start?.face !== undefined
          ? (() => {
              try {
                return calculateFacePosition(
                  {
                    type: connection.start.type || startObj.type || 'cube',
                    face: connection.start.face,
                    objectId: connection.start.objectId,
                    faceCenter: connection.start.faceCenter,
                    cube: {
                      position: startObj.position,
                      scale: startObj.scale || [1, 1, 1],
                    },
                    plane:
                      startObj.type === 'plane'
                        ? {
                            position: startObj.position,
                            scale: startObj.scale || [1, 1, 1],
                          }
                        : undefined,
                  },
                  allObjectsForPathfinding
                );
              } catch {
                return startObj.position;
              }
            })()
          : connection.start?.position ||
            connection.start?.facePosition ||
            connection.start?.worldPosition ||
            startObj?.position || [0, 0, 0];

      const endPosition =
        endObj?.position && connection.end?.face !== undefined
          ? (() => {
              try {
                return calculateFacePosition(
                  {
                    type: connection.end.type || endObj.type || 'cube',
                    face: connection.end.face,
                    objectId: connection.end.objectId,
                    faceCenter: connection.end.faceCenter,
                    cube: {
                      position: endObj.position,
                      scale: endObj.scale || [1, 1, 1],
                    },
                    plane:
                      endObj.type === 'plane'
                        ? {
                            position: endObj.position,
                            scale: endObj.scale || [1, 1, 1],
                          }
                        : undefined,
                  },
                  allObjectsForPathfinding
                );
              } catch {
                return endObj.position;
              }
            })()
          : connection.end?.position ||
            connection.end?.facePosition ||
            connection.end?.worldPosition ||
            endObj?.position || [0, 0, 0];

      // Validate positions more efficiently
      const isValid =
        Array.isArray(startPosition) &&
        Array.isArray(endPosition) &&
        startPosition.length >= 3 &&
        endPosition.length >= 3 &&
        startPosition.every((val) => typeof val === 'number' && !isNaN(val)) &&
        endPosition.every((val) => typeof val === 'number' && !isNaN(val));

      if (!isValid) {
        return {
          isValid: false,
          midpoint: [0, 0, 0],
          startPosition,
          endPosition,
        };
      }

      return {
        isValid: true,
        midpoint: calculateMidpoint(startPosition, endPosition),
        startPosition,
        endPosition,
      };
    }, [
      connection?.start?.objectId, // More specific dependencies
      connection?.end?.objectId,
      connection?.start?.face,
      connection?.end?.face,
      connection?.start?.position,
      connection?.end?.position,
      startObject?.position,
      startObject?.scale,
      startObject?.type,
      endObject?.position,
      endObject?.scale,
      endObject?.type,
      // Remove allObjectsForPathfinding from dependencies - only needed for face calculations
    ]);

    // Second hook: Filter relevant objects with stable dependencies
    // IMPORTANT: Include all objects for intersection testing, even endpoints,
    // Create a stable reference to filtered objects for pathfinding
    // This will only change when the allObjectsForPathfinding prop actually changes

    const stableLineStyle =
      connection?.styleType || connection?.lineStyle || 'straight';

    // PERFORMANCE: Separate pathfinding style from visual style
    // Only 'curved' matters for pathfinding - dashed/dotted don't affect the path
    const pathfindingStyle =
      stableLineStyle === 'curved' ? 'curved' : 'straight';

    const stableStartObjectId = connection?.start?.objectId;
    const stableEndObjectId = connection?.end?.objectId;
    const stablePathPoints = connection?._pathPoints;

    // PERFORMANCE: objectsPositionHash is now computed ONCE in the parent
    // ConnectionsRenderer and passed as a prop, replacing the O(N) per-connection
    // nearbyObjectsHash loops that iterated ALL objects for EACH connection.

    // Third hook: Calculate path and intersections
    // Use a more selective dependency to minimize re-renders
    const pathData = useMemo(() => {
      if (!connectionData.isValid) {
        return {
          calculatedPathPoints: [
            [0, 0, 0],
            [0, 0, 0],
          ],
          effectiveLineStyle: 'straight',
          intersections: [],
        };
      }

      const { startPosition, endPosition } = connectionData;
      const lineStyle = pathfindingStyle;
      const hasStoredPath = stablePathPoints && stablePathPoints.length > 0;

      // Only check intersections when necessary
      const shouldCheckIntersections = lineStyle === 'curved' || !hasStoredPath;

      let intersections = null;
      let computedPathPoints = null;

      if (shouldCheckIntersections) {
        // computeConnectionPath checks the worker-precomputed cache first,
        // then falls back to synchronous computation.
        const result = computeConnectionPath(
          startPosition,
          endPosition,
          allObjectsForPathfinding,
          stableStartObjectId?.toString() || '',
          stableEndObjectId?.toString() || ''
        );
        // Reconstruct the intersections-like truthiness for shouldCurve check
        intersections = result.hasIntersections ? [true] : null;
        computedPathPoints = result.pathPoints;
      }

      // Determine if we need curved path
      const shouldCurve =
        lineStyle === 'curved' || (intersections && intersections.length > 0);

      // Use stored path when possible
      const calculatedPathPoints = shouldCurve
        ? computedPathPoints || [startPosition, endPosition]
        : stablePathPoints || [startPosition, endPosition];

      const isCurvedPath =
        calculatedPathPoints && calculatedPathPoints.length > 2 && shouldCurve;

      // PATHFINDING FIX: Don't override user's line style when pathfinding creates curved path
      // The path can be curved (multiple points) while the visual style stays straight/dashed/dotted
      // Only use 'curved' as effective style if user explicitly chose 'curved'
      const effectiveLineStyle = stableLineStyle;

      return {
        calculatedPathPoints: calculatedPathPoints || [
          startPosition,
          endPosition,
        ],
        effectiveLineStyle,
        intersections,
        isCurvedPath, // Add this so we know if pathfinding generated a curved path
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
      connectionData, // Only depends on connectionData changes
      pathfindingStyle,
      stablePathPoints,
      stableStartObjectId,
      stableEndObjectId,
      stableLineStyle,
      allObjectsForPathfinding, // Keep for lint, but objectsPositionHash is what actually triggers
      objectsPositionHash, // Single hash from parent — replaces per-Connection O(N) loop
    ]);

    // Fourth hook: Calculate text position
    // SOURCE-LEVEL FIX: Use a per-connection parametric t-value so that
    // connections sharing the same line (identical endpoints / faces) place
    // their text labels at different positions along the line instead of all
    // stacking at the midpoint.
    const textPositionData = useMemo(() => {
      if (!connectionData.isValid) {
        return { textPosition: [0, 0, 0] };
      }

      const { startPosition, endPosition } = connectionData;
      const { calculatedPathPoints } = pathData;
      const offset = 2;
      const t = getTextParametricT(connection?.id);

      let textPosition;
      // Check if path is curved (has more than 2 points) regardless of line style
      if (calculatedPathPoints?.length > 2) {
        // Pick a point at parametric position t along the curved path
        const idx = Math.min(
          Math.floor(t * (calculatedPathPoints.length - 1)),
          calculatedPathPoints.length - 1
        );
        const midPoint = calculatedPathPoints[idx];
        const pos = Array.isArray(midPoint)
          ? midPoint
          : [midPoint.x, midPoint.y, midPoint.z];
        textPosition = [pos[0], pos[1] + offset, pos[2]];
      } else {
        // Parametric lerp between start and end
        textPosition = [
          startPosition[0] + (endPosition[0] - startPosition[0]) * t,
          startPosition[1] + (endPosition[1] - startPosition[1]) * t + offset,
          startPosition[2] + (endPosition[2] - startPosition[2]) * t,
        ];
      }

      return { textPosition };
    }, [connectionData, pathData, connection?.id]); // Early return after all hooks are declared
    if (!connection) {
      return null;
    }
    // Early return for invalid connections - after all hooks are declared
    if (!connectionData.isValid) {
      return null;
    }

    // Extract all needed values from hooks
    const { midpoint } = connectionData;
    const { calculatedPathPoints, effectiveLineStyle } = pathData;
    const { textPosition } = textPositionData;
    // Determine connection text - prioritize batched lineText over connection.text
    const connectionText = lineText || connection.text || '';

    // DEBUG: Log connection text for markdown connections
    if (connection.merfolkData) {
      // Debug logging removed
    }
    return (
      <group
        key={`${connection.id}-${connection._visualUpdate || 0}-${
          connection._localUpdate || 0
        }`}
      >
        {/* Conditional line rendering based on line style */}
        {/* Extract base style (without direction suffix like '-right', '-left') */}
        {(() => {
          const baseStyle = effectiveLineStyle.split('-')[0]; // 'dashed-right' -> 'dashed'

          // Render solid lines (straight path or curved path) using InstancedLine
          if (baseStyle === 'straight') {
            return (
              <InstancedLine
                key={`line-${connection.id}-${
                  connection._lastStyleUpdate || 0
                }`}
                points={pathToLineSegments(calculatedPathPoints)}
                color={
                  isSelected ? '#ffff00' :
                  isFlowPathHighlighted ? '#FF9800' :
                  (connection.color || 'black')
                }
                lineWidth={getLineWidth()}
                glowWidth={1}
                onClick={(e) => handleConnectionClick(e, connection.id)}
                onPointerOver={handlePointerOver}
                onPointerOut={handlePointerOut}
              />
            );
          }

          // Render dashed/dotted lines using AnimatedConnectionLine
          // These support pathfinding multi-point paths
          return (
            <AnimatedConnectionLine
              key={`animated-line-${connection.id}-${effectiveLineStyle}-${
                connection._lastStyleUpdate || 0
              }`}
              points={calculatedPathPoints}
              connectionId={connection.id}
              color={
                isSelected ? '#ffff00' :
                isFlowPathHighlighted ? '#FF9800' :
                (connection.color || 'black')
              }
              lineWidth={getLineWidth()}
              lineStyle={effectiveLineStyle}
              dashDirection={connection.dashDirection || null}
              dashOffset={connection.dashOffset || 0}
              isSelected={isSelected}
              onClick={(e) => handleConnectionClick(e, connection.id)}
              onPointerOver={handlePointerOver}
              onPointerOut={handlePointerOut}
            />
          );
        })()}
        {/* Connection text using AtlasTextSprite with distance filtering */}
        <DistanceFilteredConnectionText position={textPosition} maxDistance={500}>
          <AtlasTextSprite
            key={`text-${connection.id}-${connection.text || 'no-text'}-${
              connection.textStyle?.fontSize || 1.5
            }-${connection.textStyle?.color || 'black'}`}
            text={connectionText}
            position={textPosition}
            style={{
              fontSize: (connection.textStyle?.fontSize || 1.5) * 10, // Convert to pixel size for atlas
              color: connection.textStyle?.color || 'black',
              underline: connection.textStyle?.underline || false,
            }}
            onClick={(e) => handleLineTextClick(e, connection.id)}
            billboard={true}
            renderOrder={20} // Higher than connection lines (10) but lower than header text (3000-5000)
            scale={0.45} // 3x larger than previous 0.15 to match cube header text size
            lineStyle={effectiveLineStyle} // Pass line style for dynamic positioning
            pathPoints={calculatedPathPoints} // Pass path points for curved line positioning
          />
        </DistanceFilteredConnectionText>
        {/* Text input UI */}
        {showTextInput && (
          <HeaderInput
            position={[midpoint[0], midpoint[1] + 5, midpoint[2]]}
            onTextSubmit={(text) => handleLineTextSubmit(connection.id, text)}
            inputId={`connection-${connection.id}-text`}
            initialText={connectionText}
          />
        )}
        {/* Text style UI */}
        {showStyleUI && (
          <TextStyleUI
            position={[midpoint[0], midpoint[1] + 8, midpoint[2]]}
            onStyleChange={(style) =>
              handleLineTextStyleChange(connection.id, style)
            }
            onClose={() => setShowLineTextStyleUI(null)}
            currentStyle={connection.textStyle || {}}
            uiType="connection"
          />
        )}
        {/* Connection controls */}
        {isSelected && (
          <LineUI
            position={midpoint}
            onColorChange={(color) =>
              handleLineColorChange(connection.id, color)
            }
            onToggleDashed={(styleType) =>
              handleLineStyleChange(connection.id, styleType)
            }
            onTextClick={() => {
              setShowLineTextInput(connection.id);
              selectConnection(null);
            }}
            currentText={connectionText}
            hasText={!!connectionText && connectionText.trim() !== ''}
            currentConnection={connection}
          />
        )}
      </group>
    );
  },
  (prevProps, nextProps) => {
    // Re-render if the pathfinding objects changed (any object moved)
    if (
      prevProps.allObjectsForPathfinding !== nextProps.allObjectsForPathfinding
    ) {
      return false; // Props changed, need to re-render
    }

    // PERFORMANCE: objectsPositionHash is a cheap numeric comparison that
    // replaces the old pattern of passing the entire connections array.
    if (prevProps.objectsPositionHash !== nextProps.objectsPositionHash) return false;

    // Only re-render if the connection data actually changed
    const connectionChanged =
      prevProps.connection.id !== nextProps.connection.id ||
      prevProps.connection._visualUpdate !==
        nextProps.connection._visualUpdate ||
      prevProps.connection._localUpdate !== nextProps.connection._localUpdate ||
      prevProps.connection._lastStyleUpdate !==
        nextProps.connection._lastStyleUpdate ||
      prevProps.connection.color !== nextProps.connection.color ||
      prevProps.connection.text !== nextProps.connection.text ||
      prevProps.connection.styleType !== nextProps.connection.styleType ||
      prevProps.connection.lineStyle !== nextProps.connection.lineStyle ||
      prevProps.connection.dashDirection !==
        nextProps.connection.dashDirection ||
      // Shallow comparison instead of JSON.stringify for textStyle
      (() => {
        const a = prevProps.connection.textStyle;
        const b = nextProps.connection.textStyle;
        if (a === b) return false;
        if (!a || !b) return true;
        const keys = Object.keys(a);
        if (keys.length !== Object.keys(b).length) return true;
        return keys.some(k => a[k] !== b[k]);
      })() ||
      prevProps.connection.start?.position !==
        nextProps.connection.start?.position ||
      prevProps.connection.end?.position !== nextProps.connection.end?.position;

    // Re-render only if connection-specific data changed
    // We'll handle pathfinding object changes more selectively in the component
    return !connectionChanged;
  }
);

Connection.displayName = 'Connection';

/**
 * Component for rendering all connections
 * PERFORMANCE OPTIMIZED:
 * - Uses batched store subscriptions (useConnectionsRendererStore)
 * - Implements frustum culling to only render visible connections
 * - Global animation manager for dashed/dotted lines
 */
const ConnectionsRenderer = ({
  objects,
  visibleObjectIds,
  onLineStyleChange,
  onLineColorChange,
  onConnectionClick,
  onLineTextClick,
  onLineTextSubmit,
  onLineTextStyleChange,
}) => {
  // PERFORMANCE: Use batched store subscription instead of multiple individual ones
  const {
    connections,
    connectionsVisible,
    focusedObjectId,
    selectedConnection,
    highlightedFlowPathIds,
  } = useConnectionsRendererStore();

  // Create a stable set of available object IDs to avoid recalculating on every render
  const availableObjectIds = useMemo(() => {
    if (!objects || objects.length === 0) return new Set();
    return new Set(objects.map((obj) => obj.id.toString()));
  }, [objects]);

  // Create pathfinding objects for intersection calculations
  // This will update whenever the objects array reference changes (which happens when positions update)
  const pathfindingObjects = useMemo(() => {
    if (!objects?.length) return [];

    // Create object references with current positions
    // The objects array ref changes when ANY object position/scale changes (via store's hash comparison)
    const result = objects.map((obj) => ({
      id: obj.id,
      position: obj.position || [0, 0, 0],
      scale: obj.scale || [1, 1, 1],
      type: obj.type,
      faceSize: obj.faceSize,
    }));
    if (window._debugPathfinding) {
      console.log(`[PathDebug] pathfindingObjects rebuilt: ${result.length} objects`);
    }
    return result;
  }, [objects]);

  // PERFORMANCE: Compute a single position hash for ALL objects once in the parent.
  // This replaces the per-Connection O(N) nearbyObjectsHash loop.
  // Every Connection receives this single number; when it changes, pathData recomputes.
  const objectsPositionHash = useMemo(() => {
    if (!pathfindingObjects.length) return 0;
    let hash = 0;
    for (let i = 0; i < pathfindingObjects.length; i++) {
      const p = pathfindingObjects[i].position;
      const px = Math.round(p[0] * 10);
      const py = Math.round(p[1] * 10);
      const pz = Math.round(p[2] * 10);
      hash = ((hash * 31) ^ (px + py * 1000 + pz * 1000000)) >>> 0;
    }
    return (hash ^ (pathfindingObjects.length * 17)) >>> 0;
  }, [pathfindingObjects]);

  // Fast pre-cull set for the bulk connection pipeline.  Prefer the virtualizer-
  // capped visibleObjectIds (frustum/limit culled) so only connections whose
  // endpoints are currently being displayed flow into the expensive pathfinding
  // pipeline.  Fall back to availableObjectIds (all loaded objects) when the
  // virtualizer set is empty (e.g. before the camera mounts).  The focused and
  // flow-path subsets below deliberately keep using availableObjectIds so
  // off-screen connected objects still render for those specific cases.
  const visibleIds = useMemo(() => {
    if (visibleObjectIds && visibleObjectIds.size > 0) return visibleObjectIds;
    return availableObjectIds;
  }, [visibleObjectIds, availableObjectIds]);

  // Filter connections to only show those where both endpoint objects are loaded
  const objectVisibleConnections = useMemo(() => {
    if (!connections?.length) return [];

    // Use visibleObjectIds when populated (fast frustum-culled gate), falling
    // back to availableObjectIds (all loaded objects) otherwise.
    return connections.filter((connection) => {
      const startId = connection.start?.objectId?.toString();
      const endId = connection.end?.objectId?.toString();
      return (
        startId && endId && visibleIds.has(startId) && visibleIds.has(endId)
      );
    });
  }, [connections, visibleIds]);

  // Get connections for the focused object (when connections are globally hidden)
  const focusedConnections = useMemo(() => {
    if (!focusedObjectId || connectionsVisible || !connections?.length) return [];
    
    const focusedIdStr = focusedObjectId.toString();
    
    return connections.filter((connection) => {
      const startId = connection.start?.objectId?.toString();
      const endId = connection.end?.objectId?.toString();
      
      // Connection must involve the focused object
      const involvesFocused = startId === focusedIdStr || endId === focusedIdStr;
      
      // Both endpoints must be loaded. Uses availableObjectIds (not the fast
      // frustum-culled visibleIds set) so focused connections still render
      // when an endpoint is off-screen.
      const bothLoaded = startId && endId && availableObjectIds.has(startId) && availableObjectIds.has(endId);
      
      return involvesFocused && bothLoaded;
    });
  }, [focusedObjectId, connectionsVisible, connections, availableObjectIds]);

  // When flow-path highlighting is active, include all highlighted connections
  // regardless of the focus filter — they may span objects beyond the focused one.
  const flowPathHighlightedConnections = useMemo(() => {
    if (!highlightedFlowPathIds?.size || !connections?.length) return [];
    // Respect spatial availability (don't render connections to unloaded objects)
    // but bypass the focusedObjectId filter so off-focus segments become visible.
    return connections.filter(conn => {
      if (!highlightedFlowPathIds.has(conn.id)) return false;
      const startId = conn.start?.objectId?.toString();
      const endId = conn.end?.objectId?.toString();
      return startId && endId && availableObjectIds.has(startId) && availableObjectIds.has(endId);
    });
  }, [highlightedFlowPathIds, connections, availableObjectIds]);

  // Determine which connections to consider for rendering.
  // When a flow-path is highlighted, merge its connections into the culling set
  // so they get rendered even when globally hidden or outside the focus filter.
  const connectionsForCulling = useMemo(() => {
    const base = connectionsVisible ? objectVisibleConnections : focusedConnections;
    if (!highlightedFlowPathIds?.size || flowPathHighlightedConnections.length === 0) return base;
    const baseIds = new Set(base.map(c => c.id));
    const extras = flowPathHighlightedConnections.filter(c => !baseIds.has(c.id));
    return extras.length > 0 ? [...base, ...extras] : base;
  }, [connectionsVisible, objectVisibleConnections, focusedConnections, highlightedFlowPathIds, flowPathHighlightedConnections]);

  // PERFORMANCE: Apply frustum culling to only render connections visible in camera
  const { visibleConnections: frustumCulledConnections } = useFrustumCulledConnections(
    connectionsForCulling,
    objects,
    true // Enable frustum culling
  );

  // ─── Progressive connection mounting ──────────────────────────────
  // Mirrors ObjectsRenderer's progressive mounting pattern:
  // Instead of rendering ALL frustum-culled connections in a single frame
  // (which overwhelms the GPU with pathfinding, buffer builds, text atlas
  // entries, and component mounting), we spread work across frames.
  //
  // Batched renderers (BatchedConnectionLines, BatchedCurvedLines) receive
  // only the progressively-mounted subset. Because they use instanced
  // single-draw-call rendering, incremental buffer growth is cheap.
  // ──────────────────────────────────────────────────────────────────
  const CONNECTION_MOUNT_BUDGET = 12;
  /** Reduced budget during camera movement — keep making progress without
   *  competing heavily with GPU rendering of the current frame. */
  const CONNECTION_MOUNT_BUDGET_MOVING = 2;
  /** Below this count, skip progressive mounting entirely (instant mount). */
  const CONNECTION_PROGRESSIVE_THRESHOLD = 120;
  /**
   * Above this many mounted connections, refuse to run the synchronous
   * checkLineIntersection fallback while the worker-precomputed cache is cold.
   * A cold full pass is O(connections × blocking objects) on the main thread —
   * the mid-import freeze.  The worker dispatch warms precomputedResults
   * asynchronously; once warm (workerWarmVersion bump) the full pass runs with
   * cheap cache hits.
   */
  const CONNECTION_SYNC_FALLBACK_LIMIT = 300;
  /**
   * How long the worker precompute effect waits after the bulk-import gate
   * clears before dispatching the settling batch of requests.
   */
  const DISPATCH_SETTLE_CHECK_MS = 500;
  const mountedConnIdsRef = useRef(new Set());
  const [mountedConnIds, setMountedConnIds] = useState(() => new Set());
  // Bumped after each pathfinding-worker batch populates the precomputed cache.
  // Lets the categorization memo re-run once the cache is warm so it can do the
  // full pass with cheap cache hits instead of the synchronous per-connection
  // O(objects) fallback (which the cold-set guard below suppresses).
  const [workerWarmVersion, setWorkerWarmVersion] = useState(0);
  // One-shot timer that fires the settling worker dispatch after the bulk-import
  // gate clears (streaming mounts make the object layout too volatile to bother).
  const dispatchSettleTimerRef = useRef(null);
  const pendingConnsRef = useRef([]);
  const connRafIdRef = useRef(null);
  // BUGFIX: Keep a ref to the latest frustum-culled set so the rAF callback
  // always checks against the CURRENT visible set, not a stale closure capture.
  const frustumCulledIdsRef = useRef(new Set());

  useEffect(() => {
    // Cancel any in-progress progressive mounting
    if (connRafIdRef.current) {
      cancelAnimationFrame(connRafIdRef.current);
      connRafIdRef.current = null;
    }

    const current = mountedConnIdsRef.current;
    const culledIds = new Set(frustumCulledConnections.map(c => c.id));
    // Update ref so rAF callback uses the latest set
    frustumCulledIdsRef.current = culledIds;

    // 1. Remove connections no longer in the frustum-culled set
    let removed = false;
    for (const id of current) {
      if (!culledIds.has(id)) {
        current.delete(id);
        removed = true;
      }
    }

    // 2. Find new connections to mount
    const toAdd = [];
    for (const conn of frustumCulledConnections) {
      if (!current.has(conn.id)) {
        toAdd.push(conn.id);
      }
    }

    // 3. If few enough, mount all at once (no need for batching)
    if (toAdd.length <= CONNECTION_MOUNT_BUDGET || culledIds.size <= CONNECTION_PROGRESSIVE_THRESHOLD) {
      toAdd.forEach(id => current.add(id));
      if (removed || toAdd.length > 0) {
        setMountedConnIds(new Set(current));
        const total = frustumCulledConnections.length;
        const mounted = current.size;
        useDiagramStore.getState().setConnectionsProgress(total, mounted);
      }
      return;
    }

    // 4. Many new connections — mount first batch immediately, rest over frames
    pendingConnsRef.current = toAdd;
    const firstBatch = pendingConnsRef.current.splice(0, CONNECTION_MOUNT_BUDGET);
    firstBatch.forEach(id => current.add(id));
    setMountedConnIds(new Set(current));
    // Report initial progress
    useDiagramStore.getState().setConnectionsProgress(frustumCulledConnections.length, current.size);

    const mountNextBatch = () => {
      const pending = pendingConnsRef.current;
      if (pending.length === 0) {
        connRafIdRef.current = null;
        return;
      }

      // Use the shared render budget — coordinate with ObjectsRenderer
      // PERF: Use a reduced budget during camera movement instead of blocking
      // completely — the old full-block caused connections to never mount in
      // large diagrams when orbit damping kept isCameraMoving() true.
      const isMoving = isCameraMoving();
      const budget = acquireBudget(isMoving ? CONNECTION_MOUNT_BUDGET_MOVING : CONNECTION_MOUNT_BUDGET);
      if (budget === 0) {
        // Entire frame budget consumed by other systems — try next frame
        connRafIdRef.current = requestAnimationFrame(mountNextBatch);
        return;
      }
      let added = 0;
      while (pending.length > 0 && added < budget) {
        const id = pending.shift();
        // BUGFIX: Use ref for latest frustum-culled set instead of stale closure
        if (frustumCulledIdsRef.current.has(id)) {
          mountedConnIdsRef.current.add(id);
          added++;
        }
      }

      if (added > 0) {
        setMountedConnIds(new Set(mountedConnIdsRef.current));
        const total = frustumCulledConnections.length;
        const mounted = mountedConnIdsRef.current.size;
        useDiagramStore.getState().setConnectionsProgress(total, mounted);
      }

      if (pending.length > 0) {
        connRafIdRef.current = requestAnimationFrame(mountNextBatch);
      } else {
        // All connections mounted - clear progress
        useDiagramStore.getState().setConnectionsProgress(frustumCulledConnections.length, frustumCulledConnections.length);
        connRafIdRef.current = null;
      }
    };

    connRafIdRef.current = requestAnimationFrame(mountNextBatch);

    return () => {
      if (connRafIdRef.current) {
        cancelAnimationFrame(connRafIdRef.current);
        connRafIdRef.current = null;
      }
    };
  }, [frustumCulledConnections]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (connRafIdRef.current) {
        cancelAnimationFrame(connRafIdRef.current);
      }
    };
  }, []);

  // Filter frustumCulledConnections to only the progressively mounted subset
  const progressiveConnections = useMemo(() => {
    if (mountedConnIds.size === 0) return [];
    // Fast path: if all connections are mounted, return the full array
    if (mountedConnIds.size >= frustumCulledConnections.length) {
      return frustumCulledConnections;
    }
    return frustumCulledConnections.filter(c => mountedConnIds.has(c.id));
  }, [frustumCulledConnections, mountedConnIds]);

  // PERFORMANCE: Build object positions map for batched rendering
  // NOTE: This uses object CENTER positions - connections store their face positions
  // BatchedConnectionLines uses connection.start/end.position for accurate face positions
  const objectPositions = useMemo(() => {
    const map = new Map();
    if (!objects?.length) return map;
    
    objects.forEach(obj => {
      if (obj?.id && obj?.position) {
        map.set(obj.id.toString(), obj.position);
      }
    });
    return map;
  }, [objects]);

  // PERFORMANCE: Cache intersection results to avoid running pathfinding every frame
  // Tracks previous pathfindingObjects reference to detect when any object position changed.
  // pathfindingObjects only gets a new reference when real positions change (the objectsStore
  // setObjects function guards against spurious updates via its own position hash check).
  const prevPathfindingObjectsRef = useRef(null);
  const lastCategorizationRef = useRef({ batchedConnections: [], textConnections: [], curvedConnections: [], individualConnections: [] });
  const lastCategorizationInputsRef = useRef({ progressiveConnectionsRef: null, selectedConnection: null, pathfindingObjectsRef: null, highlightedFlowPathIds: null });

  // NOTE: pathfindingHash was removed - it had 0.5-unit resolution which meant object moves
  // smaller than 0.5 units would never trigger cache invalidation. Since pathfindingObjects
  // already only changes when actual positions change (store hash guard), use it directly.

  // PERFORMANCE: Separate connections into categories for optimal rendering
  // - batchedConnections: straight lines without text/selection that don't intersect objects (single draw call)
  // - textConnections: straight lines with text only (batch lines + individual text sprites)
  // - curvedConnections: straight-style connections that need curved paths due to intersections (batched curved rendering)
  // - individualConnections: selected, non-straight styles (dashed/dotted), or those needing full UI
  const { batchedConnections, textConnections, curvedConnections, individualConnections } = useMemo(() => {
    const inputsRef = lastCategorizationInputsRef.current;
    const cacheRef = lastCategorizationRef.current;
    // Invalidation only: worker rounds bump this so a cold-set-guarded pass
    // re-runs (and correctly categorizes) once the precomputed cache is warm.
    void workerWarmVersion;

    // During bulk operations (repo scan), suppress expensive pathfinding.
    // Connections already have correct positions from createConnectionsFromDiagram.
    // Return cached results (or treat all as batched) to avoid O(C*N) blocking.
    // Also skip while the worker is computing — cache will be populated soon.
    // During bulk operations (repo scan / progressive import), suppress
    // expensive pathfinding.  bulkImportState covers the progressive-mount
    // pump without needing manual flag management at every entry point.
    //
    // HOWEVER: the selected connection and its flow-path siblings must ALWAYS
    // route to individualConnections so the yellow (selected) / orange
    // (flow-path highlighted) interactive lines render even while the mount
    // pump or pathfinding worker keeps this gate active.  Otherwise clicking a
    // connection in a large (e.g. 97k-object) scene never shows a highlight.
    //
    // COLD-SET GUARD: also stay on the fast path while the progressive set is
    // large AND the worker-precomputed cache is cold.  Falling through in that
    // state runs checkLineIntersection (O(objects) per connection) synchronously
    // for EVERY connection — a multi-hundred-ms main-thread block at ~30-50%
    // import progress.  hasPrecomputedPathCache() is true after the first worker
    // round lands (and is cleared by invalidatePathfindingCaches on real object
    // moves), and workerWarmVersion re-runs this memo once warm so the full pass
    // executes with cheap cache hits.
    if (
      window._connectionUpdateSkip ||
      bulkImportState.active ||
      isWorkerBusy() ||
      (progressiveConnections.length > CONNECTION_SYNC_FALLBACK_LIMIT &&
        !hasPrecomputedPathCache())
    ) {
      // Always surface the user-requested highlights regardless of bulk state.
      const highlightedSet = highlightedFlowPathIds;
      const highlighted = [];
      const deferred = [];
      for (const conn of (progressiveConnections || [])) {
        if (
          conn.id === selectedConnection ||
          (highlightedSet && highlightedSet.has(conn.id))
        ) {
          highlighted.push(conn);
        } else {
          deferred.push(conn);
        }
      }

      if (cacheRef.batchedConnections.length + cacheRef.textConnections.length + cacheRef.curvedConnections.length + cacheRef.individualConnections.length > 0) {
        if (highlighted.length === 0) {
          return cacheRef;
        }
        const baseIds = new Set(cacheRef.individualConnections.map(c => c.id));
        const extras = highlighted.filter(c => !baseIds.has(c.id));
        if (extras.length > 0) {
          return {
            ...cacheRef,
            individualConnections: [...cacheRef.individualConnections, ...extras],
          };
        }
        return cacheRef;
      }
      // No cache yet — treat non-highlighted as batched (straight lines,
      // no intersection checks), but always render highlighted individually.
      return {
        batchedConnections: deferred,
        textConnections: [],
        curvedConnections: [],
        individualConnections: highlighted,
      };
    }

    const objectsChanged = pathfindingObjects !== prevPathfindingObjectsRef.current;

    // True early exit: nothing at all changed
    if (
      !objectsChanged &&
      progressiveConnections === inputsRef.progressiveConnectionsRef &&
      selectedConnection === inputsRef.selectedConnection &&
      highlightedFlowPathIds === inputsRef.highlightedFlowPathIds &&
      cacheRef.batchedConnections.length + cacheRef.textConnections.length + cacheRef.curvedConnections.length + cacheRef.individualConnections.length > 0
    ) {
      return cacheRef;
    }

    // When any object position changed, clear all intersection caches so that
    // checkLineIntersection uses fresh geometry for the new object layout.
    // Both the module-level intersectionCache (keyed on start+end only, NOT blocking object
    // positions) and any cached path data must be wiped.
    if (objectsChanged) {
      invalidatePathfindingCaches();
      prevPathfindingObjectsRef.current = pathfindingObjects;
      if (window._debugPathfinding) {
        console.log(`[PathDebug] pathfindingObjects changed: ${pathfindingObjects.length} objects, ${progressiveConnections.length} connections to categorize`);
      }
    }

    const batched = [];
    const withText = [];
    const curved = [];
    const individual = [];

    // Build objectsById for face position resolution in categorization
    const catObjectsById = new Map();
    if (pathfindingObjects?.length) {
      for (const obj of pathfindingObjects) {
        if (obj?.id) catObjectsById.set(obj.id.toString(), obj);
      }
    }
    
    progressiveConnections.forEach(conn => {
      const style = conn.styleType || conn.lineStyle || 'straight';
      const baseStyle = style.split('-')[0];
      const isSelected = conn.id === selectedConnection;
      const isFlowPathHighlighted = !isSelected &&
        highlightedFlowPathIds?.size > 0 &&
        highlightedFlowPathIds.has(conn.id);
      const hasText = conn.text && conn.text.trim() !== '';
      
      // Selected connections need full UI (LineUI, etc)
      if (isSelected) {
        individual.push(conn);
        return;
      }

      // Flow-path-highlighted connections need individual rendering for colour override
      if (isFlowPathHighlighted) {
        individual.push(conn);
        return;
      }
      
      // Non-straight styles (dashed, dotted) need AnimatedConnectionLine
      if (baseStyle !== 'straight') {
        individual.push(conn);
        return;
      }
      
      // For straight-style connections, check if they need pathfinding (curve around obstacles)
      // BUGFIX: Use resolveEndpointPosition to compute face positions inline when
      // conn.start.position is not yet set, instead of falling back to object centers.
      let startPos = resolveEndpointPosition(conn.start, catObjectsById, pathfindingObjects);
      let endPos = resolveEndpointPosition(conn.end, catObjectsById, pathfindingObjects);
      
      // Check for intersections if we have valid positions and objects to check against.
      // computeConnectionPath checks the worker-precomputed cache first, then
      // falls back to synchronous checkLineIntersection (which has its own TTL cache).
      // Because we called invalidatePathfindingCaches() above when objects moved,
      // those caches are already cleared and the fresh blocking-object positions are used.
      let hasIntersection = false;
      if (startPos && endPos && pathfindingObjects && pathfindingObjects.length > 0) {
        const { hasIntersections } = computeConnectionPath(
          startPos, endPos, pathfindingObjects,
          conn.start?.objectId?.toString() || '',
          conn.end?.objectId?.toString() || ''
        );
        hasIntersection = hasIntersections;
        // DEBUG: Log intersection results for all connections when objects change
        if (objectsChanged && window._debugPathfinding) {
          console.log(`[PathDebug] conn ${conn.id} (${conn.start?.objectId}->${conn.end?.objectId}):`, {
            startPos: startPos?.map(v => v.toFixed(2)),
            endPos: endPos?.map(v => v.toFixed(2)),
            startPosSource: conn.start?.position ? 'position' : conn.start?.facePosition ? 'facePosition' : conn.start?.worldPosition ? 'worldPosition' : 'objectCenter',
            hasIntersection,
            bucket: hasIntersection ? (hasText ? 'individual' : 'curved') : (hasText ? 'withText' : 'batched'),
          });
        }
      } else if (objectsChanged && window._debugPathfinding) {
        console.log(`[PathDebug] conn ${conn.id} SKIPPED: startPos=${JSON.stringify(startPos)}, endPos=${JSON.stringify(endPos)}, pathfindingObjects.length=${pathfindingObjects?.length}`);
      }
      
      if (hasIntersection) {
        if (hasText) {
          individual.push(conn);
        } else {
          curved.push(conn);
        }
      } else if (hasText) {
        withText.push(conn);
      } else {
        batched.push(conn);
      }
    });
    
    const result = { 
      batchedConnections: batched, 
      textConnections: withText,
      curvedConnections: curved,
      individualConnections: individual 
    };
    if (objectsChanged && window._debugPathfinding) {
      console.log(`[PathDebug] Categorization result: batched=${batched.length}, curved=${curved.length}, withText=${withText.length}, individual=${individual.length}`);
    }
    lastCategorizationRef.current = result;
    lastCategorizationInputsRef.current = {
      progressiveConnectionsRef: progressiveConnections,
      selectedConnection,
      pathfindingObjectsRef: pathfindingObjects,
      highlightedFlowPathIds,
    };
    
    return result;
  }, [progressiveConnections, selectedConnection, highlightedFlowPathIds, objectPositions, pathfindingObjects, workerWarmVersion]);

  // WORKER: Fire-and-forget batch dispatch to the pathfinding Web Worker.
  // Populates a module-level precomputed cache that `computeConnectionPath`
  // checks on subsequent renders.  The promise resolution bumps
  // workerWarmVersion so the categorization memo (which depends on it) re-runs
  // and executes the full pass with warm cache hits.
  useEffect(() => {
    if (!progressiveConnections?.length || !pathfindingObjects?.length) return;

    const dispatchPrecompute = () => {
      // Build an objectId → obj map for resolving face positions.
      const pfObjectsById = new Map();
      for (const obj of pathfindingObjects) {
        if (obj?.id) pfObjectsById.set(obj.id.toString(), obj);
      }

      const requests = [];
      for (const conn of progressiveConnections) {
        const startPos = resolveEndpointPosition(conn.start, pfObjectsById, pathfindingObjects);
        const endPos = resolveEndpointPosition(conn.end, pfObjectsById, pathfindingObjects);
        if (!startPos || !endPos) continue;
        requests.push({
          id: conn.id,
          startPos: Array.isArray(startPos) ? startPos : [startPos.x, startPos.y, startPos.z],
          endPos:   Array.isArray(endPos)   ? endPos   : [endPos.x, endPos.y, endPos.z],
          startConnId: conn.start?.objectId?.toString() || '',
          endConnId:   conn.end?.objectId?.toString()   || '',
        });
      }

      if (requests.length === 0) return;

      const serializedObjects = pathfindingObjects.map(obj => ({
        id: obj.id,
        type: obj.type,
        position: obj.position,
        scale: obj.scale,
      }));

      // Serializing the whole object layout (above) is O(N) on the main thread
      // and results would be stale against a still-growing layout, so this path
      // mainly runs once mounting has settled (see the gate below).
      precomputePathsBatch(requests, serializedObjects).then(() => {
        setWorkerWarmVersion((v) => v + 1);
      });
    };

    // While the progressive-mount pump is streaming objects in, the layout is
    // too volatile to precompute against, and serializing all N objects per
    // flush would itself cost a synchronous O(N) block per store flush.  Skip
    // dispatch and arm a self-re-arming check to fire once the bulk-import gate
    // clears so the settled set still gets precomputed.
    if (bulkImportState.active) {
      if (dispatchSettleTimerRef.current === null) {
        const checkSettle = () => {
          dispatchSettleTimerRef.current = null;
          if (bulkImportState.active) {
            dispatchSettleTimerRef.current = setTimeout(checkSettle, DISPATCH_SETTLE_CHECK_MS);
          } else {
            dispatchPrecompute();
          }
        };
        dispatchSettleTimerRef.current = setTimeout(checkSettle, DISPATCH_SETTLE_CHECK_MS);
      }
      return;
    }

    // Steady-state: dispatch immediately.
    dispatchPrecompute();

    return () => {
      if (dispatchSettleTimerRef.current !== null) {
        clearTimeout(dispatchSettleTimerRef.current);
        dispatchSettleTimerRef.current = null;
      }
    };
  }, [progressiveConnections, pathfindingObjects]);

  // Combine all straight connections for batched line rendering
  const allStraightConnections = useMemo(() => {
    return [...batchedConnections, ...textConnections];
  }, [batchedConnections, textConnections]);

  // SOURCE-LEVEL FIX: Render-time face redistribution for ALL connections.
  // Connections sharing the same object+face (e.g. all using face='front' from
  // pre-fix Firestore data) get reassigned to different faces so their endpoints
  // differ, producing unique midpoints and preventing text stacking.
  // Computed once for all connections and applied to both textLabels and
  // individualConnections rendering paths.
  const faceOverrides = useMemo(() => {
    const objectsById = new Map();
    if (objects?.length) {
      for (const obj of objects) {
        if (obj?.id) objectsById.set(obj.id.toString(), obj);
      }
    }
    return redistributeFaces(progressiveConnections, objectsById);
  }, [progressiveConnections, objects]);

  // PERFORMANCE: Pre-calculate text positions for connections with text
  // SOURCE-LEVEL FIX: Two mechanisms prevent text stacking:
  //   1. Render-time face redistribution — connections sharing the same
  //      object+face get reassigned to different faces so their endpoints
  //      (and therefore their midpoints) differ.
  //   2. Parametric t-positioning — even after redistribution, use a
  //      per-connection hash to pick a unique position along the line.
  const textLabels = useMemo(() => {
    // Build an objectId → object lookup for inline face position calculation
    const objectsById = new Map();
    if (objects?.length) {
      for (const obj of objects) {
        if (obj?.id) objectsById.set(obj.id.toString(), obj);
      }
    }

    return textConnections.map(conn => {
      // Apply face overrides if this connection was reassigned
      const overrides = faceOverrides.get(conn.id);
      const startData = overrides?.startFace !== undefined
        ? { ...conn.start, face: overrides.startFace }
        : conn.start;
      const endData = overrides?.endFace !== undefined
        ? { ...conn.end, face: overrides.endFace }
        : conn.end;

      const startPos = resolveEndpointPosition(startData, objectsById, objects);
      const endPos = resolveEndpointPosition(endData, objectsById, objects);
      
      if (!startPos || !endPos) return null;
      
      // Handle both array [x,y,z] and object {x,y,z} formats
      const sx = Array.isArray(startPos) ? startPos[0] : startPos.x;
      const sy = Array.isArray(startPos) ? startPos[1] : startPos.y;
      const sz = Array.isArray(startPos) ? startPos[2] : startPos.z;
      const ex = Array.isArray(endPos) ? endPos[0] : endPos.x;
      const ey = Array.isArray(endPos) ? endPos[1] : endPos.y;
      const ez = Array.isArray(endPos) ? endPos[2] : endPos.z;
      
      // Skip if any coordinate is invalid
      if (isNaN(sx) || isNaN(sy) || isNaN(sz) || isNaN(ex) || isNaN(ey) || isNaN(ez)) return null;
      
      // Parametric text position — unique per connection ID
      const t = getTextParametricT(conn.id);
      const position = [
        sx + (ex - sx) * t,
        sy + (ey - sy) * t + 2, // Offset above line
        sz + (ez - sz) * t,
      ];
      
      return {
        id: conn.id,
        text: conn.text,
        position,
        textStyle: conn.textStyle,
      };
    }).filter(Boolean);
  }, [textConnections, objects, faceOverrides]);

  // Handle connection click from batched renderer
  const handleBatchedConnectionClick = useCallback((e, connectionId) => {
    e.stopPropagation();
    if (onConnectionClick) {
      onConnectionClick(e, connectionId);
    } else {
      // Use selectConnectionWithFlowPath so flow path siblings are highlighted
      const { selectConnectionWithFlowPath } = useConnectionStore.getState();
      if (selectConnectionWithFlowPath) {
        selectConnectionWithFlowPath(connectionId);
      }
    }
  }, [onConnectionClick]);

  // Render connections with batched optimization
  return (
    <group>
      {/* PERFORMANCE: Render ALL straight connections (with or without text) in ONE draw call */}
      {allStraightConnections.length > 0 && (
        <BatchedConnectionLines
          connections={allStraightConnections}
          objectPositions={objectPositions}
          selectedConnectionId={selectedConnection}
          onConnectionClick={handleBatchedConnectionClick}
          lineWidth={1}
        />
      )}
      
      {/* PERFORMANCE: Render curved connections (intersecting objects) in ONE draw call */}
      {curvedConnections.length > 0 && (
        <BatchedCurvedLines
          connections={curvedConnections}
          objectPositions={objectPositions}
          pathfindingObjects={pathfindingObjects}
          selectedConnectionId={selectedConnection}
          onConnectionClick={handleBatchedConnectionClick}
          lineWidth={1}
        />
      )}

      {/* Merfolk arrowheads — instanced cones for arrow-decorated connections,
          LOD-gated to FULL endpoint detail */}
      <ConnectionArrowheads
        connections={progressiveConnections}
        objects={objects}
      />
      
      {/* PERFORMANCE: Render text labels with distance filtering - only visible within 500 units */}
      <DistanceFilteredTextLabels
        labels={textLabels}
        maxDistance={500}
        onLabelClick={onLineTextClick}
      />
      
      {/* Render individual connections that need special handling (selected, dashed/dotted, with text on curves) */}
      {individualConnections.map((connection) => {
        // SOURCE-LEVEL FIX: Apply face redistribution to individual connections
        // so that connections sharing the same object+face get different endpoints
        const overrides = faceOverrides.get(connection.id);
        const effectiveConnection = overrides
          ? {
              ...connection,
              ...(overrides.startFace !== undefined && {
                start: { ...connection.start, face: overrides.startFace },
              }),
              ...(overrides.endFace !== undefined && {
                end: { ...connection.end, face: overrides.endFace },
              }),
            }
          : connection;
        return (
          <Connection
            key={connection.id}
            connection={effectiveConnection}
            allObjectsForPathfinding={pathfindingObjects}
            onLineStyleChange={onLineStyleChange}
            onLineColorChange={onLineColorChange}
            onConnectionClick={onConnectionClick}
            onLineTextClick={onLineTextClick}
            onLineTextSubmit={onLineTextSubmit}
            onLineTextStyleChange={onLineTextStyleChange}
            selectedConnection={selectedConnection}
            objectsPositionHash={objectsPositionHash}
          />
        );
      })}
    </group>
  );
};

// Wrap in React.memo with custom comparison to prevent unnecessary re-renders
export default React.memo(ConnectionsRenderer, (prevProps, nextProps) => {
  // Only re-render if these specific props change
  return (
    prevProps.objects === nextProps.objects &&
    prevProps.visibleObjectIds === nextProps.visibleObjectIds &&
    prevProps.onLineStyleChange === nextProps.onLineStyleChange &&
    prevProps.onLineColorChange === nextProps.onLineColorChange &&
    prevProps.onConnectionClick === nextProps.onConnectionClick &&
    prevProps.onLineTextClick === nextProps.onLineTextClick &&
    prevProps.onLineTextSubmit === nextProps.onLineTextSubmit &&
    prevProps.onLineTextStyleChange === nextProps.onLineTextStyleChange
  );
});
