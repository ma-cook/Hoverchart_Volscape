import { useState, useCallback, useEffect, useRef } from 'react';
import LandingApp from './landing/LandingApp';
import DiagramApp from './App.jsx';
import SharedCanvas from './components/SharedCanvas';
import useSceneStore from './stores/sceneStore';
import useObjectsStore from './stores/objectsStore';
import useConnectionStore from './stores/connectionStore';
import useDiagramStore from './stores/diagramStore';
import useCodeStore from './stores/codeStore';
import useSpatialManagerStore from './stores/spatialManagerStore';
import useAuthStore from './stores/authStore';
import useSpaceManagerStore from './stores/spaceManagerStore';
import { getContentStore } from './services/context/contentStore';
import { clearAllCellCaches } from './services/cellObjectCache';
import {
  resolveUpgradeSpace,
  migrateTrialObjects,
} from './services/trialUpgradeService';

const AppShell = () => {
  const [activeView, setActiveView] = useState('landing'); // 'landing' | 'diagram'
  const [spaceContext, setSpaceContext] = useState(null);
  const [trialMode, setTrialMode] = useState(false);

  const landingScene = useSceneStore((s) => s.landingScene);
  const diagramScene = useSceneStore((s) => s.diagramScene);
  const onDiagramPointerMissed = useSceneStore((s) => s.onDiagramPointerMissed);

  // Check URL on mount — if spaceId/space/code exists, go straight to diagram
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('spaceId') || params.get('space') || params.get('code')) {
      const urlSpaceType = params.get('type');
      const urlSpaceId = params.get('spaceId') || params.get('space');
      if (urlSpaceId && urlSpaceType) {
        setSpaceContext((prev) => prev || { spaceId: urlSpaceId, ownerId: null, spaceType: urlSpaceType });
      }
      setActiveView('diagram');
    }
  }, []);

  const handleOpenSpace = useCallback((spaceId, ownerId, spaceType = 'diagram') => {
    setSpaceContext({ spaceId, ownerId, spaceType });
    let newUrl = `${window.location.pathname}?spaceId=${encodeURIComponent(spaceId)}`;
    if (spaceType && spaceType !== 'diagram') {
      newUrl += `&type=${encodeURIComponent(spaceType)}`;
    }
    window.history.pushState({}, '', newUrl);
    setActiveView('diagram');
  }, []);

  const handleBackToLanding = useCallback(() => {
    useObjectsStore.getState().resetObjects();
    useConnectionStore.getState().resetConnections();
    useDiagramStore.getState().clear();
    useCodeStore.getState().reset();
    useSpatialManagerStore.getState().resetSpatialManager();
    clearAllCellCaches();
    try { getContentStore().clear(); } catch { /* singleton may not exist */ }
    window.history.pushState({}, '', window.location.pathname);
    window.isTrialMode = false;
    setTrialMode(false);
    setSpaceContext(null);
    setActiveView('landing');
  }, []);

  const handleTryWithoutAccount = useCallback(() => {
    window.isTrialMode = true;
    setTrialMode(true);
    setSpaceContext(null);
    setActiveView('diagram');
  }, []);

  // Detect a sign-in that happened while in trial mode (started from
  // "Try without account") and convert the session: exit trial mode, ensure
  // the user has an owned space to be in, open it, and migrate the trial
  // session's objects so nothing the user placed is lost. Only runs when a
  // logged-out user signs in during a trial session (not when an already
  // logged-in user toggles trial mode).
  const authState = useAuthStore((s) => s.authState);
  const user = authState.user;
  const prevUserRef = useRef(null);
  const trialUpgradeStartedRef = useRef(false);

  useEffect(() => {
    const previousUser = prevUserRef.current;
    prevUserRef.current = user;

    if (!trialMode || !user || user.isGuest) return;
    if (previousUser || trialUpgradeStartedRef.current) return;

    trialUpgradeStartedRef.current = true;
    let cancelled = false;

    (async () => {
      try {
        const spaceId = await resolveUpgradeSpace(user);
        if (cancelled) return;
        if (!spaceId) {
          trialUpgradeStartedRef.current = false;
          return;
        }

        await migrateTrialObjects(user, spaceId);
        if (cancelled) return;

        const searchParams = new URLSearchParams(window.location.search);
        const spaceType = searchParams.get('type');
        let newUrl = `${window.location.pathname}?spaceId=${encodeURIComponent(spaceId)}`;
        if (spaceType) newUrl += `&type=${encodeURIComponent(spaceType)}`;
        window.history.pushState({}, '', newUrl);

        sessionStorage.setItem('currentSpaceId', spaceId);
        window.currentSpaceOwner = user.uid;
        window.isTrialMode = false;
        setTrialMode(false);
        setSpaceContext({ spaceId, ownerId: user.uid, spaceType: 'diagram' });

        const spaceManager = useSpaceManagerStore.getState();
        spaceManager.setCurrentSpaceId(spaceId);
        await spaceManager.fetchCurrentSpace(user);
      } catch (error) {
        console.error('[TrialUpgrade] Failed to convert trial session:', error);
        trialUpgradeStartedRef.current = false;
        window.isTrialMode = false;
        setTrialMode(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [trialMode, user]);

  useEffect(() => {
    const handlePopState = () => {
      const params = new URLSearchParams(window.location.search);
      if (params.get('spaceId') || params.get('space') || params.get('code')) {
        setActiveView('diagram');
      } else {
        useObjectsStore.getState().resetObjects();
        useConnectionStore.getState().resetConnections();
        useDiagramStore.getState().clear();
        useCodeStore.getState().reset();
        useSpatialManagerStore.getState().resetSpatialManager();
        clearAllCellCaches();
        try { getContentStore().clear(); } catch { /* singleton may not exist */ }
        setActiveView('landing');
        setSpaceContext(null);
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  return (
    <>
      <SharedCanvas
        onPointerMissed={activeView === 'diagram' ? onDiagramPointerMissed : undefined}
      >
        {activeView === 'landing' ? landingScene : diagramScene}
      </SharedCanvas>

      <div style={{ position: 'relative', zIndex: 1, width: '100%', height: '100%', pointerEvents: 'none' }}>
        <div
          style={{
            opacity: activeView === 'landing' ? 1 : 0,
            pointerEvents: 'none',
            transition: 'opacity 0.4s ease-in-out',
            position: 'absolute',
            inset: 0,
          }}
        >
          {activeView === 'landing' && (
            <LandingApp onOpenSpace={handleOpenSpace} onTryWithoutAccount={handleTryWithoutAccount} />
          )}
        </div>

        <div
          style={{
            opacity: activeView === 'diagram' ? 1 : 0,
            pointerEvents: 'none',
            transition: 'opacity 0.4s ease-in-out',
            position: 'absolute',
            inset: 0,
          }}
        >
          {activeView === 'diagram' && (
            <DiagramApp
              initialSpaceContext={spaceContext}
              onBackToLanding={handleBackToLanding}
              trialMode={trialMode}
              spaceType={spaceContext?.spaceType || 'diagram'}
            />
          )}
        </div>
      </div>
    </>
  );
};

export default AppShell;
