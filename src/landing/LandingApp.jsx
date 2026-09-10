import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from 'react';
import LandingScene from './LandingScene';
import useSceneStore from '../stores/sceneStore';
import useAuthStore from '../stores/authStore';
import { api } from '../api-client';
import { clearAllCellCaches } from '../services/cellObjectCache';

import { CreateSpacePopup } from './components/CreateSpacePopup';
import { ShareSpacePopup } from './components/ShareSpacePopup';
import { SpacesTable } from './components/SpacesTable';
import TopBar from '../components/TopBar';
import { WelcomeOverlay } from './components/WelcomeOverlay';
import { OrganizationManager } from './components/OrganizationManager';
import { UpgradePrompt, TIER_LIMITS } from './components/UpgradePrompt';
import {
  getUserOrganizations,
  getOrganizationMembers,
  getPendingInvitesForUser,
  acceptInvite,
  declineInvite,
} from '../services/organizationService';
import { useWindowSize } from './hooks/useWindowSize';
import { LandingScrollContent } from './components/LandingScrollContent';
import './LandingApp.css';
import '../components/TopBar.css';

function LandingApp({ onOpenSpace, onTryWithoutAccount }) {
  const [_backgroundColor] = useState('white');
  const [_lightColor] = useState('#fff4d2');
  const [_glowColor] = useState('#fff4d2');
  const windowSize = useWindowSize();

  const [showCreateSpacePopup, setShowCreateSpacePopup] = useState(false);
  const [showUpgradePrompt, setShowUpgradePrompt] = useState(false);
  const [accountTier, setAccountTier] = useState('free');
  const [newSpaceName, setNewSpaceName] = useState('');
  const [sharedEmail, setSharedEmail] = useState('');
  const [isCreatingSpace, setIsCreatingSpace] = useState(false);
  const [userSpaces, setUserSpaces] = useState({ owned: [], shared: [] });

  const MAX_SCROLL = 3000;
  const rawScrollRef = useRef(0);
  const touchStartYRef = useRef(0);
  const [scrollProgress, setScrollProgress] = useState(0);
  const scrollProgressRef = useRef(0);
  const rafPendingRef = useRef(null);

  const authState = useAuthStore((s) => s.authState);
  const user = authState.user;
  const initializeAuth = useAuthStore((s) => s.initializeAuth);
  const signInWithGoogle = useAuthStore((s) => s.signInWithGoogle);
  const signOut = useAuthStore((s) => s.signOut);

  const setLandingScene = useSceneStore((s) => s.setLandingScene);
  useEffect(() => {
    setLandingScene(<LandingScene />);
    return () => setLandingScene(null);
  }, [setLandingScene]);

  const scheduleScrollUpdate = useCallback((value) => {
    scrollProgressRef.current = value;
    useSceneStore.getState().notifyLandingScroll();
    if (!rafPendingRef.current) {
      rafPendingRef.current = requestAnimationFrame(() => {
        setScrollProgress(scrollProgressRef.current);
        rafPendingRef.current = null;
      });
    }
  }, []);

  useEffect(() => {
    if (user) {
      rawScrollRef.current = 0;
      scrollProgressRef.current = 0;
      setScrollProgress(0);
      return;
    }
    const handleWheel = (e) => {
      e.preventDefault();
      rawScrollRef.current = Math.max(0, Math.min(MAX_SCROLL, rawScrollRef.current + e.deltaY));
      scheduleScrollUpdate(rawScrollRef.current / MAX_SCROLL);
    };
    window.addEventListener('wheel', handleWheel, { passive: false });
    return () => window.removeEventListener('wheel', handleWheel);
  }, [user, scheduleScrollUpdate]);

  useEffect(() => {
    if (user) return;
    const handleTouchStart = (e) => {
      touchStartYRef.current = e.touches[0].clientY;
    };
    const handleTouchMove = (e) => {
      const delta = touchStartYRef.current - e.touches[0].clientY;
      touchStartYRef.current = e.touches[0].clientY;
      rawScrollRef.current = Math.max(0, Math.min(MAX_SCROLL, rawScrollRef.current + delta * 1.5));
      scheduleScrollUpdate(rawScrollRef.current / MAX_SCROLL);
    };
    window.addEventListener('touchstart', handleTouchStart, { passive: true });
    window.addEventListener('touchmove', handleTouchMove, { passive: true });
    return () => {
      window.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('touchmove', handleTouchMove);
    };
  }, [user, scheduleScrollUpdate]);

  const [showSharePopup, setShowSharePopup] = useState(false);
  const [selectedSpaceForSharing, setSelectedSpaceForSharing] = useState(null);
  const [shareEmail, setShareEmail] = useState('');
  const [isSharing, setIsSharing] = useState(false);
  const [shareError, setShareError] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  const [userOrganizations, setUserOrganizations] = useState([]);
  const [activeOrgMembers, setActiveOrgMembers] = useState([]);
  const [showOrgManager, setShowOrgManager] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pendingInvites, setPendingInvites] = useState([]);

  useEffect(() => {
    initializeAuth();
  }, [initializeAuth]);

  useEffect(() => {
    if (user) {
      fetchUserSpaces();
      getUserOrganizations(user.sub)
        .then((orgs) => {
          setUserOrganizations(orgs);
          if (orgs.length > 0) {
            getOrganizationMembers(orgs[0].id)
              .then(setActiveOrgMembers)
              .catch(() => setActiveOrgMembers([]));
          } else {
            setActiveOrgMembers([]);
          }
        })
        .catch((err) => {
          console.error('Failed to load organizations:', err);
          setUserOrganizations([]);
        });
      getPendingInvitesForUser(user.email)
        .then(setPendingInvites)
        .catch(() => setPendingInvites([]));
    } else {
      setUserSpaces({ owned: [], shared: [] });
      setUserOrganizations([]);
      setActiveOrgMembers([]);
      setPendingInvites([]);
      setAccountTier('free');
    }
  }, [user]);

  const handleLogin = useCallback(async () => {
    const store = useAuthStore.getState();
    if (typeof store.signInWithGoogle !== 'function') return;
    try {
      await signInWithGoogle();
    } catch (error) {
      console.error('Login error:', error);
    }
  }, [signInWithGoogle]);

  const handleLogout = useCallback(() => {
    signOut();
  }, [signOut]);

  const navigateToSpace = useCallback(
    async (spaceId, ownerId = null, spaceType = 'diagram') => {
      if (!user) return;
      const effectiveOwner = ownerId && ownerId !== user.sub ? ownerId : user.sub;
      if (onOpenSpace) {
        onOpenSpace(spaceId, effectiveOwner, spaceType);
      }
    },
    [user, onOpenSpace]
  );

  const fetchUserSpaces = useCallback(async () => {
    if (!user) return;
    try {
      const spaces = await api.get('/api/spaces');
      const owned = (spaces || []).filter((s) => s.owner_id === user.sub).map(s => ({ ...s, isOwner: true }));
      const shared = (spaces || []).filter((s) => s.owner_id !== user.sub).map(s => ({ ...s, isOwner: false }));
      setUserSpaces({ owned, shared });
    } catch (error) {
      console.error('Error fetching user spaces:', error);
    }
  }, [user]);

  const createNewSpace = useCallback(
    async (spaceName, email, spaceType = 'diagram') => {
      const finalSpaceName = spaceName || newSpaceName;

      if (!user || !finalSpaceName.trim()) {
        return Promise.reject(new Error('User not logged in or space name empty'));
      }

      try {
        setIsCreatingSpace(true);
        await api.post('/api/spaces', {
          name: finalSpaceName.trim(),
          metadata: { type: spaceType },
        });

        setNewSpaceName('');
        setSharedEmail('');
        setShowCreateSpacePopup(false);
        await fetchUserSpaces();
        return true;
      } catch (error) {
        console.error('Error creating space:', error);
        throw error;
      } finally {
        setIsCreatingSpace(false);
      }
    },
    [fetchUserSpaces, newSpaceName, user]
  );

  const handleShareSpace = useCallback(
    async (emailOrEveryone) => {
      if (!selectedSpaceForSharing || !user) return;
      try {
        setIsSharing(true);
        setShareError('');

        const sharedWith = emailOrEveryone === 'everyone'
          ? { is_public: true }
          : { shared_with: [emailOrEveryone] };

        await api.patch(`/api/spaces/${selectedSpaceForSharing.id}`, sharedWith);

        setShowSharePopup(false);
        setShareEmail('');
        setSelectedSpaceForSharing(null);
        await fetchUserSpaces();
      } catch (error) {
        console.error('Error sharing space:', error);
        setShareError('Failed to share space. Please try again.');
      } finally {
        setIsSharing(false);
      }
    },
    [fetchUserSpaces, selectedSpaceForSharing, user]
  );

  const handleDeleteSpace = useCallback(
    async (spaceId) => {
      if (!user || !spaceId || isDeleting) return;
      if (!window.confirm('Are you sure you want to delete this space? This cannot be undone.')) return;

      try {
        setIsDeleting(true);
        await api.delete(`/api/spaces/${spaceId}`);
        // Drop cached cell→object entries for the deleted space so its objects
        // can never be re-hydrated into a subsequently opened space.
        clearAllCellCaches();
        await fetchUserSpaces();
      } catch (error) {
        console.error('Error deleting space:', error);
        alert(`Failed to delete space: ${error.message}. Please try again.`);
      } finally {
        setIsDeleting(false);
      }
    },
    [fetchUserSpaces, isDeleting, user]
  );

  const handleLeaveSpace = useCallback(
    async (space) => {
      if (!user || !space || !space.owner_id) return;
      if (!window.confirm(`Are you sure you want to leave "${space.name}"? You will lose access to this space.`)) return;

      try {
        setIsDeleting(true);
        const sharedWith = (space.shared_with || []).filter((id) => id !== user.sub);
        await api.patch(`/api/spaces/${space.id}`, { shared_with: sharedWith });
        await fetchUserSpaces();
        alert(`You have left "${space.name}".`);
      } catch (error) {
        console.error('Error leaving space:', error);
        alert('Failed to leave space. Please try again.');
      } finally {
        setIsDeleting(false);
      }
    },
    [fetchUserSpaces, user]
  );

  const handleAcceptInvite = useCallback(
    async (orgId) => {
      if (!user) return;
      try {
        await acceptInvite(orgId, user.sub, user.email);
        setPendingInvites((prev) => prev.filter((p) => p.org.id !== orgId));
        const orgs = await getUserOrganizations(user.sub);
        setUserOrganizations(orgs);
        if (orgs.length > 0) {
          getOrganizationMembers(orgs[0].id)
            .then(setActiveOrgMembers)
            .catch(() => setActiveOrgMembers([]));
        }
      } catch (err) {
        console.error('Failed to accept invite:', err);
      }
    },
    [user]
  );

  const handleDeclineInvite = useCallback(
    async (orgId) => {
      if (!user) return;
      try {
        await declineInvite(orgId, user.email);
        setPendingInvites((prev) => prev.filter((p) => p.org.id !== orgId));
      } catch (err) {
        console.error('Failed to decline invite:', err);
      }
    },
    [user]
  );

  const spaceTableProps = useMemo(
    () => ({
      userSpaces,
      userOrgs: userOrganizations,
      windowSize,
      user,
      isDeleting,
      pendingInvites,
      onNavigateToSpace: navigateToSpace,
      onCreateSpace: () => {
        const limit = TIER_LIMITS[accountTier] || TIER_LIMITS.free;
        if (userSpaces.owned.length >= limit) {
          setShowUpgradePrompt(true);
        } else {
          setShowCreateSpacePopup(true);
        }
      },
      onShareSpace: (space) => {
        setSelectedSpaceForSharing(space);
        setShowSharePopup(true);
      },
      onDeleteSpace: handleDeleteSpace,
      onLeaveSpace: handleLeaveSpace,
      onAcceptInvite: handleAcceptInvite,
      onDeclineInvite: handleDeclineInvite,
      onCreateOrganization: () => setShowOrgManager(true),
      onManageOrganization: () => setShowOrgManager(true),
    }),
    [
      userSpaces, userOrganizations, windowSize, user, isDeleting, pendingInvites,
      navigateToSpace, handleDeleteSpace, handleLeaveSpace,
      handleAcceptInvite, handleDeclineInvite, accountTier,
    ]
  );

  const createSpaceProps = useMemo(
    () => ({
      show: showCreateSpacePopup,
      initialSpaceName: newSpaceName,
      initialEmail: sharedEmail,
      isCreating: isCreatingSpace,
      organizationMembers: activeOrgMembers,
      currentUserId: user?.sub,
      onCancel: () => {
        setShowCreateSpacePopup(false);
        setNewSpaceName('');
        setSharedEmail('');
      },
      onSubmit: createNewSpace,
    }),
    [showCreateSpacePopup, newSpaceName, sharedEmail, isCreatingSpace, createNewSpace, activeOrgMembers, user?.sub]
  );

  const sharePopupProps = useMemo(
    () => ({
      show: showSharePopup,
      space: selectedSpaceForSharing,
      email: shareEmail,
      isSharing,
      error: shareError,
      organizationMembers: activeOrgMembers,
      currentUserId: user?.sub,
      onChangeEmail: setShareEmail,
      onCancel: () => {
        setShowSharePopup(false);
        setShareEmail('');
        setSelectedSpaceForSharing(null);
        setShareError('');
      },
      onShare: handleShareSpace,
    }),
    [handleShareSpace, isSharing, selectedSpaceForSharing, shareEmail, shareError, showSharePopup, activeOrgMembers, user?.sub]
  );

  const isMobile = windowSize.width <= 768;

  const footerBtnStyle = {
    background: 'rgba(255, 255, 255, 0.06)',
    color: '#e6e6e6',
    border: '1px solid rgba(255, 255, 255, 0.1)',
    borderRadius: '6px',
    padding: '4px 12px',
    cursor: 'pointer',
    fontSize: '12px',
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
    transition: 'background 120ms ease, border-color 120ms ease',
  };

  return (
    <div
      className="landing-view"
      style={{
        height: '100vh',
        width: '100vw',
        overflow: 'hidden',
        position: 'relative',
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif",
      }}
    >
      <CreateSpacePopup {...createSpaceProps} />
      <UpgradePrompt
        show={showUpgradePrompt}
        onClose={() => setShowUpgradePrompt(false)}
        currentTier={accountTier}
      />
      <ShareSpacePopup {...sharePopupProps} />
      <OrganizationManager
        user={user}
        show={showOrgManager}
        onClose={() => setShowOrgManager(false)}
      />

      <TopBar
        view="landing"
        user={user}
        onMenuToggle={() => setMenuOpen((prev) => !prev)}
        onLogout={handleLogout}
        onOpenOrgManager={() => setShowOrgManager(true)}
        pendingInviteCount={pendingInvites.length}
      />

      <div className={`sidebar-menu ${menuOpen ? 'open' : ''}`}>
        <div className="menu-content">
          {user && (
            <div className="sidebar-org-section">
              <button
                className="sidebar-org-button"
                onClick={() => {
                  setMenuOpen(false);
                  setShowOrgManager(true);
                }}
              >
                <span>Organization</span>
                {pendingInvites.length > 0 && (
                  <span className="sidebar-pending-badge">{pendingInvites.length}</span>
                )}
              </button>
            </div>
          )}
        </div>
      </div>

      {user && (
        <>
          <div
            style={{
              position: 'fixed',
              top: '64px',
              bottom: windowSize.width <= 768 ? '12px' : '56px',
              left: windowSize.width <= 768 ? '8px' : '270px',
              right: windowSize.width <= 768 ? '8px' : '270px',
              backgroundColor: 'rgba(255, 255, 255, 0.8)',
              opacity: 0.95,
              backdropFilter: 'blur(8px)',
              WebkitBackdropFilter: 'blur(8px)',
              border: '1px solid rgba(0, 0, 0, 0.92)',
              borderRadius: '10px',
              boxShadow: '0 4px 18px rgba(0, 0, 0, 0.47)',
              zIndex: 10,
              display: 'flex',
              padding: windowSize.width <= 480 ? '0.5rem' : '1rem',
              overflow: 'auto',
              pointerEvents: 'auto',
            }}
          >
            <SpacesTable {...spaceTableProps} />
          </div>

          <div
            style={{
              position: 'fixed',
              bottom: '8px',
              height: '40px',
              left: windowSize.width <= 768 ? '8px' : '270px',
              right: windowSize.width <= 768 ? '8px' : '270px',
              background: 'linear-gradient(180deg, rgba(22, 22, 26, 0.92), rgba(14, 14, 18, 0.92))',
              backdropFilter: 'blur(8px)',
              WebkitBackdropFilter: 'blur(8px)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: '10px',
              boxShadow: '0 4px 18px rgba(0, 0, 0, 0.35)',
              zIndex: 10,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: windowSize.width <= 480 ? '8px' : '24px',
              padding: '0 16px',
              fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
              pointerEvents: 'auto',
            }}
          >
            <button
              style={footerBtnStyle}
              onClick={() => window.open('https://volscape.com', '_blank')}
            >
              Feedback
            </button>
            <button style={footerBtnStyle}>Docs</button>
            <button style={footerBtnStyle}>Shortcuts</button>
            <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: 11, userSelect: 'none' }}>
              v1.0.0
            </span>
          </div>
        </>
      )}

      {!user && (
        <>
          <div
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 15,
              opacity: Math.max(0, 1 - scrollProgress * 12),
              pointerEvents: scrollProgress > 0.08 ? 'none' : 'auto',
              transition: 'opacity 0.3s ease',
            }}
          >
            <WelcomeOverlay
              windowSize={windowSize}
              onLogin={handleLogin}
              onTryWithoutAccount={onTryWithoutAccount}
            />
            <div
              style={{
                position: 'absolute',
                bottom: '28px',
                left: '50%',
                transform: 'translateX(-50%)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '6px',
                zIndex: 50,
                animation: 'scrollBounce 2s ease-in-out infinite',
                cursor: 'pointer',
                opacity: 0.65,
                pointerEvents: 'auto',
              }}
              onClick={() => {
                rawScrollRef.current = Math.min(MAX_SCROLL, rawScrollRef.current + 500);
                scheduleScrollUpdate(rawScrollRef.current / MAX_SCROLL);
              }}
            >
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: '600',
                  letterSpacing: '1.2px',
                  textTransform: 'uppercase',
                  color: '#444',
                }}
              >
                Explore
              </span>
              <svg width="20" height="12" viewBox="0 0 20 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M1 1L10 10L19 1" stroke="#444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
          </div>

          <LandingScrollContent
            scrollProgress={scrollProgress}
            isMobile={isMobile}
            onLogin={handleLogin}
            onTryWithoutAccount={onTryWithoutAccount}
          />
        </>
      )}
    </div>
  );
}

export default React.memo(LandingApp);