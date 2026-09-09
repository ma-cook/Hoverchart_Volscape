import { api } from '../../api-client';
import importPerf from '../../utils/importPerf';
import useConnectionStore from '../../stores/connectionStore';
import { useObjectsStore, useSpatialManagerStore } from '../../stores';
import {
  pauseConnectionListeners,
  resumeConnectionListeners,
} from '../connectionsService';
import {
  bulkSaveConnectionsBatch,
  getCellCoordinates,
  getCellId,
} from '../spatialPartitioning';

export const connectionMethods = {
  parseFlowPaths(content) {
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
        .split(/\s*(?:<-->|<--|-->|-.->|-\.->|===+>|--[^>]*>|--)\s*/)
        .map(n => n.trim())
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
      const tags = (match[3].match(/#(\w+)/g) || []).map(t => t.slice(1));
      tags.forEach(tag => addTag(srcId, tgtId, tag));
    }

    return connectionTags;
  },

  stripFlowPathSyntax(content) {
    return content.replace(/^[ \t]*flowpath\b[^\n]*/gm, '');
  },

  async createConnectionsFromDiagram(
    diagram,
    nodeToObjectIdMap,
    allConnectionsToSave,
    connectionTags = new Map(),
    nodeDataMap = null
  ) {
    const graph = diagram.graph;
    if (!graph || !graph.connections) {
      return;
    }

    const existingConnections = useConnectionStore.getState().connections;
    const existingConnectionPairs = new Set();
    for (let i = 0; i < existingConnections.length; i++) {
      const conn = existingConnections[i];
      const sId = conn.start?.objectId;
      const eId = conn.end?.objectId;
      if (sId && eId) {
        existingConnectionPairs.add(`${sId}|${eId}`);
      }
    }

    const objectsById = new Map(
      useObjectsStore.getState().objects.map(obj => [obj.id, obj])
    );

    const connectionsArray = Array.from(graph.connections.values());
    const CONN_YIELD_EVERY = 100;

    for (let ci = 0; ci < connectionsArray.length; ci++) {
      const connection = connectionsArray[ci];
      const sourceNodeId = connection.source?.nodeId || connection.source;
      const targetNodeId = connection.target?.nodeId || connection.target;

      const sourceObjectId = nodeToObjectIdMap.get(sourceNodeId);
      const targetObjectId = nodeToObjectIdMap.get(targetNodeId);

      if (
        sourceObjectId &&
        targetObjectId &&
        sourceObjectId !== targetObjectId
      ) {
        if (existingConnectionPairs.has(`${sourceObjectId}|${targetObjectId}`)) {
          continue;
        }

        let connectionText = '';
        if (connection.visual?.label?.text) {
          connectionText = connection.visual.label.text;
        } else if (connection.label) {
          connectionText = connection.label;
        } else if (connection.text) {
          connectionText = connection.text;
        }

        const connectionId = `merfolk-conn-${Date.now()}-${Math.random()
          .toString(36)
          .substr(2, 9)}`;

        let sourceObject, targetObject;
        if (nodeDataMap && nodeDataMap.has(sourceNodeId) && nodeDataMap.has(targetNodeId)) {
          sourceObject = nodeDataMap.get(sourceNodeId);
          targetObject = nodeDataMap.get(targetNodeId);
        } else {
          sourceObject = objectsById.get(sourceObjectId);
          targetObject = objectsById.get(targetObjectId);
        }

        if (!sourceObject || !targetObject) {
          continue;
        }

        const CUBE_FACES = ['front', 'back', 'left', 'right', 'top', 'bottom'];
        const TETRAHEDRON_FACES = ['front', 'left', 'right', 'bottom'];
        const OCTAHEDRON_FACES = ['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7'];

        const getFaceForObject = (objectId, objectType, isSource) => {
          const key = `${objectId}_${isSource ? 'source' : 'target'}`;

          if (!window._faceDistributionCounters) {
            window._faceDistributionCounters = new Map();
          }

          const currentCount = window._faceDistributionCounters.get(key) || 0;
          window._faceDistributionCounters.set(key, currentCount + 1);

          if (objectType === 'dodecahedron') {
            return currentCount % 12;
          } else if (objectType === 'tetrahedron') {
            return TETRAHEDRON_FACES[currentCount % TETRAHEDRON_FACES.length];
          } else if (objectType === 'octahedron') {
            return OCTAHEDRON_FACES[currentCount % OCTAHEDRON_FACES.length];
          } else if (objectType === 'sphere') {
            // Spheres connect from their centre — a single implicit "surface" face.
            return 'center';
          } else {
            return CUBE_FACES[currentCount % CUBE_FACES.length];
          }
        };

        const computeFaceWorldPosition = (objectPosition, objectScale, faceName, objectType) => {
          const pos = [...objectPosition];
          const s = objectScale || [1, 1, 1];
          const cubeSize = 5;

          if (objectType === 'sphere') {
            return pos;
          }

          if (objectType === 'tetrahedron') {
            const TETRA_SIZE = 5;
            const v = [
              [0, TETRA_SIZE, 0],
              [-TETRA_SIZE, -TETRA_SIZE, TETRA_SIZE],
              [TETRA_SIZE, -TETRA_SIZE, TETRA_SIZE],
              [0, -TETRA_SIZE, -TETRA_SIZE * 1.5],
            ];
            let fc;
            switch (faceName) {
              case 'bottom': fc = [(v[1][0]+v[2][0]+v[3][0])/3, (v[1][1]+v[2][1]+v[3][1])/3, (v[1][2]+v[2][2]+v[3][2])/3]; break;
              case 'front':  fc = [(v[0][0]+v[2][0]+v[1][0])/3, (v[0][1]+v[2][1]+v[1][1])/3, (v[0][2]+v[2][2]+v[1][2])/3]; break;
              case 'left':   fc = [(v[0][0]+v[1][0]+v[3][0])/3, (v[0][1]+v[1][1]+v[3][1])/3, (v[0][2]+v[1][2]+v[3][2])/3]; break;
              case 'right':  fc = [(v[0][0]+v[3][0]+v[2][0])/3, (v[0][1]+v[3][1]+v[2][1])/3, (v[0][2]+v[3][2]+v[2][2])/3]; break;
              default:       fc = [0, 0, 0];
            }
            return [pos[0] + fc[0] * s[0], pos[1] + fc[1] * s[1], pos[2] + fc[2] * s[2]];
          } else if (objectType === 'octahedron') {
            const OCTA_SIZE = 5;
            const ov = [
              [0, OCTA_SIZE, 0],
              [OCTA_SIZE, 0, 0],
              [0, 0, OCTA_SIZE],
              [-OCTA_SIZE, 0, 0],
              [0, 0, -OCTA_SIZE],
              [0, -OCTA_SIZE, 0],
            ];
            const octaFaceVertices = {
              f0: [ov[0], ov[1], ov[2]],
              f1: [ov[0], ov[2], ov[3]],
              f2: [ov[0], ov[3], ov[4]],
              f3: [ov[0], ov[4], ov[1]],
              f4: [ov[5], ov[2], ov[1]],
              f5: [ov[5], ov[3], ov[2]],
              f6: [ov[5], ov[4], ov[3]],
              f7: [ov[5], ov[1], ov[4]],
            };
            const fv = octaFaceVertices[faceName] || [ov[0], ov[1], ov[2]];
            const fc = [(fv[0][0]+fv[1][0]+fv[2][0])/3, (fv[0][1]+fv[1][1]+fv[2][1])/3, (fv[0][2]+fv[1][2]+fv[2][2])/3];
            return [pos[0] + fc[0] * s[0], pos[1] + fc[1] * s[1], pos[2] + fc[2] * s[2]];
          }

          switch (faceName) {
            case 'front':  return [pos[0], pos[1], pos[2] + cubeSize * s[2]];
            case 'back':   return [pos[0], pos[1], pos[2] - cubeSize * s[2]];
            case 'left':   return [pos[0] - cubeSize * s[0], pos[1], pos[2]];
            case 'right':  return [pos[0] + cubeSize * s[0], pos[1], pos[2]];
            case 'top':    return [pos[0], pos[1] + cubeSize * s[1], pos[2]];
            case 'bottom': return [pos[0], pos[1] - cubeSize * s[1], pos[2]];
            default:       return pos;
          }
        };

        let sourceFaceIndex, targetFaceIndex;
        let sourceWorldPosition, targetWorldPosition;

        sourceFaceIndex = getFaceForObject(sourceObjectId, sourceObject.type, true);
        targetFaceIndex = getFaceForObject(targetObjectId, targetObject.type, false);

        if (sourceObject.type === 'dodecahedron') {
          sourceWorldPosition = [...sourceObject.position];
        } else {
          sourceWorldPosition = computeFaceWorldPosition(
            sourceObject.position, sourceObject.scale, sourceFaceIndex, sourceObject.type
          );
        }

        if (targetObject.type === 'dodecahedron') {
          targetWorldPosition = [...targetObject.position];
        } else {
          targetWorldPosition = computeFaceWorldPosition(
            targetObject.position, targetObject.scale, targetFaceIndex, targetObject.type
          );
        }

        const calculateDodecahedronFaceCenter = (faceIndex) => {
          const phi = (1 + Math.sqrt(5)) / 2;
          const scale = 5;

          const vertices = [
            [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
            [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
            [0, -phi, -1 / phi], [0, phi, -1 / phi], [0, phi, 1 / phi], [0, -phi, 1 / phi],
            [-1 / phi, 0, -phi], [1 / phi, 0, -phi], [1 / phi, 0, phi], [-1 / phi, 0, phi],
            [-phi, -1 / phi, 0], [-phi, 1 / phi, 0], [phi, 1 / phi, 0], [phi, -1 / phi, 0],
          ];

          const faces = [
            [0, 12, 13, 1, 8], [0, 16, 17, 3, 12], [0, 8, 11, 4, 16], [1, 19, 5, 11, 8],
            [1, 13, 2, 18, 19], [2, 13, 12, 3, 9], [2, 9, 10, 6, 18], [3, 17, 7, 10, 9],
            [4, 11, 5, 14, 15], [4, 15, 7, 17, 16], [5, 19, 18, 6, 14], [6, 10, 7, 15, 14],
          ];

          if (faceIndex < 0 || faceIndex >= faces.length) {
            return [0, 0, 0];
          }

          const faceVertices = faces[faceIndex];
          const positions = [];

          for (const vertexIndex of faceVertices) {
            const vertex = vertices[vertexIndex];
            positions.push(vertex[0] * scale, vertex[1] * scale, vertex[2] * scale);
          }

          let centerX = 0, centerY = 0, centerZ = 0;
          for (let i = 0; i < positions.length; i += 3) {
            centerX += positions[i];
            centerY += positions[i + 1];
            centerZ += positions[i + 2];
          }
          const vertexCount = positions.length / 3;

          return [centerX / vertexCount, centerY / vertexCount, centerZ / vertexCount];
        };

        if (sourceObject.type === 'dodecahedron') {
          const fc = calculateDodecahedronFaceCenter(sourceFaceIndex);
          const s = sourceObject.scale || [1, 1, 1];
          sourceWorldPosition = [
            sourceObject.position[0] + fc[0] * s[0],
            sourceObject.position[1] + fc[1] * s[1],
            sourceObject.position[2] + fc[2] * s[2],
          ];
        }
        if (targetObject.type === 'dodecahedron') {
          const fc = calculateDodecahedronFaceCenter(targetFaceIndex);
          const s = targetObject.scale || [1, 1, 1];
          targetWorldPosition = [
            targetObject.position[0] + fc[0] * s[0],
            targetObject.position[1] + fc[1] * s[1],
            targetObject.position[2] + fc[2] * s[2],
          ];
        }

        const connectionData = {
          id: connectionId,
          start: {
            objectId: sourceObjectId,
            type: sourceObject.type === 'dodecahedron' ? 'dodecahedron' : sourceObject.type || 'cube',
            face: sourceFaceIndex,
            position: sourceWorldPosition,
            ...(sourceObject.type === 'dodecahedron' && {
              faceCenter: calculateDodecahedronFaceCenter(sourceFaceIndex),
            }),
            cube: {
              id: sourceObjectId,
              position: [...sourceObject.position],
              scale: sourceObject.scale || [1, 1, 1],
              userData: { objectId: sourceObjectId },
            },
            id: sourceObjectId,
          },
          end: {
            objectId: targetObjectId,
            type: targetObject.type === 'dodecahedron' ? 'dodecahedron' : targetObject.type || 'cube',
            face: targetFaceIndex,
            position: targetWorldPosition,
            ...(targetObject.type === 'dodecahedron' && {
              faceCenter: calculateDodecahedronFaceCenter(targetFaceIndex),
            }),
            cube: {
              id: targetObjectId,
              position: [...targetObject.position],
              scale: targetObject.scale || [1, 1, 1],
              userData: { objectId: targetObjectId },
            },
            id: targetObjectId,
          },
          text: connectionText,
          color: connection.visual?.color || '#888888',
          thickness: connection.visual?.thickness || 2,
          textStyle: { fontSize: 4, color: 'black' },
          cellId: (() => {
            const coords = getCellCoordinates(sourceWorldPosition);
            return getCellId(coords.x, coords.y, coords.z);
          })(),
          merfolkData: {
            sourceNode: sourceNodeId,
            targetNode: targetNodeId,
            connectionType: connection.type,
            arrowStart: !!connection.arrowStart,
            arrowEnd: !!connection.arrowEnd,
            flowPaths: Array.from(
              connectionTags.get(`${sourceNodeId}|${targetNodeId}`) || []
            ),
          },
        };

        allConnectionsToSave.push(connectionData);
      }

      if (ci % CONN_YIELD_EVERY === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    }
  },

  async saveConnections(
    allConnectionsToSave,
    currentSpaceId,
    user,
    allObjectsToSave = []
  ) {
    if (allConnectionsToSave.length === 0 && allObjectsToSave.length === 0)
      return Promise.resolve();

    const connectionStore = useConnectionStore.getState();

    try {
      importPerf.mark(`saveConnections: bulkAdd begin (${allConnectionsToSave.length} conns total)`);
      const _tBulk = performance.now();
      // Only hydrate connections whose cell is currently loaded.  Connections
      // in distant cells are still persisted to the DB (allConnectionsToSave)
      // and are fetched + added by the per-cell subscription when the user
      // navigates to them — matching the refresh path and avoiding mounting
      // the whole connection set in one go.
      const loadedCellIds = useSpatialManagerStore.getState().loadedCells;
      const storeConnections =
        loadedCellIds && loadedCellIds.size > 0
          ? allConnectionsToSave.filter((conn) => conn.cellId && loadedCellIds.has(conn.cellId))
          : allConnectionsToSave;
      if (storeConnections.length > 0) {
        connectionStore.bulkAddConnections(storeConnections);
      }
      importPerf.mark(`saveConnections: bulkAdd done in ${Math.round(performance.now() - _tBulk)}ms`);
    } catch (error) {
      console.error('Failed to bulk add connections to store:', error);
    }

    if (!user || !currentSpaceId) {
      return Promise.resolve();
    }

    return this._cloudFunctionBulkImport(
      allConnectionsToSave,
      currentSpaceId,
      user,
      allObjectsToSave
    );
  },

  async _cloudFunctionBulkImport(
    allConnectionsToSave,
    currentSpaceId,
    user,
    allObjectsToSave = []
  ) {
    const deriveCellCoords = (obj) => {
      if (obj.cell_x !== undefined && obj.cell_y !== undefined && obj.cell_z !== undefined) return obj;
      if (obj.cell_id) {
        const parts = obj.cell_id.split(',').map(Number);
        if (parts.length >= 3 && parts.every(n => !isNaN(n))) {
          obj.cell_x = parts[0];
          obj.cell_y = parts[1];
          obj.cell_z = parts[2];
        }
      }
      return obj;
    };

    const _startTime = performance.now();

    try {
      const objects = allObjectsToSave.map((obj) =>
        deriveCellCoords({
          id: obj.id,
          cell_id: obj.cellId,
          position: obj.position,
          type: obj.type,
          color: obj.color,
          content: obj.content || '',
          scale: obj.scale || [1, 1, 1],
          rotation: obj.rotation || [0, 0, 0],
          header_text: obj.headerText,
          metadata: {
            ...(obj.size && { size: obj.size }),
            ...(obj.textStyle && { textStyle: obj.textStyle }),
            ...(obj.headerStyle && { headerStyle: obj.headerStyle }),
            ...(obj.faceColors && { faceColors: obj.faceColors }),
            ...(obj.faceTexts && { faceTexts: obj.faceTexts }),
            ...(obj.faceTextStyles && { faceTextStyles: obj.faceTextStyles }),
            ...(obj.lineColor && { lineColor: obj.lineColor }),
            ...(obj.borderStyle && { borderStyle: obj.borderStyle }),
            ...(obj.borderColor && { borderColor: obj.borderColor }),
            ...(obj.lineThickness && { lineThickness: obj.lineThickness }),
            ...(obj.merfolkData && { merfolkData: obj.merfolkData }),
          },
        })
      );

      const connections = allConnectionsToSave.map((conn) => {
        const start = conn.start || {
          objectId: conn.from?.objectId || conn.from?.id,
          type: conn.from?.type,
          face: conn.from?.face,
          position: conn.from?.position,
        };
        const end = conn.end || {
          objectId: conn.to?.objectId || conn.to?.id,
          type: conn.to?.type,
          face: conn.to?.face,
          position: conn.to?.position,
        };
        return deriveCellCoords({
          id: conn.id,
          cell_id: conn.cellId,
          start_obj: start.objectId,
          end_obj: end.objectId,
          start_data: start,
          end_data: end,
          line_style: conn.type || 'straight',
          color: conn.color || '#000000',
          text: conn.text,
          metadata: {
            ...(conn.thickness && { thickness: conn.thickness }),
            ...(conn.textStyle && { textStyle: conn.textStyle }),
            ...(conn.curvedPath && { curvedPath: conn.curvedPath.map(p => Array.isArray(p) ? [...p] : p) }),
            ...(conn.merfolkData && { merfolkData: conn.merfolkData }),
          },
        });
      });

      const MAX_PAYLOAD_SIZE = 9 * 1024 * 1024;

      importPerf.mark(`bulkImport: serializing ${objects.length} objects + ${connections.length} connections`);
      // Serialize once per item so chunk sizing is exact (no re-serialization).
      const serializedObjects = objects.map((o) => JSON.stringify(o));
      const serializedConnections = connections.map((c) => JSON.stringify(c));
      importPerf.mark('bulkImport: serialization done');
      const spaceIdOverhead = JSON.stringify({
        spaceId: currentSpaceId,
        objects: [],
        connections: [],
      }).length;

      const objectsTotal = serializedObjects.reduce(
        (s, j) => s + j.length,
        0
      );
      const connectionsTotal = serializedConnections.reduce(
        (s, j) => s + j.length,
        0
      );

      async function postChunk(objSlice, connSlice, index, total) {
        const chunkPayload = {
          spaceId: currentSpaceId,
          objects: objSlice,
          connections: connSlice,
        };
        if (total > 1) {
          console.log(
            `📡 [BulkImport] Sending chunk ${index}/${total} (${objSlice.length} objects, ${connSlice.length} connections)`
          );
        }
        // PERF: api-client stringifies non-string bodies; passing the payload
        // pre-serialized here would double-encode it, so send the object and
        // let the client do the single JSON.stringify pass.
        return api.post('/api/bulk/import', chunkPayload);
      }

      // Fast path: everything fits in a single request.
      // (Add one byte per item for the JSON array separators so a payload at
      // the limit can't overshoot the cloud-function boundary.)
      if (
        spaceIdOverhead + objectsTotal + connectionsTotal +
          serializedObjects.length + serializedConnections.length <=
        MAX_PAYLOAD_SIZE
      ) {
        return postChunk(objects, connections, 1, 1);
      }

      // Large scan: the full objects payload would exceed the API limit.
      // Previously this fell back to a connections-only save, silently dropping
      // every object — after a refresh the diagram was empty.  Instead, pack
      // objects into size-bounded chunks (leaving headroom for connections)
      // and distribute connections across them.
      const MAX_OBJECTS_PER_CHUNK = Math.floor(MAX_PAYLOAD_SIZE * 0.75);
      const chunks = [];
      let objChunk = [];
      let objChunkSize = 0;
      for (let i = 0; i < objects.length; i++) {
        const size = serializedObjects[i].length;
        if (objChunk.length > 0 && objChunkSize + size > MAX_OBJECTS_PER_CHUNK) {
          chunks.push({ objects: objChunk, connections: [], objectsSize: objChunkSize });
          objChunk = [];
          objChunkSize = 0;
        }
        objChunk.push(objects[i]);
        objChunkSize += size;
      }
      if (objChunk.length > 0) {
        chunks.push({ objects: objChunk, connections: [], objectsSize: objChunkSize });
      }

      // Greedily fill each object chunk with as many connections as fit.
      let connIdx = 0;
      for (const chunk of chunks) {
        if (connIdx >= connections.length) break;
        // PERF: reuse the size computed while packing — re-running
        // JSON.stringify over every object here was a full extra
        // serialization pass across the whole payload.
        let used = spaceIdOverhead + chunk.objectsSize;
        while (
          connIdx < connections.length &&
          used + serializedConnections[connIdx].length <= MAX_PAYLOAD_SIZE
        ) {
          used += serializedConnections[connIdx].length;
          chunk.connections.push(connections[connIdx]);
          connIdx++;
        }
      }

      // Any connections left over (e.g. a very wide connection set) go into
      // their own connection-only chunks.
      while (connIdx < connections.length) {
        const chunk = { objects: [], connections: [] };
        let used = spaceIdOverhead;
        while (
          connIdx < connections.length &&
          used + serializedConnections[connIdx].length <= MAX_PAYLOAD_SIZE
        ) {
          used += serializedConnections[connIdx].length;
          chunk.connections.push(connections[connIdx]);
          connIdx++;
        }
        if (chunk.connections.length === 0) {
          chunk.connections.push(connections[connIdx]);
          connIdx++;
        }
        chunks.push(chunk);
      }

      // PERF: the serialized strings were only needed for chunk sizing —
      // release them (~tens of MB at 97k objects) before the network phase.
      serializedObjects.length = 0;
      serializedConnections.length = 0;

      // Post chunks with bounded concurrency instead of sequentially.
      // Chunks are independent (no ordering dependency), so parallelism
      // cuts wall-clock time from N × RTT to ceil(N/C) × RTT.
      const MAX_PARALLEL_POSTS = 4;
      const chunkResults = new Array(chunks.length).fill(null);
      let nextChunkIdx = 0;
      let firstError = null;

      const postWorker = async () => {
        while (nextChunkIdx < chunks.length && !firstError) {
          const i = nextChunkIdx++;
          const chunk = chunks[i];
          try {
            importPerf.mark(`bulkImport: POST chunk ${i + 1}/${chunks.length} (${chunk.objects.length} objs, ${chunk.connections.length} conns)`);
            const t0 = performance.now();
            const result = await postChunk(
              chunk.objects, chunk.connections, i + 1, chunks.length
            );
            importPerf.mark(`bulkImport: chunk ${i + 1} done in ${Math.round(performance.now() - t0)}ms`);
            chunkResults[i] = result;
          } catch (error) {
            if (!firstError) firstError = { index: i, chunk, error };
          }
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(MAX_PARALLEL_POSTS, chunks.length) }, () => postWorker())
      );

      if (firstError) {
        const { index: failIdx, chunk: failChunk, error } = firstError;
        console.warn(
          `\u26a0\ufe0f [BulkImport] Chunk ${failIdx + 1}/${chunks.length} failed, falling back to client for remaining connections:`,
          error
        );
        const remainingConnections = failChunk.connections.concat(
          chunks.slice(failIdx + 1).flatMap((c) => c.connections)
        );
        return this._backgroundSaveConnections(
          remainingConnections, currentSpaceId, user
        );
      }

      return { success: true, chunks: chunkResults };
    } catch (error) {
      console.error('❌ [BulkImport] Bulk import failed:', error);

      return this._backgroundSaveConnections(
        allConnectionsToSave,
        currentSpaceId,
        user
      );
    }
  },

  async _backgroundSaveConnections(allConnectionsToSave, currentSpaceId, user) {
    try {
      await pauseConnectionListeners();
      await new Promise((resolve) => setTimeout(resolve, 500));

      const connectionsByCell = new Map();

      for (const connectionData of allConnectionsToSave) {
        const startPosition = connectionData.start?.position;
        const endPosition = connectionData.end?.position;

        if (!startPosition || !endPosition) {
          continue;
        }

        const startCellCoords = getCellCoordinates(startPosition);
        const startCellId = getCellId(
          startCellCoords.x,
          startCellCoords.y,
          startCellCoords.z
        );

        if (!connectionsByCell.has(startCellId)) {
          connectionsByCell.set(startCellId, []);
        }
        connectionsByCell.get(startCellId).push(connectionData);
      }

      const { saved, failed } = await bulkSaveConnectionsBatch(
        user.uid,
        currentSpaceId,
        connectionsByCell
      );

      console.log(
        `✅ Background save complete: ${saved} saved, ${failed} failed`
      );

      await resumeConnectionListeners();
    } catch (error) {
      console.error('❌ Background save process failed:', error);

      try {
        await resumeConnectionListeners();
      } catch (resumeError) {
        console.error('❌ Failed to resume listeners:', resumeError);
      }
    }
  },
};
