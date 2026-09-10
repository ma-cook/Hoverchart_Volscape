import React, { useState, useEffect, useRef } from 'react';
import './TopBar.css';
import {
  getUserOrganizations,
  getPendingInvitesForUser,
} from '../services/organizationService';

const getInitials = (displayName) => {
  if (!displayName) return '?';
  const parts = displayName.trim().split(/\s+/);
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

const Avatar = ({ user }) => {
  const [imgError, setImgError] = useState(false);

  const tooltipLabel = user.isGuest ? 'Guest' : user.displayName || 'User';

  return (
    <div
      style={{
        width: 32,
        height: 32,
        borderRadius: '50%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 12,
        fontWeight: 600,
        color: '#fff',
        background: user.isGuest ? '#888' : '#4a90d9',
        overflow: 'hidden',
        border: '2px solid rgba(255,255,255,0.6)',
        boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
        flexShrink: 0,
        cursor: 'pointer',
        userSelect: 'none',
        position: 'relative',
      }}
    >
      {user.isGuest ? (
        'G'
      ) : user.photoURL && !imgError ? (
        <img
          src={user.photoURL}
          alt={tooltipLabel}
          referrerPolicy="no-referrer"
          onError={() => setImgError(true)}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : (
        getInitials(user.displayName)
      )}
    </div>
  );
};

/**
 * Single top bar shared across the landing and space views.
 * - Left: menu button + VOLSCAPE brand (menu content stays per-view).
 * - Space only: action buttons (`actions` slot) and presence/coordinates
 *   (`presence` slot).
 * - Right (any logged-in user): organization name (first org, clickable to
 *   open the Organization Manager), username, then the avatar with a logout
 *   dropdown.
 */
const TopBar = ({
  view = 'landing',
  user,
  onMenuToggle,
  onLogout,
  onOpenOrgManager,
  pendingInviteCount,
  actions,
  presence,
}) => {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef(null);
  const [organizationName, setOrganizationName] = useState(null);
  const [pendingCount, setPendingCount] = useState(0);

  const hasExplicitPendingCount = typeof pendingInviteCount === 'number';

  useEffect(() => {
    if (hasExplicitPendingCount) {
      setPendingCount(pendingInviteCount);
      return;
    }
    if (!user || user.isGuest) {
      setPendingCount(0);
      setOrganizationName(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const orgs = await getUserOrganizations();
        if (!cancelled) setOrganizationName(orgs?.[0]?.name || null);
      } catch {
        if (!cancelled) setOrganizationName(null);
      }
    })();
    (async () => {
      try {
        const invites = await getPendingInvitesForUser(user.email);
        if (!cancelled) setPendingCount(invites?.length || 0);
      } catch {
        if (!cancelled) setPendingCount(0);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, pendingInviteCount, hasExplicitPendingCount]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setDropdownOpen(false);
      }
    };
    if (dropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [dropdownOpen]);

  const isSpace = view === 'space';

  return (
    <div className="top-bar" onClick={(e) => e.stopPropagation()}>
      <div className="top-bar-section">
        <button
          className="top-bar-menu-button"
          onClick={onMenuToggle}
          aria-label="Toggle menu"
          title="Menu"
        >
          ☰
        </button>
        <div className="top-bar-brand" aria-label="Volscape">
          VOL<span className="brand-accent">SCAPE</span>
        </div>
      </div>

      {isSpace && actions && (
        <>
          <div className="top-bar-divider" />
          <div className="top-bar-section actions">{actions}</div>
        </>
      )}

      {isSpace && presence && (
        <>
          <div className="top-bar-divider" />
          <div className="top-bar-section">{presence}</div>
        </>
      )}

      {user && (
        <div
          className="top-bar-section"
          ref={dropdownRef}
          style={!isSpace || (!actions && !presence) ? { marginLeft: 'auto' } : undefined}
        >
          {organizationName && (
            <button
              className="top-bar-org-name"
              title="Open Organization Manager"
              onClick={() => {
                onOpenOrgManager?.();
              }}
            >
              <span className="top-bar-org-icon">⬡</span>
              <span className="top-bar-org-text">{organizationName}</span>
              {pendingCount > 0 && (
                <span className="sidebar-pending-badge">{pendingCount}</span>
              )}
            </button>
          )}
          {!user.isGuest && user.displayName && (
            <span className="top-bar-username">{user.displayName}</span>
          )}
          <div style={{ position: 'relative' }}>
            <div onClick={() => setDropdownOpen((prev) => !prev)}>
              <Avatar user={user} />
            </div>
            {dropdownOpen && (
              <div className="avatar-dropdown">
                <div className="avatar-dropdown-user">
                  {user.displayName || user.email || '(logged in)'}
                </div>
                <button
                  className="avatar-dropdown-logout"
                  onClick={() => {
                    setDropdownOpen(false);
                    onLogout?.();
                  }}
                >
                  Logout
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default React.memo(TopBar);