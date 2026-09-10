import React, { useState, useCallback, useMemo } from 'react';

// ---------- Static style constants (hoisted outside component) ----------
const TABLE_STYLES = {
  width: '100%',
  backgroundColor: 'rgba(255, 255, 255, 0.5)',
  borderCollapse: 'collapse',
  borderRadius: '4px',
  overflow: 'hidden',
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif",
};
const LINK_STYLES = { color: '#6ab9f5', textDecoration: 'none' };
const BTN_STYLES = {
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
  cursor: 'pointer',
  width: '28px',
  height: '28px',
  borderRadius: '4px',
  backgroundColor: 'rgba(255, 255, 255, 0.06)',
  border: '1px solid rgba(255, 255, 255, 0.1)',
  fontSize: '16px',
  color: '#e6e6e6',
};
const SHARE_BTN_STYLES = { ...BTN_STYLES, marginLeft: '10px' };
const TRASH_BTN_STYLES = { ...BTN_STYLES, marginLeft: '5px' };
const LEAVE_BTN_STYLES = {
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
  cursor: 'pointer',
  width: '26px',
  height: '26px',
  borderRadius: '4px',
  marginLeft: '5px',
  backgroundColor: 'rgba(244, 67, 54, 0.12)',
  border: '1px solid rgba(244, 67, 54, 0.4)',
  color: '#f47864',
  transition: 'all 0.2s',
};
const INVITE_BANNER_BASE = {
  marginTop: '12px',
  backgroundColor: 'rgba(255, 255, 255, 0.04)',
  border: '1px solid rgba(255, 255, 255, 0.08)',
  borderRadius: '6px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  flexWrap: 'wrap',
  gap: '10px',
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif",
};
const INVITE_TEXT_STYLES = { fontSize: '14px', color: '#d0d0d0', fontWeight: '400' };
const INVITE_BTN_ROW = { display: 'flex', gap: '8px' };
const ACCEPT_BTN_STYLES = {
  padding: '6px 14px',
  borderRadius: '4px',
  cursor: 'pointer',
  fontSize: '13px',
  fontWeight: '500',
  fontFamily: 'inherit',
  transition: 'background-color 0.2s',
};
const NO_SPACES_TEXT = { textAlign: 'center', color: '#999' };
// -----------------------------------------------------------------------

export const SpacesTable = React.memo(
  ({
    userSpaces,
    spacesLoading,
    windowSize,
    user,
    isDeleting,
    pendingInvites,
    onNavigateToSpace,
    onCreateSpace,
    onShareSpace,
    onDeleteSpace,
    onLeaveSpace,
    onAcceptInvite,
    onDeclineInvite,
  }) => {
    const [navigatingSpaceId, setNavigatingSpaceId] = useState(null);

    const handleSpaceClick = useCallback(
      async (e, spaceId, ownerId, spaceType) => {
        e.preventDefault();
        if (navigatingSpaceId) return;
        setNavigatingSpaceId(spaceId);
        try {
          await onNavigateToSpace(spaceId, ownerId, spaceType);
        } finally {
          setNavigatingSpaceId(null);
        }
      },
      [navigatingSpaceId, onNavigateToSpace]
    );

    // Only window-size-dependent styles computed here
    const isSmall = windowSize.width <= 480;
    const thStyles = useMemo(
      () => ({
        background: 'linear-gradient(180deg, rgba(22, 22, 26, 0.92), rgba(14, 14, 18, 0.92))',
        padding: isSmall ? '8px' : '12px',
        textAlign: 'left',
        fontWeight: '500',
        borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
        color: '#e6e6e6',
        fontSize: isSmall ? '12px' : '14px',
      }),
      [isSmall]
    );
    const tdStyles = useMemo(
      () => ({
        padding: isSmall ? '8px' : '12px',
        borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
        fontSize: isSmall ? '12px' : '14px',
        color: '#d0d0d0',
        fontWeight: '400',
      }),
      [isSmall]
    );
    const categoryRowStyles = useMemo(
      () => ({
        background: 'linear-gradient(180deg, rgba(22, 22, 26, 0.92), rgba(14, 14, 18, 0.92))',
        fontWeight: 'bold',
        fontSize: isSmall ? '13px' : '15px',
        color: '#e6e6e6',
        borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
      }),
      [isSmall]
    );
    const inviteBannerStyle = useMemo(
      () => ({ ...INVITE_BANNER_BASE, padding: isSmall ? '12px' : '14px 16px' }),
      [isSmall]
    );

    const hasOwnedSpaces = userSpaces.owned.length > 0;
    const hasSharedSpaces = userSpaces.shared.length > 0;
    const emptyRowStyle = useMemo(
      () => ({ ...tdStyles, ...NO_SPACES_TEXT, padding: '28px 12px' }),
      [tdStyles]
    );

    return (
      <div
        style={{
          width: '100%',
          overflow: 'auto',
          padding: isSmall ? '5px' : '10px',
        }}
      >
        <table style={TABLE_STYLES}>
          <thead>
            {hasOwnedSpaces && (
              <tr>
                <td colSpan="5" style={{ ...tdStyles, ...categoryRowStyles }}>
                  Your Spaces
                </td>
              </tr>
            )}
            <tr>
              <th style={thStyles}>Name</th>
              <th style={thStyles}>Owner</th>
              <th style={thStyles}>Shared</th>
              <th style={{ ...thStyles, whiteSpace: 'nowrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  Create
                  {user && (
                    <button
                      onClick={onCreateSpace}
                      style={BTN_STYLES}
                      title="Create new space"
                    >
                      +
                    </button>
                  )}
                </div>
              </th>
              <th style={{ ...thStyles, width: '60px' }}></th>
            </tr>
          </thead>
          <tbody>
            {/* Owned Spaces */}
            {hasOwnedSpaces && (
              <>
                {userSpaces.owned.map((space) => (
                  <tr key={`owned-${space.id}`}>
                    <td style={tdStyles}>
                      <a
                        href="#"
                        rel="noopener noreferrer"
                        style={{
                          ...LINK_STYLES,
                          opacity: navigatingSpaceId === space.id ? 0.5 : 1,
                          pointerEvents: navigatingSpaceId ? 'none' : 'auto',
                        }}
                        onClick={(e) => handleSpaceClick(e, space.id, undefined, space.type)}
                      >
                        {navigatingSpaceId === space.id
                          ? 'Opening...'
                          : `${space.type === 'earth' ? '🌍 ' : space.type === 'github_control_panel' ? '🐙 ' : ''}${space.name}`}
                      </a>
                    </td>
                    <td style={tdStyles}>
                      {user
                        ? user.displayName || user.email.split('@')[0]
                        : 'Unknown'}
                    </td>
                    <td style={tdStyles}>
                      <div style={{ display: 'flex', alignItems: 'center' }}>
                        {space.is_public ||
                        (space.shared_with &&
                          (space.shared_with.includes('everyone') ||
                            space.shared_with === 'everyone'))
                          ? 'Open'
                          : space.shared_with && space.shared_with.length > 0
                          ? 'Shared'
                          : 'Private'}
                        <button
                          style={SHARE_BTN_STYLES}
                          title="Share with someone"
                          onClick={() => onShareSpace(space)}
                        >
                          +
                        </button>
                      </div>
                    </td>
                    <td style={tdStyles}>
                      {new Date(space.created_at).toLocaleDateString()}
                    </td>
                    <td style={tdStyles}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {space.isOwner && (
                          <button
                            style={TRASH_BTN_STYLES}
                            title="Delete space"
                            onClick={() => onDeleteSpace(space.id)}
                            disabled={isDeleting}
                          >
                            🗑️
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </>
            )}

            {/* Shared Spaces */}
            {hasSharedSpaces && (
              <>
                <tr>
                  <td colSpan="5" style={{ ...tdStyles, ...categoryRowStyles }}>
                    Shared With You
                  </td>
                </tr>
                {userSpaces.shared.map((space) => (
                  <tr key={`shared-${space.id}`}>
                    <td style={tdStyles}>
                      <a
                        href="#"
                        rel="noopener noreferrer"
                        style={{
                          ...LINK_STYLES,
                          opacity: navigatingSpaceId === space.id ? 0.5 : 1,
                          pointerEvents: navigatingSpaceId ? 'none' : 'auto',
                        }}
                        onClick={(e) =>
                          handleSpaceClick(e, space.id, space.ownerId, space.type)
                        }
                      >
                        {navigatingSpaceId === space.id
                          ? 'Opening...'
                          : `${space.type === 'earth' ? '🌍 ' : space.type === 'github_control_panel' ? '🐙 ' : ''}${space.name}`}
                      </a>
                    </td>
                    <td style={tdStyles}>
                      {space.ownerEmail
                        ? space.ownerEmail.split('@')[0]
                        : 'Unknown'}
                    </td>
                    <td style={tdStyles}>Shared</td>
                    <td style={tdStyles}>
                      {new Date(space.created_at).toLocaleDateString()}
                    </td>
                    <td style={tdStyles}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <button
                          className="leave-space-btn"
                          style={LEAVE_BTN_STYLES}
                          title="Leave this shared space"
                          onClick={() => onLeaveSpace(space)}
                          disabled={isDeleting}
                        >
                          ✕
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </>
            )}

            {/* No spaces message */}
            {!hasOwnedSpaces && !hasSharedSpaces && (
              <tr>
                <td colSpan="5" style={emptyRowStyle}>
                  {spacesLoading ? (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
                      <span className="app-loading-spinner app-loading-spinner--sm" />
                      <span>Loading your spaces…</span>
                    </div>
                  ) : (
                    'No spaces found. Create your first space!'
                  )}
                </td>
              </tr>
            )}

          </tbody>
        </table>

        {/* Pending organization invites */}
        {Array.isArray(pendingInvites) &&
          pendingInvites.length > 0 &&
          pendingInvites.map(({ org }) => (
            <div
              key={org.id}
              style={inviteBannerStyle}
            >
              <span style={INVITE_TEXT_STYLES}>
                You&apos;ve been invited to join{' '}
                <strong>{org.name}</strong>
              </span>
              <div style={INVITE_BTN_ROW}>
                <button
                  onClick={() => onAcceptInvite(org.id)}
                  className="invite-accept-btn"
                  style={ACCEPT_BTN_STYLES}
                >
                  Accept
                </button>
                <button
                  onClick={() => onDeclineInvite(org.id)}
                  className="invite-decline-btn"
                  style={ACCEPT_BTN_STYLES}
                >
                  Decline
                </button>
              </div>
            </div>
          ))}
      </div>
    );
  }
);
