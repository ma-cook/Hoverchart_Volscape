import React, { useState, useEffect, useRef } from 'react';
import '../../components/TopBar.css';

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

const LandingTopBar = ({ user, onLogout, onOpenOrgManager, pendingInviteCount = 0 }) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef(null);

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

  return (
    <>
      <div className="top-bar" onClick={(e) => e.stopPropagation()}>
        <div className="top-bar-section">
          <button
            className="top-bar-menu-button"
            onClick={() => setMenuOpen((prev) => !prev)}
            aria-label="Toggle menu"
            title="Menu"
          >
            ☰
          </button>
          <div className="top-bar-brand" aria-label="Volscape">
            VOL<span className="brand-accent">SCAPE</span>
          </div>
        </div>

        <div className="top-bar-divider" />

        {user && (
          <>
            <div className="top-bar-section" ref={dropdownRef}>
              <button
                className="top-bar-org-button"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenOrgManager();
                }}
              >
                <span>Organization</span>
                {pendingInviteCount > 0 && (
                  <span className="sidebar-pending-badge">{pendingInviteCount}</span>
                )}
              </button>
              <div style={{ position: 'relative' }}>
                <div onClick={() => setDropdownOpen((prev) => !prev)}>
                  <Avatar user={user} />
                </div>
                {dropdownOpen && (
                  <div className="avatar-dropdown">
                    <div className="avatar-dropdown-user">
                      {user.displayName || user.email}
                    </div>
                    <button
                      className="avatar-dropdown-logout"
                      onClick={() => {
                        setDropdownOpen(false);
                        onLogout();
                      }}
                    >
                      Logout
                    </button>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      <div className={`sidebar-menu ${menuOpen ? 'open' : ''}`}>
        <div className="menu-content">
          {user && (
            <div className="sidebar-org-section">
              <button
                className="sidebar-org-button"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenOrgManager();
                }}
              >
                <span>Organization</span>
                {pendingInviteCount > 0 && (
                  <span className="sidebar-pending-badge">{pendingInviteCount}</span>
                )}
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
};

export default React.memo(LandingTopBar);
