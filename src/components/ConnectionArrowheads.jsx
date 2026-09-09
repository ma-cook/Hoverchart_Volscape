import React, { useMemo, useRef, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import useLODStore from '../stores/lodStore';
import { LOD_LEVELS } from '../stores/lodStore';
import { calculateFacePosition } from '../utils/facePositionUtils';

const CONE_HEIGHT = 5;
const CONE_RADIUS = 2;
const Y_AXIS = new THREE.Vector3(0, 1, 0);

// Shared scratch objects — never allocate in the frame loop
const _dummy = new THREE.Object3D();
const _dir = new THREE.Vector3();
const _color = new THREE.Color();

/**
 * Resolve a connection endpoint's current world position with the same
 * precedence as ConnectionsRenderer.resolveEndpointPosition: live face
 * computation → stored position → object centre.
 */
function resolveEndpointPosition(endpointData, objectsById, objects) {
  if (!endpointData) return null;

  const objId = endpointData.objectId?.toString();

  // 1. Has face data + object available → compute fresh position from geometry
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
  const stored =
    endpointData.position ||
    endpointData.facePosition ||
    endpointData.worldPosition;
  if (stored) return stored;

  // 3. Object centre (last resort)
  if (!objId) return null;
  const obj = objectsById.get(objId);
  return obj?.position || null;
}

/**
 * Render 3D cone arrowheads for connections that carry per-end `arrowStart` /
 * `arrowEnd` merfolk decorations.
 *
 * Arrowheads are instanced (one draw call for all of them), coloured per
 * connection, and only drawn when BOTH endpoints are at FULL LOD (or LOD is
 * disabled) so the cones don't swim in the distance.
 *
 * Uses the same endpoint resolution as the line renderers, so arrowheads track
 * the batched/curved lines exactly.
 */
function ConnectionArrowheads({ connections, objects }) {
  const meshRef = useRef();

  const lodEnabled = useLODStore((s) => s.lodEnabled);
  const lodVersion = useLODStore((s) => s._lodVersion);
  const lodLevels = useLODStore((s) => s.lodLevels);

  // Build the raw arrowhead request list (stable per connections/objects input).
  const arrows = useMemo(() => {
    if (!connections?.length || !objects?.length) return [];

    const objectsById = new Map();
    for (const obj of objects) {
      if (obj?.id) objectsById.set(obj.id.toString(), obj);
    }

    const result = [];
    for (const conn of connections) {
      const startObjId = conn.start?.objectId?.toString();
      const endObjId = conn.end?.objectId?.toString();
      if (!startObjId || !endObjId) continue;

      const startPos = resolveEndpointPosition(conn.start, objectsById, objects);
      const endPos = resolveEndpointPosition(conn.end, objectsById, objects);
      if (!startPos || !endPos) continue;

      const sx = Array.isArray(startPos) ? startPos[0] : startPos.x;
      const sy = Array.isArray(startPos) ? startPos[1] : startPos.y;
      const sz = Array.isArray(startPos) ? startPos[2] : startPos.z;
      const ex = Array.isArray(endPos) ? endPos[0] : endPos.x;
      const ey = Array.isArray(endPos) ? endPos[1] : endPos.y;
      const ez = Array.isArray(endPos) ? endPos[2] : endPos.z;
      if (
        isNaN(sx) || isNaN(sy) || isNaN(sz) ||
        isNaN(ex) || isNaN(ey) || isNaN(ez)
      ) {
        continue;
      }

      const color = conn.color || conn.visual?.color || '#888888';

      if (conn.arrowEnd) {
        result.push({
          startId: startObjId,
          endId: endObjId,
          tip: [ex, ey, ez],
          tail: [sx, sy, sz],
          color,
        });
      }
      // Reverse direction: arrow at the START points INTO the source object.
      if (conn.arrowStart) {
        result.push({
          startId: startObjId,
          endId: endObjId,
          tip: [sx, sy, sz],
          tail: [ex, ey, ez],
          color,
        });
      }
    }
    return result;
  }, [connections, objects]);

  // LOD gate: only keep arrowheads whose endpoint objects are FULL LOD when LOD
  // is active. lodVersion bump (in-place Map mutation) forces a recompute.
  const visibleArrows = useMemo(() => {
    if (arrows.length === 0) return arrows;
    if (!lodEnabled) return arrows;

    return arrows.filter((a) => {
      const sLod = lodLevels.get(a.startId) ?? LOD_LEVELS.FULL;
      const eLod = lodLevels.get(a.endId) ?? LOD_LEVELS.FULL;
      return sLod === LOD_LEVELS.FULL && eLod === LOD_LEVELS.FULL;
    });
    // lodVersion is an intentional mutation trigger — the LOD store bumps it
    // when the lodLevels Map is updated in-place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrows, lodEnabled, lodVersion, lodLevels]);

  // Don't intercept raycasts — line clicks are handled by the line renderers.
  useEffect(() => {
    if (meshRef.current) {
      meshRef.current.raycast = () => null;
    }
  }, [visibleArrows.length]);

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const count = visibleArrows.length;
    // three (r152+) resizes instanceMatrix automatically in setMatrixAt, and
    // R3F recreates the InstancedMesh when `args` capacity changes, so no
    // manual capacity guard is needed here.
    mesh.count = count;

    for (let i = 0; i < count; i++) {
      const a = visibleArrows[i];
      _dir.set(
        a.tip[0] - a.tail[0],
        a.tip[1] - a.tail[1],
        a.tip[2] - a.tail[2]
      ).normalize();

      // Cone geometry: tip at +y, base at -y. Centre the cone so its TIP lands
      // exactly on the endpoint, with +Y pointing along the connection line.
      _dummy.position.set(
        a.tip[0] - _dir.x * (CONE_HEIGHT / 2),
        a.tip[1] - _dir.y * (CONE_HEIGHT / 2),
        a.tip[2] - _dir.z * (CONE_HEIGHT / 2)
      );
      _dummy.quaternion.setFromUnitVectors(Y_AXIS, _dir);
      _dummy.scale.set(1, 1, 1);
      _dummy.updateMatrix();
      mesh.setMatrixAt(i, _dummy.matrix);
      if (mesh.instanceColor) {
        mesh.setColorAt(i, _color.set(a.color));
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) {
      mesh.instanceColor.needsUpdate = true;
    }
  });

  if (visibleArrows.length === 0) return null;

  return (
    <instancedMesh
      ref={meshRef}
      args={[null, null, Math.max(arrows.length, 1)]}
      frustumCulled={false}
    >
      <coneGeometry args={[CONE_RADIUS, CONE_HEIGHT, 12]} />
      <meshBasicMaterial toneMapped={false} transparent opacity={1} />
    </instancedMesh>
  );
}

export default React.memo(ConnectionArrowheads);