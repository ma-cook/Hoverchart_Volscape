import { useRef, useState, useCallback, useEffect, useMemo, memo } from 'react';
import { EffectComposer, SMAA, Bloom, Vignette } from '@react-three/postprocessing';
import useSceneStore from './stores/sceneStore';

import './App.css';

// Component imports
import CustomCamera from './components/CustomCamera';
import UIOverlay from './components/UIOverlay';
import RealTimeConnectionUpdater from './components/RealTimeConnectionUpdater';
import ObjectsRenderer from './components/ObjectsRenderer';
import ConnectionsRenderer from './components/ConnectionsRenderer';
import CellBoundaryRenderer from './components/CellBoundaryRenderer';
import LODManager from './components/LODManager';
import HeaderBillboardManager from './components/HeaderBillboardManager';
import EarthGlobe from './components/EarthGlobe';
import DiagramOverlay2D from './components/DiagramOverlay2D';
import RepoGrid from './components/RepoGrid';
import useUIOverlayStore from './stores/uiOverlayStore';
import FrameTicker from './components/FrameTicker';
import FrameloopController from './components/FrameloopController';
import PickGate from './components/PickGate';
import HandsRenderer from './components/HandsRenderer';

// Hook imports
import { useAuthState } from './hooks/useAuthState';
import { useSpaceManager } from './hooks/useSpaceManager';
import { useObjects } from './hooks/useObjects';
import { useIndicators } from './hooks/useIndicators';
import { useSpatialManager } from './hooks/useSpatialManager';
import { useCentralizedBroadcastManager } from './hooks/useCentralizedBroadcastManager';
import { useConnections } from './hooks/useConnections';
import useTimeoutManager from './hooks/useTimeoutManager';
import { getCellCoordinates } from './services/spatialPartitioning';
import {
  useObjectsStore,
  useConnectionStore,
  usePlaneStore,
  useCubeStore,
  useTetrahedronStore,
  useDodecahedronStore,
  useSpatialManagerStore,
  useCodeStore,
} from './stores';

// PERFORMANCE: Global animation manager for connection lines
import { ConnectionAnimationManager } from './hooks/useConnectionAnimationManager';

// Utility imports
import {
  handleObjectMove,
  handleObjectUpdate,
} from './utils/objectUpdateHandlers';
import { handleFaceIndicatorClick } from './utils/faceIndicatorUtils';
import { checkPositionJitter } from './utils/positionUtils';
import { throttle } from './utils/unifiedPerformanceUtils'; // Unified throttle utility
import { notifyCameraMove, isCameraMovingRapidly } from './utils/renderWorkScheduler';

import { signInUser } from './services/authService';
import { toggleTaskExpansion, repositionAllTasks } from './services/repoContainerService';
import { subscribeToSpatialObjects, clearAllObjectCaches, seedObjectsCache, wakeSpatialPolling } from './services/spatialObjectsService';
import { CELL_SIZE, getObjectsFromCells } from './services/spatialPartitioning';
import { hasAnyPendingObjects, getAllCellObjectsForCells, clearAllCellCaches } from './services/cellObjectCache';
import { setGuestPresence } from './services/presenceService';
import { getPublicSpaceMetadata } from './services/spacesService';
import { setIsInitialLoading as setGlobalInitialLoading } from './utils/loadingState';
import isEqual from 'lodash/isEqual';
import { initWebRTC } from './services/webRservice';
import { initAnimationSystem } from './utils/animationUtils';
import { objectVirtualizer } from './utils/objectVirtualization';

/**
 * Main application component
 */
const App = ({ onBackToLanding = null, trialMode = false, spaceType: spaceTypeProp = 'diagram' }) => {
  // Base state
  const [publicSpaceReady, setPublicSpaceReady] = useState(false);
  const [currentSpaceOwner, setCurrentSpaceOwner] = useState(null);

  // Unified timeout manager (replaces individual timeout refs)
  const {
    setRedirectTimeout,
    clearRedirectTimeout,

    clearLoadingTimeout,
    setObjectLoadingTimeout,
    clearObjectLoadingTimeout,
  } = useTimeoutManager();

  const cameraRef = useRef();
  const intentionalSpaceChangeRef = useRef(false);
  const previousSpaceIdRef = useRef(null); // Track space changes to clear stale state
  const objectsFromStore = useObjectsStore((state) => state.objects);
  const objects = useMemo(() => {
    return Array.isArray(objectsFromStore) ? objectsFromStore : [];
  }, [objectsFromStore]);
  const setObjects = useObjectsStore((state) => state.setObjects);
  const setIsInitialLoading = useObjectsStore(
    (state) => state.setIsInitialLoading
  );
  // Auth and space hooks
  const { user, isAuthReady, isCheckingUrlAuth } = useAuthState();
  const { currentSpaceId } = useSpaceManager({
    user,
    intentionalSpaceChangeRef,
  });
  const cellBoundariesVisible = useUIOverlayStore((state) => {
    const overlay = state.overlays['main'];
    return overlay ? overlay.cellBoundariesVisible : false;
  });
  // Calculate effective space ID early to avoid circular dependency
  // Initialize publicSpaceId and isLookingUpPublicSpace immediately from URL to prevent timing issues
  const { publicSpaceId, shouldLookupPublicSpace } = useMemo(() => {
    // First check if already set in window
    if (window.publicAccessSpace) {
      return {
        publicSpaceId: window.publicAccessSpace,
        shouldLookupPublicSpace: false,
      };
    }

    // Otherwise, extract from URL parameters immediately
    const params = new URLSearchParams(window.location.search);
    const spaceParam = params.get('space') || params.get('spaceId');
    const codeParam = params.get('code');
    const ownerParam = params.get('owner') || params.get('ownerUid');

    // Only treat as public space if no auth params and no owner param
    if (spaceParam && !codeParam && !ownerParam) {
      // Check if we already know this is a public space from session storage
      const isKnownPublic =
        sessionStorage.getItem(`isPublicSpace_${spaceParam}`) === 'true';
      const knownOwner = sessionStorage.getItem(
        `sharedSpaceOwner_${spaceParam}`
      );

      if (isKnownPublic && knownOwner) {
        // We already know this space and its owner, no lookup needed
        window.publicAccessSpace = spaceParam;
        window.currentSpaceOwner = knownOwner;
        return { publicSpaceId: spaceParam, shouldLookupPublicSpace: false };
      } else {
        // Need to lookup public space metadata
        return { publicSpaceId: spaceParam, shouldLookupPublicSpace: true };
      }
    }

    return {
      publicSpaceId: window.publicAccessSpace,
      shouldLookupPublicSpace: false,
    };
  }, []); // Empty deps - only calculate once on mount

  // Initialize isLookingUpPublicSpace based on whether we need to lookup
  const [isLookingUpPublicSpace, setIsLookingUpPublicSpace] = useState(
    shouldLookupPublicSpace
  );

  const effectiveSpaceId = publicSpaceId || currentSpaceId;

  // Memoize canViewSpace calculation to prevent unnecessary recalculations
  const canViewSpace = useMemo(() => {
    return !!(
      trialMode ||
      user ||
      (publicSpaceId &&
        (currentSpaceOwner || publicSpaceReady || isLookingUpPublicSpace)) ||
      // Also allow access if we have cached public space info from session storage
      (publicSpaceId && window.currentSpaceOwner)
    );
  }, [
    trialMode,
    user,
    publicSpaceId,
    currentSpaceOwner,
    publicSpaceReady,
    isLookingUpPublicSpace,
  ]);

  // Memoize redirect decision to prevent unnecessary recalculations
  const shouldRedirect = useMemo(() => !canViewSpace, [canViewSpace]);

  // Register guest presence when a non-logged-in user is viewing a space
  useEffect(() => {
    if (!isAuthReady || user || !effectiveSpaceId) return;
    setGuestPresence(effectiveSpaceId);
  }, [isAuthReady, user, effectiveSpaceId]);

  // Spatial partitioning hook with object change handler
  const handleSpatialObjectChange = useCallback(
    (change) => {
      if (change.source === 'cell-unload') {
        // Remove objects when their cells are unloaded
        setObjects((prev) => {
          return prev.filter(
            (obj) => obj.id.toString() !== change.id.toString()
          );
        });
      }
    },
    [setObjects]
  );
  const {
    loadedCells,
    isInitialized: isSpatialInitialized,
    currentCellCoords,
    cameraCellCoords,
    trackObjectInCell,
    untrackObjectInCell,
  } = useSpatialManager({
    user,
    currentSpaceId: canViewSpace ? effectiveSpaceId : null, // Only pass spaceId if user can view space
    currentSpaceOwner, // Pass owner state to enable re-initialization when resolved
    cameraRef,
    onObjectsChange: handleSpatialObjectChange,
  }); // REMOVED: No longer using tombstone tracking

  // Initialize animation system for connection line animations
  useEffect(() => {
    initAnimationSystem();
  }, []);

  // Initialize centralized broadcast manager
  useCentralizedBroadcastManager();
  // Setup debug context for spatial partitioning - memoized to reduce re-renders
  const spatialManagerDebug = useMemo(
    () => ({
      loadedCells,
      currentCellCoords,
      isInitialized: isSpatialInitialized,
      objects: objects.length,
      trackObjectInCell,
      untrackObjectInCell,
    }),
    [
      loadedCells,
      currentCellCoords,
      isSpatialInitialized,
      objects.length,
      trackObjectInCell,
      untrackObjectInCell,
    ]
  );

  // Only update window debug object when values actually change
  useEffect(() => {
    window._spatialManagerDebug = spatialManagerDebug;

    // Expose tracking functions for immediate object tracking
    if (trackObjectInCell) {
      window.trackObjectInCell = trackObjectInCell;
    }
    if (untrackObjectInCell) {
      window.untrackObjectInCell = untrackObjectInCell;
    }
  }, [spatialManagerDebug, trackObjectInCell, untrackObjectInCell]);
  const setSelectedConnection = useConnectionStore(
    (state) => state.selectConnection
  );
  const setShowLineTextStyleUI = useConnectionStore(
    (state) => state.setShowLineTextStyleUI
  );
  const setFocusedObjectId = useConnectionStore(
    (state) => state.setFocusedObjectId
  ); // Use the useConnections hook instead of implementing handlers directly
  // Debug: Log useConnections parameters
  const {
    connections,
    handleLineStyleChange,
    handleLineColorChange,
    handleConnectionClick,
    handleLineTextClick,
    handleLineTextSubmit,
    handleLineTextStyleChange,
  } = useConnections({ user, currentSpaceId: effectiveSpaceId, loadedCells });

  // Create position jitter checker that uses object store history
  const checkPositionJitterWithHistory = useCallback(
    (objectId, newPosition) => {
      const objectsStore = useObjectsStore.getState();
      const history =
        objectsStore.positionHistory.get(objectId.toString()) || [];

      if (history.length === 0) {
        // No history, record this position and allow
        objectsStore.setPositionHistory(objectId.toString(), [newPosition]);
        return false;
      }

      const lastPosition = history[history.length - 1];
      const isJitter = checkPositionJitter(lastPosition, newPosition, 0.001);

      if (!isJitter) {
        // Position change is significant, update history
        const newHistory = [...history.slice(-4), newPosition]; // Keep last 5 positions
        objectsStore.setPositionHistory(objectId.toString(), newHistory);
      }

      return isJitter;
    },
    []
  );

  // Objects hook gets the connections from above
  const {
    selectedId,
    setSelectedId,
    handleCreateObject,
    handleObjectDelete,
    lastUpdateRef,
    draggingObjectsRef,
    registerTransformingObject, // Get the transform function
    transformingObjectsRef, // Get the transform ref
    getTransformStartPosition, // Add this new property
  } = useObjects({
    user,
    currentSpaceId,
    cameraRef,
    connections,
  });

  // Indicators hook
  const {
    showAllCubesIndicators,
    setShowAllCubesIndicators,
    activeIndicator,
    setActiveIndicator,
    indicatorMode,
    setIndicatorMode,
    selectedIndicators,
    setSelectedIndicators,
    isConnectMode,
    setIsConnectMode,
    globalIndicatorSelected,
    setGlobalIndicatorSelected,
    selectedIndicatorsRef,
    handleToggleIndicators,
    handleIndicatorSelected,
    handleIndicatorDeselected,
  } = useIndicators();

  // UI state
  const [activeTextStyleUI, setActiveTextStyleUI] = useState(null);

  // Track objects in transition between cells to prevent flicker
  const transitioningObjectsRef = useRef(new Set()); // Set of object IDs currently transitioning

// Persistent ID Set for O(1) duplicate checks in batch-added callback.
// Avoids rebuilding new Set(prev.map(o => o.id)) — O(N) — on every Firebase snapshot.
const existingIdsRef = useRef(new Set());

  // Make transitioningObjectsRef available globally for cleanup
  useEffect(() => {
    window.transitioningObjectsRef = transitioningObjectsRef;
    return () => {
      delete window.transitioningObjectsRef;
    };
  }, []); // Enhanced check for URL parameters - handle both authenticated and public access
  useEffect(() => {
    // Extract parameters from URL
    const params = new URLSearchParams(window.location.search);
    const spaceParam = params.get('space') || params.get('spaceId'); // Support both 'space' and 'spaceId'
    const ownerParam = params.get('owner') || params.get('ownerUid');
    const codeParam = params.get('code'); // Check for authenticated access

    if (spaceParam) {
      // If we have a code param, this is authenticated access - let the auth system handle it
      if (codeParam) {
        // Don't set up public space access - let the normal auth flow handle this
        // The space manager will pick up the spaceId from URL parameters
        return;
      }

      // If we have an authenticated user, let the space manager handle it
      if (user?.uid) {
        // Reset lookup state since we're letting space manager handle this
        if (isLookingUpPublicSpace) {
          console.log(
            '🔄 [App] Authenticated user detected, letting space manager handle space access'
          );
          setIsLookingUpPublicSpace(false);
        }
        return;
      }

      // Wait for auth to be ready before making public space decisions
      if (!isAuthReady) {
        return;
      }

      // If we have both space and owner (but no auth params), treat as public access
      if (ownerParam) {
        window.publicAccessSpace = spaceParam;
        window.currentSpaceOwner = ownerParam;
        setCurrentSpaceOwner(ownerParam);
        setPublicSpaceReady(true);

        // Store in session storage as backup
        sessionStorage.setItem(`isSharedSpace_${spaceParam}`, 'true');
        sessionStorage.setItem(`sharedSpaceOwner_${spaceParam}`, ownerParam);
        sessionStorage.setItem(`isPublicSpace_${spaceParam}`, 'true');
      } else {
        // Only try public space lookup if we're not authenticated and no auth params
        // AND we don't already have the space data
        if (
          !user &&
          !codeParam &&
          !publicSpaceReady &&
          !currentSpaceOwner
        ) {
          // Set window variable for consistency (may already be set by useMemo above)
          window.publicAccessSpace = spaceParam;
          setIsLookingUpPublicSpace(true);

          console.log('🔍 [App] Starting public space lookup for:', spaceParam);

          getPublicSpaceMetadata(spaceParam)
            .then((spaceData) => {
              console.log(
                '📋 [App] getPublicSpaceMetadata returned:',
                spaceData
              );
              if (spaceData && spaceData.isPublic && spaceData.ownerId) {
                console.log(
                  '✅ [App] Successfully found public space, setting up access'
                );
                window.currentSpaceOwner = spaceData.ownerId;
                setCurrentSpaceOwner(spaceData.ownerId);
                sessionStorage.setItem(
                  `isSharedSpace_${spaceParam}`,
                  'true'
                );
                sessionStorage.setItem(
                  `sharedSpaceOwner_${spaceParam}`,
                  spaceData.ownerId
                );
                sessionStorage.setItem(
                  `isPublicSpace_${spaceParam}`,
                  'true'
                );
                // Trigger a re-render
                setPublicSpaceReady(true);
              } else {
                console.log(
                  '❌ [App] Public space lookup failed, redirecting. SpaceData:',
                  spaceData
                );
                if (onBackToLanding) { onBackToLanding(); } else { window.location.href = '/'; }
                return;
              }
              setIsLookingUpPublicSpace(false);
            })
            .catch((error) => {
              console.error(
                '❌ [App] Failed to fetch space metadata:',
                error
              );
              if (onBackToLanding) { onBackToLanding(); } else { window.location.href = '/'; }
            });
        } else if (
          !user &&
          !codeParam &&
          (publicSpaceReady || currentSpaceOwner)
        ) {
          // We already have public space data, just make sure lookup state is correct
          console.log(
            '🔄 [App] Public space data already available, skipping lookup'
          );
          if (isLookingUpPublicSpace) {
            setIsLookingUpPublicSpace(false);
          }
        }
      }
    }

    // Setup debug context for spatial partitioning
    window._currentSpaceId = currentSpaceId;
    window._currentUserId = user?.uid;

    // Setup global context for stores that need it
    // Use effectiveSpaceId so public-space and direct-space both work
    window.currentSpaceId = effectiveSpaceId || currentSpaceId;
    window.currentUser = user;

    // Debug logging for space ID availability
    if (currentSpaceId) {
      console.log('🌍 [App] Setting global space context:', {
        currentSpaceId,
        userId: user?.uid,
      });
    } else {
      console.warn('⚠️ [App] No currentSpaceId available for global context');
    }
  }, [
    user,
    currentSpaceId,
    effectiveSpaceId,
    isAuthReady,
    isLookingUpPublicSpace,
    setIsLookingUpPublicSpace,
    currentSpaceOwner,
    publicSpaceReady,
  ]);
  // Check for unauthorized access and redirect to volscape.com
  useEffect(() => {
    // If we have a currentSpaceId but no authentication and no public space access
    // BUT don't redirect if we're currently looking up a public space or in trial mode
    if (
      currentSpaceId &&
      !user &&
      !publicSpaceId &&
      isAuthReady &&
      !isLookingUpPublicSpace &&
      !trialMode
    ) {
      console.log(
        '🔄 [App] Redirecting to landing - no auth and no public space access'
      );
      if (onBackToLanding) { onBackToLanding(); } else { window.location.href = '/'; }
      return;
    }
  }, [
    currentSpaceId,
    user,
    publicSpaceId,
    isAuthReady,
    isLookingUpPublicSpace,
  ]);

  // Create stable key for loaded cells to prevent infinite subscription loop.
  // PERF FIX: use the cheap monotonic version counter from the store instead
  // of sorting+joining every loaded cell id on each change.
  const loadedCellsKey = useSpatialManagerStore((s) => s.loadedCellsVersion);

  // Note: Connections are now fully handled by useConnections hook

  // Reset all stores when switching spaces to prevent stale objects bleeding through
  useEffect(() => {
    if (previousSpaceIdRef.current && previousSpaceIdRef.current !== effectiveSpaceId) {
      clearAllObjectCaches();
      clearAllCellCaches();
      useObjectsStore.getState().resetObjects();
      useConnectionStore.getState().resetConnections();
      useSpatialManagerStore.getState().resetSpatialManager();
      existingIdsRef.current.clear(); // Reset persistent ID Set for new space
    }
    previousSpaceIdRef.current = effectiveSpaceId;
  }, [effectiveSpaceId]);
  
  // Subscribe to spatial objects changes - supports anonymous access to public spaces
  useEffect(() => {
    // Adaptive loading complete detection — armed BEFORE the guards below so
    // the initial-loading state always resolves, even for spaces that have no
    // cells/objects to load (never-accessed or empty spaces) or that are still
    // waiting on spatial init / owner lookup.
    let connectionSubscriptionTimeoutId = null;
    const totalCells = loadedCells?.length || 0;
    const connectionTimeout = Math.max(2000, totalCells * 500); // 500ms per cell, minimum 2 seconds

    connectionSubscriptionTimeoutId = setTimeout(() => {
      setGlobalInitialLoading(false);
      // Safety fallback: clear object loading state for empty spaces or when
      // the Firebase subscription didn't trigger scheduleLoadingComplete
      setIsInitialLoading(false);
    }, connectionTimeout);

    if (!canViewSpace) {
      return;
    }
    if (!isSpatialInitialized) {
      return; // Wait for spatial system to initialize
    }

    // For public spaces, wait until we have the owner information
    if (!user && publicSpaceId && !currentSpaceOwner) {
      return;
    }

    if (
      !loadedCells ||
      !Array.isArray(loadedCells) ||
      loadedCells.length === 0
    ) {
      return;
    } // Add an initial fetch phase to ensure we get all existing objects
    const performInitialObjectFetch = async () => {
      // Short-circuit: bulk-delete in progress. The user just asked to wipe
      // the space; pulling all still-existing Firestore objects back into the
      // store would re-render every doomed object and tank the frame loop
      // until the cloud function finishes deleting them one by one.
      if (window._bulkDeleteInProgress) {
        return;
      }
      try {
        const ownerUserId = currentSpaceOwner || user?.uid;

        // Convert cell IDs to coordinate objects
        const cellCoords = loadedCells.map((cellId) => {
          const [x, y, z] = cellId.split(',').map(Number);
          return { x, y, z: z || 0 }; // Default z to 0 for backward compatibility
        });

        const initialObjects = await getObjectsFromCells(
          ownerUserId,
          effectiveSpaceId,
          cellCoords
        );
        // Bridge: during diagram creation, objects for cells near the camera
        // are already in the store (from createObjectsFromDiagram), but objects
        // for cells loaded during camera movement may not be in Firebase yet
        // (Cloud Function still pending). Merge in any cached objects.
        if (hasAnyPendingObjects(effectiveSpaceId) && loadedCells.length > 0) {
          const cachedObjects = getAllCellObjectsForCells(effectiveSpaceId, loadedCells);
          if (cachedObjects.length > 0) {
            // Deduplicate by a Set of known IDs
            const knownIds = new Set(initialObjects.map(o => o.id?.toString()));
            for (const obj of cachedObjects) {
              if (!knownIds.has(obj.id?.toString())) {
                initialObjects.push(obj);
                knownIds.add(obj.id?.toString());
              }
            }
          }
        }
        // Re-check the bulk-delete flag after the await — the user may have
        // started a wipe while the fetch was in flight.
        if (window._bulkDeleteInProgress) {
          return;
        }
        if (initialObjects.length > 0) {
          currentSetObjects(initialObjects);
          // Seed the poll change-detection cache so the first poll cycle
          // doesn't re-flag every loaded object as "new" (which would hold
          // the poll at its fastest cadence during the warm-up).
          seedObjectsCache(effectiveSpaceId, initialObjects);
        } else {
          // Nothing in the currently loaded cells — mark loading complete so
          // the UI never shows an endless "Loading objects…" for a space
          // that has nothing to load. Also unblock saves (the save gate in
          // spatialObjectsService checks the global loading flag).
          setIsInitialLoading(false);
          setGlobalInitialLoading(false);
        }
      } catch (error) {
        console.error('Failed to fetch initial objects:', error);
      }
    };

    // Perform initial fetch before setting up subscriptions
    performInitialObjectFetch();

    // Separate shorter timeout for object loading
    const scheduleLoadingComplete = () => {
      clearObjectLoadingTimeout();

      setObjectLoadingTimeout(() => {
        currentSetIsInitialLoading(false);
      }, 1000); // Objects load faster than connections
    };
    const spaceToLoad = effectiveSpaceId;

    // Capture current refs and functions to avoid dependency issues
    const currentLastUpdateRef = lastUpdateRef;
    const currentDraggingObjectsRef = draggingObjectsRef;
    const currentTransformingObjectsRef = transformingObjectsRef;
    const currentSetObjects = setObjects;
    const currentSetIsInitialLoading = setIsInitialLoading;
    const currentTrackObjectInCell = trackObjectInCell;
    const currentUntrackObjectInCell = untrackObjectInCell;
    // Pass the actual signed-in user's uid (undefined for anonymous access).
    // The subscription internally uses window.currentSpaceOwner to resolve
    // the data path for anonymous users. Passing the owner's uid here would
    // make isAnonymous=false and trigger an unauthorized isSharedSpace lookup.
    const unsubscribe = subscribeToSpatialObjects(
      user?.uid, // undefined for anonymous access — handled via window.currentSpaceOwner
      spaceToLoad,
      loadedCells,
      (change) => {
        // Collect repoSlugs BEFORE the store update so we know which
        // containers may need expansion (initial loading excluded).
        const newRepoSlugs = (() => {
          if (change.type !== 'batch-added') return null;
          const slugs = new Set();
          for (const item of change.changes) {
            const slug = item.object?.merfolkData?.repoSlug;
            if (slug) slugs.add(slug);
          }
          return slugs.size > 0 ? slugs : null;
        })();

        currentSetObjects((prev) => {
          switch (change.type) {
            // PERF: Batched add — all objects from a single Firebase snapshot
            // arrive together. This replaces N individual array spreads with
            // one single spread, eliminating O(n²) array copying.
            case 'batch-added': {
              // Short-circuit: bulk-delete in progress — discard all incoming adds
              // to prevent deleted objects from being re-inserted by stale subscriptions.
              if (window._bulkDeleteInProgress) return prev;

              const validObjects = [];
              const updatedObjects = new Map(); // Track updates to existing objects
              // PERF: Use persistent ref instead of rebuilding Set from all prev objects.
              // On first call or after full replacement, seed from prev.
              let existingIds = existingIdsRef.current;
              if (existingIds.size === 0 && prev.length > 0) {
                existingIds = new Set(prev.map(o => o.id));
                existingIdsRef.current = existingIds;
              }

              for (const item of change.changes) {
                // Check deletion blacklist
                try {
                  if (window.getObjectDeletionStatus) {
                    const deletionStatus = window.getObjectDeletionStatus();
                    if (deletionStatus && deletionStatus.deletingObjects.includes(item.id.toString())) {
                      continue;
                    }
                  }
                } catch { /* ignore */ }

                // Track object change
                if (window.trackObjectChange) {
                  window.trackObjectChange(item.id, 'add');
                }

                // Clear transitioning flag
                if (transitioningObjectsRef.current.has(item.id.toString())) {
                  transitioningObjectsRef.current.delete(item.id.toString());
                }

                // Defense-in-depth: clean up if found in unloaded tracking,
                // then let the object through so it's not permanently lost.
                if (window._unloadedObjects?.has(item.id.toString())) {
                  window._unloadedObjects.delete(item.id.toString());
                  if (window._unloadedObjectsByCell) {
                    for (const [, objSet] of window._unloadedObjectsByCell) {
                      objSet.delete(item.id.toString());
                    }
                  }
                }

                // Validate position
                const pos = item.object?.position;
                const hasValidPosition = pos && (
                  (Array.isArray(pos) && pos.length === 3 && pos.every(v => typeof v === 'number' && !isNaN(v))) ||
                  (typeof pos === 'object' && 'x' in pos && 'y' in pos && 'z' in pos &&
                    typeof pos.x === 'number' && typeof pos.y === 'number' && typeof pos.z === 'number' &&
                    !isNaN(pos.x) && !isNaN(pos.y) && !isNaN(pos.z))
                );
                if (!hasValidPosition) continue;

                // Normalize position to array
                if (pos && !Array.isArray(pos)) {
                  item.object.position = [pos.x, pos.y, pos.z];
                }

                // Track in cell
                if (item.cellCoords && currentTrackObjectInCell) {
                  const cellId = `${item.cellCoords.x},${item.cellCoords.y},${item.cellCoords.z || 0}`;
                  currentTrackObjectInCell(item.id.toString(), cellId);
                } else if (item.object.position && currentTrackObjectInCell) {
                  const cellCoords = getCellCoordinates(item.object.position);
                  const cellId = `${cellCoords.x},${cellCoords.y},${cellCoords.z}`;
                  currentTrackObjectInCell(item.id.toString(), cellId);
                }

                if (existingIds.has(item.id)) {
                  // Update existing object — merge changed properties (e.g. broadcasting)
                  updatedObjects.set(item.id, item.object);
                } else {
                  validObjects.push(item.object);
                  existingIds.add(item.id); // prevent dupes within same batch
                }
              }

              let result = prev;

              // Apply updates to existing objects
              if (updatedObjects.size > 0) {
                result = result.map(obj => {
                  const updated = updatedObjects.get(obj.id);
                  if (updated) {
                    // Skip update for objects currently being transformed locally
                    if (window._currentTransformingObjects?.has(obj.id?.toString())) {
                      return obj;
                    }
                    // Skip Firebase overwrite for pipeline tasks recently updated by repo container service
                    // (throttled saves may not have reached Firebase yet)
                    if (obj._repoLocalUpdate && Date.now() - obj._repoLocalUpdate < 3000) {
                      return obj;
                    }
                    return { ...obj, ...updated };
                  }
                  return obj;
                });
              }

              // Append new objects
              if (validObjects.length > 0) {
                scheduleLoadingComplete();
                result = [...result, ...validObjects];
              }

              return result !== prev ? result : prev;
            }

            // PERF: Batched remove — all removals from a single snapshot
            case 'batch-removed': {
              const removeIds = new Set();
              for (const item of change.changes) {
                if (window.trackObjectChange) {
                  window.trackObjectChange(item.id, 'remove');
                }
                if (item.cellCoords && currentUntrackObjectInCell) {
                  const cellId = `${item.cellCoords.x},${item.cellCoords.y},${item.cellCoords.z || 0}`;
                  currentUntrackObjectInCell(item.id.toString(), cellId);
                }
                delete currentLastUpdateRef.current[item.id];
                removeIds.add(item.id.toString());
              }
              if (removeIds.size > 0) {
                // Also remove from persistent ID Set
                for (const id of removeIds) existingIdsRef.current.delete(id);
                return prev.filter(obj => !removeIds.has(obj.id.toString()));
              }
              return prev;
            }

            case 'added': {
              // Check deletion blacklist before adding object
              // Import deletion status check dynamically to avoid circular dependencies
              try {
                // Check if object is in deletion blacklist
                if (window.getObjectDeletionStatus) {
                  const deletionStatus = window.getObjectDeletionStatus();
                  if (
                    deletionStatus &&
                    deletionStatus.deletingObjects.includes(
                      change.id.toString()
                    )
                  ) {
                    console.log(
                      `🚫 [App] Blocked re-adding object during deletion: ${change.id}`
                    );
                    return prev;
                  }
                }
              } catch (error) {
                // If deletion status check fails, continue with normal flow
                console.warn('Could not check deletion status:', error);
              }

              // Track object change for spatial operation detection
              if (window.trackObjectChange) {
                window.trackObjectChange(change.id, 'add');
              }

              // Clear transitioning flag if object is being re-added
              if (transitioningObjectsRef.current.has(change.id.toString())) {
                transitioningObjectsRef.current.delete(change.id.toString());
              }
              // Check if object is in an unloaded cell
              // Defense-in-depth: clean up if found so objects aren't
              // permanently lost if primary cleanup misses them.
              if (window._unloadedObjects?.has(change.id.toString())) {
                window._unloadedObjects.delete(change.id.toString());
                if (window._unloadedObjectsByCell) {
                  for (const [, objSet] of window._unloadedObjectsByCell) {
                    objSet.delete(change.id.toString());
                  }
                }
              }

              if (!prev.find((obj) => obj.id === change.id)) {
                // Validate position before adding the object (accept both array and Vector3 formats)
                const hasValidPosition =
                  change.object?.position &&
                  ((Array.isArray(change.object.position) &&
                    change.object.position.length === 3 &&
                    change.object.position.every(
                      (val) => typeof val === 'number' && !isNaN(val)
                    )) ||
                    (typeof change.object.position === 'object' &&
                      'x' in change.object.position &&
                      'y' in change.object.position &&
                      'z' in change.object.position &&
                      typeof change.object.position.x === 'number' &&
                      typeof change.object.position.y === 'number' &&
                      typeof change.object.position.z === 'number' &&
                      !isNaN(change.object.position.x) &&
                      !isNaN(change.object.position.y) &&
                      !isNaN(change.object.position.z)));

                if (!hasValidPosition) {
                  console.warn(
                    `🚫 Rejecting new object with invalid position:`,
                    {
                      id: change.id,
                      position: change.object?.position,
                      object: change.object,
                    }
                  );
                  return prev;
                }

                // Normalize position to array format if it's a Vector3 object
                if (
                  change.object.position &&
                  !Array.isArray(change.object.position)
                ) {
                  change.object.position = [
                    change.object.position.x,
                    change.object.position.y,
                    change.object.position.z,
                  ];
                }
                if (change.cellCoords && currentTrackObjectInCell) {
                  const cellId = `${change.cellCoords.x},${
                    change.cellCoords.y
                  },${change.cellCoords.z || 0}`;
                  currentTrackObjectInCell(change.id.toString(), cellId);
                } else if (change.object.position && currentTrackObjectInCell) {
                  // Calculate cell coordinates from object position
                  const cellCoords = getCellCoordinates(change.object.position);
                  const cellId = `${cellCoords.x},${cellCoords.y},${cellCoords.z}`;
                  currentTrackObjectInCell(change.id.toString(), cellId);
                }

                // Track object loading for completion detection
                scheduleLoadingComplete();

                return [...prev, change.object];
              }
              return prev;
            }
            case 'modified':
              // Prevent position updates for actively transformed/dragged objects
              if (
                currentTransformingObjectsRef.current.has(
                  change.id.toString()
                ) ||
                currentDraggingObjectsRef.current.has(change.id.toString())
              ) {
                // Find existing object
                const existingObj = prev.find(
                  (obj) => obj.id.toString() === change.id
                );
                if (existingObj) {
                  // Validate that existing object has a valid position
                  const hasValidPosition =
                    existingObj.position &&
                    ((Array.isArray(existingObj.position) &&
                      existingObj.position.length === 3 &&
                      existingObj.position.every(
                        (val) => typeof val === 'number' && !isNaN(val)
                      )) ||
                      (typeof existingObj.position === 'object' &&
                        'x' in existingObj.position &&
                        'y' in existingObj.position &&
                        'z' in existingObj.position &&
                        typeof existingObj.position.x === 'number' &&
                        typeof existingObj.position.y === 'number' &&
                        typeof existingObj.position.z === 'number' &&
                        !isNaN(existingObj.position.x) &&
                        !isNaN(existingObj.position.y) &&
                        !isNaN(existingObj.position.z)));

                  if (!hasValidPosition) {
                    console.warn(
                      `🚫 Existing object has invalid position, accepting new position:`,
                      {
                        id: change.id,
                        existingPosition: existingObj.position,
                        newPosition: change.object?.position,
                      }
                    );
                    // Fall through to normal update logic
                  } else {
                    // Preserve current position but accept other changes
                    const updatedObj = {
                      ...change.object,
                      position: existingObj.position,
                      _transformActive: true,
                    };
                    currentLastUpdateRef.current[change.id] = updatedObj;

                    return prev.map((obj) =>
                      obj.id.toString() === change.id ? updatedObj : obj
                    );
                  }
                }
              } // Update other objects normally
              if (
                !isEqual(currentLastUpdateRef.current[change.id], change.object)
              ) {
                // Validate position before accepting the change (accept both array and Vector3 formats)
                const hasValidPosition =
                  change.object?.position &&
                  ((Array.isArray(change.object.position) &&
                    change.object.position.length === 3 &&
                    change.object.position.every(
                      (val) => typeof val === 'number' && !isNaN(val)
                    )) ||
                    (typeof change.object.position === 'object' &&
                      'x' in change.object.position &&
                      'y' in change.object.position &&
                      'z' in change.object.position &&
                      typeof change.object.position.x === 'number' &&
                      typeof change.object.position.y === 'number' &&
                      typeof change.object.position.z === 'number' &&
                      !isNaN(change.object.position.x) &&
                      !isNaN(change.object.position.y) &&
                      !isNaN(change.object.position.z)));

                if (!hasValidPosition) {
                  console.warn(
                    `🚫 Rejecting object update with invalid position:`,
                    {
                      id: change.id,
                      position: change.object?.position,
                      object: change.object,
                    }
                  );
                  return prev;
                }

                // Normalize position to array format if it's a Vector3 object
                if (
                  change.object.position &&
                  !Array.isArray(change.object.position)
                ) {
                  change.object.position = [
                    change.object.position.x,
                    change.object.position.y,
                    change.object.position.z,
                  ];
                }

                currentLastUpdateRef.current[change.id] = change.object;
                return prev.map((obj) =>
                  obj.id.toString() === change.id ? change.object : obj
                );
              }
              return prev;
            case 'removed': {
              // Track object change for spatial operation detection
              if (window.trackObjectChange) {
                window.trackObjectChange(change.id, 'remove');
              }

              // For cell unloads, remove the object immediately
              if (change.source === 'cell-unload') {
                if (change.cellCoords && currentUntrackObjectInCell) {
                  const cellId = `${change.cellCoords.x},${
                    change.cellCoords.y
                  },${change.cellCoords.z || 0}`;
                  currentUntrackObjectInCell(change.id.toString(), cellId);
                }
                delete currentLastUpdateRef.current[change.id];
                return prev.filter((obj) => obj.id.toString() !== change.id);
              }

              // For other removals (like deletions), use transitioning behavior
              transitioningObjectsRef.current.add(change.id.toString());
              setTimeout(() => {
                if (transitioningObjectsRef.current.has(change.id.toString())) {
                  transitioningObjectsRef.current.delete(change.id.toString());
                  currentSetObjects((current) =>
                    current.filter((obj) => obj.id.toString() !== change.id)
                  );
                }
              }, 500); // Reduced from 2000ms to 500ms for non-cell-unload cases

              // Untrack object when removed
              if (change.cellCoords && currentUntrackObjectInCell) {
                const cellId = `${change.cellCoords.x},${change.cellCoords.y},${
                  change.cellCoords.z || 0
                }`;
                currentUntrackObjectInCell(change.id.toString(), cellId);
              }
              delete currentLastUpdateRef.current[change.id];

              // Don't remove from UI if object is transitioning between cells
              if (transitioningObjectsRef.current.has(change.id.toString())) {
                return prev; // Keep the object in the UI
              }

              return prev.filter((obj) => obj.id.toString() !== change.id);
            }
            default:
              return prev;
          }
        });

        // After store update, trigger container expansion for new repo
        // objects (skip during initial loading — only react to live adds).
        if (newRepoSlugs) {
          const { isInitialLoading } = useObjectsStore.getState();
          if (!isInitialLoading) {
            setTimeout(() => {
              for (const slug of newRepoSlugs) {
                repositionAllTasks(slug);
              }
            }, 0);
          }
        }
      },
      // getCells: reads loadedCells live from the store on each poll,
      // avoiding full subscription teardown/recreate on cell changes.
      () => {
        const cells = useSpatialManagerStore.getState().loadedCells;
        return cells ? Array.from(cells) : [];
      }
    );

    return () => {
      unsubscribe();
      clearLoadingTimeout();
      if (connectionSubscriptionTimeoutId) {
        clearTimeout(connectionSubscriptionTimeoutId);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    effectiveSpaceId,
    canViewSpace,
    isSpatialInitialized,
    // loadedCellsKey REMOVED: the subscription reads cells live via getCells
    // callback, so no teardown/recreate is needed on cell changes.
    setObjects,
    publicSpaceId, // Include to re-run when public space changes
    currentSpaceOwner, // Include to re-run when owner is resolved
    // Note: Excluding other dependencies to prevent infinite loops
    // draggingObjectsRef, lastUpdateRef, trackObjectInCell, transformingObjectsRef, untrackObjectInCell, user
  ]);

  // When cells change, wake the pollers so they pick up new/removed cells
  // immediately instead of waiting for the next scheduled poll.
  useEffect(() => {
    if (loadedCellsKey > 0) {
      wakeSpatialPolling();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedCellsKey]);

  // Retroactively track existing objects when spatial manager becomes initialized
  const hasRetroTrackedRef = useRef(false);
  useEffect(() => {
    if (
      isSpatialInitialized &&
      trackObjectInCell &&
      objects.length > 0 &&
      !hasRetroTrackedRef.current
    ) {
      // PERF FIX: collect entries and track in ONE batch — the old loop
      // cloned the whole objectsByCell map once per object.
      const entries = [];
      objects.forEach((obj) => {
        if (
          obj.position &&
          Array.isArray(obj.position) &&
          obj.position.length >= 3
        ) {
          // Calculate which cell this object belongs to
          const cellCoords = {
            x: Math.floor(obj.position[0] / CELL_SIZE), // Use imported CELL_SIZE constant
            y: Math.floor(obj.position[1] / CELL_SIZE),
            z: Math.floor((obj.position[2] || 0) / CELL_SIZE),
          };

          entries.push({
            objectId: obj.id.toString(),
            cellId: `${cellCoords.x},${cellCoords.y},${cellCoords.z}`,
          });
        }
      });
      useSpatialManagerStore.getState().trackObjectsInCellBatch?.(entries);

      hasRetroTrackedRef.current = true; // Mark that we've done the initial tracking
    }
  }, [isSpatialInitialized, trackObjectInCell, objects]); // Include objects but use ref to prevent re-runs  // Note: Initial loading state is now handled by the object loading timeout mechanism
  // in the objects subscription effect to ensure all objects are loaded before
  // spatial operations are allowed

  // Matrix updates tracking to prevent recursion
  const handleObjectMatrixChanged = useCallback((id, matrixWorld) => {
    if (!window._matrixUpdateMap) {
      window._matrixUpdateMap = new Map();
    }

    const prevMatrix = window._matrixUpdateMap.get(id.toString());
    if (prevMatrix && matrixWorld.equals(prevMatrix)) {
      return;
    }

    window._matrixUpdateMap.set(id.toString(), matrixWorld.clone());
  }, []); // Store camera reference in window for debugging
  useEffect(() => {
    if (cameraRef.current) {
      window.camera = cameraRef.current;
    }
  }, []); // Only run once on mount

  // Camera controls
  const disableOrbitControls = useCallback(() => {
    if (cameraRef.current?.orbitControls) {
      cameraRef.current.orbitControls.enabled = false;
    }
  }, []);

  const enableOrbitControls = useCallback(() => {
    if (cameraRef.current?.orbitControls) {
      cameraRef.current.orbitControls.enabled = true;
    }
  }, []);

  // Login handler
  const handleLogin = useCallback(() => {
    signInUser();
  }, []);

  // Object click handler
  const handleObjectClick = useCallback(
    (id) => {
      // Collapse any previously-selected expanded pipeline task before switching selection
      const prevSelectedId = useObjectsStore.getState().selectedId;
      if (prevSelectedId && prevSelectedId !== id) {
        const prevObj = useObjectsStore.getState().objects.find((o) => o.id === prevSelectedId);
        if (prevObj?.merfolkData?.planTaskIndex != null && prevObj?.merfolkData?.isExpanded) {
          toggleTaskExpansion(prevSelectedId);
        }
      }

      setSelectedId(id);
      setShowLineTextStyleUI(null);
      setSelectedConnection(null);
      
      // When connections are globally hidden, set this object as focused
      // to show its connections temporarily
      // Get current value from store to avoid stale closure issues
      const currentConnectionsVisible = useConnectionStore.getState().connectionsVisible;
      if (!currentConnectionsVisible) {
        setFocusedObjectId(id);
      }
    },
    [setSelectedId, setShowLineTextStyleUI, setSelectedConnection, setFocusedObjectId]
  ); // Object move handler
  const handleObjectMoveCallback = useCallback(
    (id, newPosition, isDragStart = false, isDragEnd = false) => {
      // Get current objects from store to avoid dependency issues
      const currentObjects = useObjectsStore.getState().objects;

      // Convert array position to object if needed
      let positionObj;
      if (Array.isArray(newPosition)) {
        positionObj = {
          x: newPosition[0],
          y: newPosition[1],
          z: newPosition[2],
        };
      } else if (
        newPosition &&
        typeof newPosition === 'object' &&
        'x' in newPosition
      ) {
        positionObj = newPosition;
      } else {
        console.warn('Invalid newPosition format:', newPosition);
        return;
      }

      handleObjectMove({
        id,
        newPosition: positionObj,
        isDragStart,
        isDragEnd,
        draggingObjectsRef,
        objects: currentObjects,
        setObjects,
        user,
        currentSpaceId,
      });
    },
    [user, currentSpaceId, setObjects, draggingObjectsRef]
  );
  const handleObjectUpdateCallback = useCallback(
    (id, updates) => {
      // Skip position updates for objects being transformed
      // UNLESS it's a final position update
      if (updates.position) {
        if (
          transformingObjectsRef.current.has(id.toString()) &&
          !updates._finalPosition
        ) {
          // Skip position updates during transform, keep other properties
          const updatesWithoutPosition = { ...updates };
          delete updatesWithoutPosition.position;
          if (Object.keys(updatesWithoutPosition).length > 0) {
            handleObjectUpdate({
              id,
              updates: updatesWithoutPosition,
              lastUpdateRef,
              user,
              currentSpaceId: effectiveSpaceId, // Use effectiveSpaceId
            });
          }
          return;
        } // If position looks like jitter (oscillation), skip it - but not for final positions
        if (
          !updates._finalPosition &&
          checkPositionJitterWithHistory(id, updates.position)
        ) {
          const updatesWithoutPosition = { ...updates };
          delete updatesWithoutPosition.position;

          if (Object.keys(updatesWithoutPosition).length > 0) {
            handleObjectUpdate({
              id,
              updates: updatesWithoutPosition,
              lastUpdateRef,
              user,
              currentSpaceId: effectiveSpaceId, // Use effectiveSpaceId
            });
          }
          return;
        }
      }

      // For non-position updates or non-jittery updates, or final position updates
      handleObjectUpdate({
        id,
        updates,
        lastUpdateRef,
        user,
        currentSpaceId: effectiveSpaceId, // Use effectiveSpaceId
      });
    },
    [
      user,
      effectiveSpaceId, // Use effectiveSpaceId
      lastUpdateRef,
      transformingObjectsRef,
      checkPositionJitterWithHistory,
    ]
  );
  // Face indicator click handler
  const handleFaceIndicatorClickCallback = useCallback(
    async (indicator) => {
      try {
        const result = await handleFaceIndicatorClick({
          indicator,
          objects,
          connections,
          selectedIndicatorsRef,
          setSelectedIndicators,
          setIsConnectMode,
          setIndicatorMode,
          setShowAllCubesIndicators,
          setGlobalIndicatorSelected,
          user,
          currentSpaceId,
          isConnectMode,
        });

        // Log the result for debugging
        if (!result.success) {
          console.error('Face indicator click failed:', result.message);
        }
      } catch (error) {
        console.error('Error in face indicator click handler:', error);
      }
    },
    [
      objects,
      connections,
      user,
      currentSpaceId,
      isConnectMode,
      selectedIndicatorsRef,
      setSelectedIndicators,
      setIsConnectMode,
      setIndicatorMode,
      setShowAllCubesIndicators,
      setGlobalIndicatorSelected,
    ]
  );

  // Face click handler
  const handleFaceClick = useCallback(
    (faceInfo) => {
      if (faceInfo.id || faceInfo.cube?.id) {
        setActiveIndicator({
          ...faceInfo,
          cube: {
            ...faceInfo.cube,
            id: faceInfo.id || faceInfo.cube?.id,
          },
        });
        setIndicatorMode('single');
      }
    },
    [setActiveIndicator, setIndicatorMode]
  );

  // Canvas click handler - memoized to prevent re-creation
  const handleCanvasClick = useCallback(() => {
    // Collapse any expanded pipeline task before clearing selection
    const currentSelectedId = useObjectsStore.getState().selectedId;
    if (currentSelectedId) {
      const selectedObj = useObjectsStore.getState().objects.find((o) => o.id === currentSelectedId);
      if (selectedObj?.merfolkData?.planTaskIndex != null && selectedObj?.merfolkData?.isExpanded) {
        toggleTaskExpansion(currentSelectedId);
      }
    }

    // Close any active text styling menus
    setActiveTextStyleUI(null);
    setSelectedConnection(null);
    setShowLineTextStyleUI(null);
    setSelectedId(null);
    
    // Clear focused object (hides its connections when globally hidden)
    setFocusedObjectId(null);

    // Close line text input using connection store
    useConnectionStore.getState().setShowLineTextInput(null);

    // Use store batch methods to close all style UIs at once
    // This is more efficient than iterating and calling individual setters
    usePlaneStore.getState().closeAllStyleMenus?.();
    useCubeStore.getState().closeAllStyleMenus?.();
    useTetrahedronStore.getState().closeAllStyleMenus?.();
    useDodecahedronStore.getState().closeAllStyleMenus?.();

    // If they were trying to create a connection but clicked empty space,
    // cancel the connection creation process
    if (isConnectMode && selectedIndicators.length > 0) {
      setSelectedIndicators([]);
      selectedIndicatorsRef.current = [];
    }
  }, [
    setActiveTextStyleUI,
    setSelectedConnection,
    setShowLineTextStyleUI,
    setSelectedId,
    setFocusedObjectId,
    isConnectMode,
    selectedIndicators,
    setSelectedIndicators,
    selectedIndicatorsRef,
  ]); // Virtualized object rendering with LOD
  const [visibleObjectIds, setVisibleObjectIds] = useState(new Set());

  // LOD: Use a ref for camera distance to avoid triggering App re-renders on
  // every camera movement.  Only store the derived boolean `useLOD` in state —
  // this way App only re-renders when the threshold is actually crossed.
  // Camera starts at [5100, 5000, 5000] ≈ 8718 from origin, well above the 100
  // threshold, so initialise useLOD to true to avoid a flip on first move.
  const cameraDistanceRef = useRef(Infinity);
  const [useLOD, setUseLOD] = useState(true);

  // Update visible objects based on camera frustum
  // PERF: Stabilize the Set reference — only create a new Set when the
  // membership actually changes.  This avoids cascading re-renders in
  // ObjectsRenderer / ConnectionsRenderer on every camera frame.
  const prevVisibleRef = useRef(new Set());

  // PERF: Use refs for objects and loadedCells so that updateVisibleObjects
  // doesn't recreate on every objects/loadedCells change.  Recreating the
  // callback cascades: throttle recreates → camera listener re-registers →
  // initial-visibility call fires → visibleObjectIds ping-pongs between
  // "all objects" and the virtualizer subset on every data change.
  const objectsForVisibilityRef = useRef(objects);
  useEffect(() => { objectsForVisibilityRef.current = objects; }, [objects]);
  const loadedCellsForVisibilityRef = useRef(loadedCells);
  useEffect(() => { loadedCellsForVisibilityRef.current = loadedCells; }, [loadedCells]);

  // PERF: Guard against redundant visibility recalculations.
  // Both handleCameraSettle and seenObjectIdsRef effect can trigger
  // updateVisibleObjects within ~100ms of each other, causing double
  // sort + double Set creation + double progressive mount restart.
  const lastVisibilityUpdateRef = useRef(0);

  const updateVisibleObjects = useCallback(
    (camera) => {
      const currentObjects = objectsForVisibilityRef.current;
      if (!camera || currentObjects.length === 0) return;

      // Skip if we just ran within the last 150ms (debounce overlapping calls)
      const now = Date.now();
      if (now - lastVisibilityUpdateRef.current < 150) return;
      lastVisibilityUpdateRef.current = now;

      // Calculate camera distance for LOD — use a ref to avoid App re-renders.
      // Only promote to state when the useLOD threshold is actually crossed.
      const distance = camera.position.length();
      const prevDistance = cameraDistanceRef.current;
      cameraDistanceRef.current = distance;
      const wasLOD = prevDistance > 100;
      const nowLOD = distance > 100;
      if (wasLOD !== nowLOD) {
        setUseLOD(nowLOD);
      }

      // Use virtualization to get visible objects, coordinating with spatial partitioning
      const lc = loadedCellsForVisibilityRef.current;
      const loadedCellsSet =
        lc && Array.isArray(lc) ? new Set(lc) : null;
      const visible = objectVirtualizer.updateVisibility(
        camera,
        currentObjects,
        loadedCellsSet
      );

      // Only create a new Set reference when membership changed
      const prev = prevVisibleRef.current;
      let changed = visible.length !== prev.size;
      if (!changed) {
        for (const id of visible) {
          if (!prev.has(id)) { changed = true; break; }
        }
      }
      if (changed) {
        const next = new Set(visible);
        prevVisibleRef.current = next;
        setVisibleObjectIds(next);
      }
    },
    [] // Stable — reads objects/loadedCells from refs
  );
  // Throttled visibility update - stable because updateVisibleObjects is stable.
  // FREEZE FIX: During rapid camera movement, skip visibility recalculation
  // entirely. The O(n log n) sort + new Set creation + React re-render cascade
  // is the #1 cause of freezes during fast panning.
  const throttledUpdateVisibility = useMemo(
    () => throttle((camera) => {
      if (isCameraMovingRapidly()) return; // Defer until movement settles
      updateVisibleObjects(camera);
    }, 200),
    [updateVisibleObjects]
  );

  // Update visible objects when camera moves
  useEffect(() => {
    if (cameraRef.current?.camera) {
      // Initial visibility update
      updateVisibleObjects(cameraRef.current.camera);

      // Set up camera update listener
      const camera = cameraRef.current.camera;
      const controls = cameraRef.current.orbitControls;

      if (controls) {
        const handleCameraUpdate = () => {
          notifyCameraMove(); // Tell progressive mounters to defer work
          throttledUpdateVisibility(camera);
        };

        // FREEZE FIX: When camera movement settles, run one final
        // visibility update to catch up on deferred work.
        let settleTimer = null;
        const handleCameraSettle = () => {
          clearTimeout(settleTimer);
          settleTimer = setTimeout(() => {
            updateVisibleObjects(camera);
          }, 200);
        };

        controls.addEventListener('change', handleCameraUpdate);
        controls.addEventListener('change', handleCameraSettle);

        return () => {
          controls.removeEventListener('change', handleCameraUpdate);
          controls.removeEventListener('change', handleCameraSettle);
          clearTimeout(settleTimer);
        };
      }
    }
  }, [
    cameraRef.current?.camera,
    cameraRef.current?.orbitControls,
    throttledUpdateVisibility,
    updateVisibleObjects,
  ]);

  // Ensure newly-created objects become visible without waiting for a camera move.
  // Uses a "seen" set so we only ADD genuinely new IDs — we never re-add objects
  // that the virtualizer previously removed (distance/count limit).  This prevents
  // the old oscillation: effect set ALL visible → virtualizer set SUBSET →
  // objects change → effect set ALL again → ObjectsRenderer restarts progressive
  // mounting on every camera move.
  const seenObjectIdsRef = useRef(new Set());
  useEffect(() => {
    if (objects.length === 0) return;

    // Collect IDs we have never seen before
    const newIds = [];
    for (const obj of objects) {
      if (!seenObjectIdsRef.current.has(obj.id)) {
        seenObjectIdsRef.current.add(obj.id);
        newIds.push(obj.id);
      }
    }

    if (newIds.length === 0) return; // Nothing new — skip state update entirely

    const timeoutId = setTimeout(() => {
      setVisibleObjectIds((prev) => {
        const next = new Set(prev);
        for (const id of newIds) {
          next.add(id);
        }
        // BUGFIX: Keep prevVisibleRef in sync so the first updateVisibleObjects
        // call (on camera move) doesn't see a stale empty Set and think the
        // membership changed.  Without this, the virtualizer returns the same
        // IDs but prevVisibleRef is empty → "changed" = true → new Set
        // reference → ObjectsRenderer's progressive effect restarts.
        prevVisibleRef.current = next;
        return next;
      });

      // BUGFIX: Defer the virtualizer call so it doesn't get batched with the
      // setVisibleObjectIds above.  React 18 automatic batching causes both
      // state updates to merge — the virtualizer's CAPPED set wins, and
      // objects beyond the cap never enter the progressive mounting queue.
      // Using a second setTimeout ensures the full set applies first, giving
      // progressive mounting a chance to queue ALL objects before the
      // virtualizer caps the set on the next cycle.
      if (cameraRef.current?.camera) {
        setTimeout(() => {
          if (cameraRef.current?.camera) {
            updateVisibleObjects(cameraRef.current.camera);
          }
        }, 200);
      }
    }, 100); // 100ms debounce for rapid object creation

    return () => clearTimeout(timeoutId);
  }, [objects, updateVisibleObjects]);

  // useLOD is now derived directly as state (see above) — no need for
  // `const useLOD = cameraDistance > 100;`

  // Memoize device detection to avoid recalculating on every render
  const deviceInfo = useMemo(() => {
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
      navigator.userAgent
    );
    const isLowEnd = navigator.hardwareConcurrency <= 4 || navigator.deviceMemory <= 4;
    return { isMobile, isLowEnd };
  }, []);

  // Progressive canvas quality enhancement
  // Initialize directly to the correct quality level to avoid a 1-second delayed
  // quality upgrade that triggers WebGL reinitialization and corrupts LOD state.
  const [canvasQuality, setCanvasQuality] = useState(() => {
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    const isLowEnd = navigator.hardwareConcurrency <= 4 || navigator.deviceMemory <= 4;
    return (isMobile || isLowEnd) ? 'low' : 'high';
  });
  
  // Single effect for quality management (keep setCanvasQuality stable for mobile/low-end)
  useEffect(() => {
    if (deviceInfo.isMobile || deviceInfo.isLowEnd) {
      setCanvasQuality('low');
    }
  }, [deviceInfo.isMobile, deviceInfo.isLowEnd]);

  // Read view mode from store — '3d' or '2d'
  const viewMode = useUIOverlayStore((s) => s.viewMode);

  // Handle code toggle from ObjectUI — sets active code object and opens expanded view
  const handleCodeToggle = useCallback((objectId) => {
    const codeStore = useCodeStore.getState();
    codeStore.setActiveCodeObjectId(objectId);
    codeStore.setExpandedView(true);
  }, []);

  // Memoize scene content to keep the same JSX reference across re-renders
  // when dependencies haven't changed.  Without this, every App render creates
  // a new React element tree → setDiagramScene → AppShell re-render → scene
  // remount → store updates → App re-render (infinite loop).
  const diagramSceneContent = useMemo(() => (
    <>
      <FrameTicker />
      <FrameloopController />
      <PickGate />
      <LODManager enabled={useLOD} />
      <HeaderBillboardManager />
      {viewMode === '3d' && <ConnectionAnimationManager />}
      <CustomCamera ref={cameraRef} />
      <group>
        {viewMode === '3d' && <RealTimeConnectionUpdater />}
        <ConnectionsRenderer
          objects={objects}
          allObjectsForPathfinding={objects}
          visibleObjectIds={visibleObjectIds}
          onLineStyleChange={handleLineStyleChange}
          onLineColorChange={handleLineColorChange}
          onConnectionClick={handleConnectionClick}
          onLineTextClick={handleLineTextClick}
          onLineTextSubmit={handleLineTextSubmit}
          onLineTextStyleChange={handleLineTextStyleChange}
        />
        {spaceTypeProp === 'earth' && <EarthGlobe />}
        <ObjectsRenderer
          objects={objects}
          visibleObjectIds={visibleObjectIds}
          selectedId={selectedId}
          handleObjectClick={handleObjectClick}
          handleObjectMove={handleObjectMoveCallback}
          handleObjectUpdate={handleObjectUpdateCallback}
          disableOrbitControls={disableOrbitControls}
          enableOrbitControls={enableOrbitControls}
          handleFaceIndicatorClick={handleFaceIndicatorClickCallback}
          handleFaceClick={handleFaceClick}
          showAllCubesIndicators={showAllCubesIndicators}
          activeIndicator={activeIndicator}
          indicatorMode={indicatorMode}
          selectedIndicators={selectedIndicators}
          activeTextStyleUI={activeTextStyleUI}
          setActiveTextStyleUI={setActiveTextStyleUI}
          handleIndicatorDeselected={handleIndicatorDeselected}
          registerTransformingObject={registerTransformingObject}
          handleObjectMatrixChanged={handleObjectMatrixChanged}
          handleIndicatorSelected={handleIndicatorSelected}
          globalIndicatorSelected={globalIndicatorSelected}
          handleObjectDelete={handleObjectDelete}
          user={user}
          currentSpaceId={effectiveSpaceId}
          getTransformStartPosition={getTransformStartPosition}
          checkPositionJitter={checkPositionJitterWithHistory}
          useLOD={useLOD}
          onCodeToggle={handleCodeToggle}
        />
        <RepoGrid />
        <CellBoundaryRenderer visible={cellBoundariesVisible} />
      </group>
      <HandsRenderer />
      {canvasQuality !== 'low' && (
      <EffectComposer>
        <SMAA />
        <Bloom luminanceThreshold={0.7} luminanceSmoothing={0.08} intensity={0.25} mipmapBlur />
        <Vignette eskil={false} offset={0.3} darkness={0.4} />
      </EffectComposer>
      )}
    </>
  ), [
    useLOD, viewMode, spaceTypeProp, canvasQuality,
    objects, visibleObjectIds, selectedId,
    handleObjectClick, handleObjectMoveCallback, handleObjectUpdateCallback,
    disableOrbitControls, enableOrbitControls,
    handleFaceIndicatorClickCallback, handleFaceClick,
    showAllCubesIndicators, activeIndicator, indicatorMode,
    selectedIndicators, activeTextStyleUI, setActiveTextStyleUI,
    handleIndicatorDeselected, registerTransformingObject,
    handleObjectMatrixChanged, handleIndicatorSelected,
    globalIndicatorSelected, handleObjectDelete, user,
    effectiveSpaceId, getTransformStartPosition,
    checkPositionJitterWithHistory,
    handleLineStyleChange, handleLineColorChange,
    handleConnectionClick, handleLineTextClick,
    handleLineTextSubmit, handleLineTextStyleChange,
    cellBoundariesVisible, handleCodeToggle,
  ]);

  // Store diagram scene content for SharedCanvas
  const setDiagramScene = useSceneStore((s) => s.setDiagramScene);
  useEffect(() => {
    setDiagramScene(diagramSceneContent, handleCanvasClick);
    return () => setDiagramScene(null, null);
  }, [diagramSceneContent, handleCanvasClick, setDiagramScene]);

  // Initialize WebRTC service with user ID when available
  useEffect(() => {
    if (user?.uid) {
      initWebRTC(user.uid);
    }
  }, [user?.uid]);
  // Show loading screens when authenticating
  if (isCheckingUrlAuth && !publicSpaceId && !trialMode) {
    return <div className="auth-loading">Authenticating...</div>;
  }

  if (!isAuthReady && !publicSpaceId && !trialMode) {
    return <div className="loading">Loading...</div>;
  }

  // Show loading when looking up public space metadata
  if (isLookingUpPublicSpace) {
    console.log('🔍 [App] Showing loading screen for public space lookup');
    return <div className="loading">Loading public space...</div>;
  }

  if (shouldRedirect) {
    console.log('🔄 [App] Triggering redirect due to !canViewSpace');
    // Clear any existing redirect timeout and schedule new one
    clearRedirectTimeout();
    setRedirectTimeout(() => {
      console.log('🔄 [App] Executing redirect to landing');
      if (onBackToLanding) { onBackToLanding(); } else { window.location.href = '/'; }
    }, 0);
    return <div className="loading">Redirecting...</div>;
  }

  // Clear redirect timeout if canViewSpace becomes true
  clearRedirectTimeout();
  return (
    <>
      {viewMode === '2d' && <DiagramOverlay2D />}
      <UIOverlay
        onCreateObject={handleCreateObject}
        onToggleIndicators={handleToggleIndicators}
        user={user}
        onLogin={handleLogin}
        isAuthReady={isAuthReady}
        isLoading={!isAuthReady && !trialMode}
        showLoginButton={!isCheckingUrlAuth && !user}
        isConnectMode={isConnectMode}
        currentCell={cameraCellCoords}
        currentSpaceId={effectiveSpaceId}
        trialMode={trialMode}
        spaceType={spaceTypeProp}
      />
    </>
  );
};

export default memo(App);
