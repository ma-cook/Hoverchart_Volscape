import { api } from '../api-client';
import { saveObjectToCell } from './spatialObjectsService';
import { getCellCoordinates } from './spatialPartitioning';
import { getIsInitialLoading, setIsInitialLoading } from '../utils/loadingState';
import useObjectsStore from '../stores/objectsStore';
import useSpatialManagerStore from '../stores/spatialManagerStore';

// Find or create a space for a trial-mode user who just signed in.
// Precedence: current session space (if still owned) → most recently
// updated owned space → new "My Space".
export async function resolveUpgradeSpace(user) {
  if (!user) return null;

  const response = await api.get('/api/spaces');
  const spaces = (response && (response.data || response)) || [];
  const owned = Array.isArray(spaces)
    ? spaces.filter((s) => s.owner_id === user.sub || s.ownerId === user.sub)
    : [];

  const storedSpaceId = sessionStorage.getItem('currentSpaceId');
  if (storedSpaceId && owned.some((s) => (s.id || s._id) === storedSpaceId)) {
    return storedSpaceId;
  }

  if (owned.length > 0) {
    return owned[0].id || owned[0]._id;
  }

  const created = await api.post('/api/spaces', {
    name: 'My Space',
    is_public: false,
    metadata: {},
  });
  const space = created && (created.data || created);
  return (space && (space.id || space._id)) || null;
}

// Persist the trial session's in-memory objects into `spaceId` so the
// user keeps their work after converting to a real signed-in session.
export async function migrateTrialObjects(user, spaceId) {
  if (!user || !spaceId) return;

  const state = useObjectsStore.getState();
  const objects = Array.isArray(state.objects) ? state.objects : [];
  if (objects.length === 0) return;

  // saveObjectToCell is gated on the global initial-loading flag, which
  // trial mode never completes. Temporarily clear it for the migration and
  // restore afterwards so the real space load keeps its normal semantics.
  const wasInitialLoading = getIsInitialLoading();
  if (wasInitialLoading) setIsInitialLoading(false);

  const spatialManager = useSpatialManagerStore.getState();

  try {
    for (const obj of objects) {
      if (!obj || !obj.id) continue;
      try {
        await saveObjectToCell(user.uid, spaceId, obj);
        if (obj.position && spatialManager.trackObjectInCell) {
          const cellCoords = getCellCoordinates(obj.position);
          const cellId = `${cellCoords.x},${cellCoords.y},${cellCoords.z}`;
          spatialManager.trackObjectInCell(obj.id.toString(), cellId);
        }
      } catch (error) {
        console.error('[TrialUpgrade] Failed to migrate object', obj.id, error);
      }
    }
  } finally {
    if (wasInitialLoading) setIsInitialLoading(true);
  }
}