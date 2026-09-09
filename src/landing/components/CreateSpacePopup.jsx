import React, { useRef, useEffect, useState } from 'react';
import { OrgMemberDropdown } from './OrgMemberDropdown';

export const CreateSpacePopup = React.memo(
  ({
    show,
    initialSpaceName = '',
    initialEmail = '',
    isCreating = false,
    onCancel,
    onSubmit,
    organizationMembers,
    currentUserId,
  }) => {
    const [localSpaceName, setLocalSpaceName] = useState(initialSpaceName);
    const [localEmail, setLocalEmail] = useState(initialEmail);
    const [spaceType, setSpaceType] = useState('diagram');
    const [selectedMember, setSelectedMember] = useState(null);
    const spaceNameRef = useRef(null);
    const formRef = useRef(null);

    const useOrgDropdown =
      Array.isArray(organizationMembers) && organizationMembers.length > 0;

    // Reset local state when external props change
    useEffect(() => {
      setLocalSpaceName(initialSpaceName);
      setLocalEmail(initialEmail);
    }, [initialSpaceName, initialEmail]);

    // Focus input when popup shows
    useEffect(() => {
      if (show && spaceNameRef.current) {
        setTimeout(() => {
          if (spaceNameRef.current) {
            spaceNameRef.current.focus();
          }
        }, 50);
      }
    }, [show]);

    // Handle input changes
    const handleSpaceNameChange = (e) => setLocalSpaceName(e.target.value);
    const handleEmailChange = (e) => setLocalEmail(e.target.value);

    const handleMemberSelect = (member) => {
      setSelectedMember(member);
      setLocalEmail(member.email);
    };

    // Handle key press
    const handleKeyPress = (e) => {
      if (e.key === 'Enter' && localSpaceName.trim() && !isCreating) {
        e.preventDefault();
        handleSubmit(e);
      }
    };

    // Handle form submission
    const handleSubmit = async (e) => {
      if (e) e.preventDefault();
      if (!localSpaceName.trim()) return;

      const emailToSubmit = useOrgDropdown
        ? selectedMember?.email || ''
        : localEmail.trim();

      try {
        await onSubmit(localSpaceName.trim(), emailToSubmit, spaceType);
      } catch (error) {
        console.error('Error submitting form:', error);
      }
    };

    if (!show) return null;

    return (
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 1000,
          pointerEvents: 'auto',
        }}
      >
        <div
          style={{
            backgroundColor: 'white',
            padding: '20px',
            borderRadius: '8px',
            width: '300px',
            border: '1px solid rgba(0,0,0,0.1)',
            color: '#333',
            fontFamily:
              "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif",
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          }}
        >
          <h3
            style={{
              margin: '0 0 15px 0',
              fontWeight: '500',
              fontSize: '18px',
            }}
          >
            Create New Space
          </h3>

          <form
            ref={formRef}
            onSubmit={handleSubmit}
            style={{ margin: 0, padding: 0 }}
          >
            <div style={{ marginBottom: '15px' }}>
              <label
                htmlFor="spaceType"
                style={{
                  display: 'block',
                  marginBottom: '8px',
                  fontWeight: '500',
                  fontSize: '14px',
                }}
              >
                Space Type:
              </label>
              <select
                id="spaceType"
                value={spaceType}
                onChange={(e) => setSpaceType(e.target.value)}
                style={{
                  width: '100%',
                  padding: '10px',
                  border: '1px solid #ddd',
                  borderRadius: '4px',
                  boxSizing: 'border-box',
                  fontSize: '14px',
                  fontFamily: 'inherit',
                  backgroundColor: 'white',
                  cursor: 'pointer',
                }}
              >
                <option value="diagram">Diagram Space</option>
                <option value="brain_space">Brain Space</option>
                <option value="earth">Earth Space</option>
                <option value="github_control_panel">Github Control Panel</option>
              </select>
            </div>

            <div style={{ marginBottom: '15px' }}>
              <label
                htmlFor="spaceName"
                style={{
                  display: 'block',
                  marginBottom: '8px',
                  fontWeight: '500',
                  fontSize: '14px',
                }}
              >
                Space Name:
              </label>
              <input
                ref={spaceNameRef}
                id="spaceName"
                type="text"
                value={localSpaceName}
                onChange={handleSpaceNameChange}
                onKeyPress={handleKeyPress}
                style={{
                  width: '100%',
                  padding: '10px',
                  border: '1px solid #ddd',
                  borderRadius: '4px',
                  boxSizing: 'border-box',
                  fontSize: '14px',
                  fontFamily: 'inherit',
                }}
                placeholder="Enter space name"
              />
            </div>

            <div style={{ marginBottom: '20px' }}>
              <label
                htmlFor="shareEmail"
                style={{
                  display: 'block',
                  marginBottom: '8px',
                  fontWeight: '500',
                  fontSize: '14px',
                }}
              >
                {useOrgDropdown ? 'Share with member:' : 'Share with (email):'}
              </label>
              {useOrgDropdown ? (
                <OrgMemberDropdown
                  members={organizationMembers.filter(
                    (m) => m.userId !== currentUserId
                  )}
                  selectedUserId={selectedMember?.userId}
                  onSelect={handleMemberSelect}
                  placeholder="Search members… (optional)"
                />
              ) : (
                <input
                  id="shareEmail"
                  type="email"
                  value={localEmail}
                  onChange={handleEmailChange}
                  onKeyPress={handleKeyPress}
                  style={{
                    width: '100%',
                    padding: '10px',
                    border: '1px solid #ddd',
                    borderRadius: '4px',
                    boxSizing: 'border-box',
                    fontSize: '14px',
                    fontFamily: 'inherit',
                  }}
                  placeholder="Enter email to share (optional)"
                />
              )}
            </div>

            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '10px',
              }}
            >
              <button
                type="button"
                onClick={onCancel}
                style={{
                  padding: '10px 16px',
                  backgroundColor: 'white',
                  border: '1px solid #ddd',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '14px',
                  fontFamily: 'inherit',
                  fontWeight: '500',
                  transition: 'background-color 0.2s',
                }}
                disabled={isCreating}
                onMouseOver={(e) =>
                  (e.currentTarget.style.backgroundColor = '#f5f5f5')
                }
                onMouseOut={(e) =>
                  (e.currentTarget.style.backgroundColor = 'white')
                }
              >
                Cancel
              </button>
              <button
                type="submit"
                style={{
                  padding: '10px 16px',
                  backgroundColor: 'black',
                  color: 'white',
                  border: '1px solid black',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '14px',
                  fontFamily: 'inherit',
                  fontWeight: '500',
                  transition: 'background-color 0.2s',
                }}
                disabled={!localSpaceName.trim() || isCreating}
                onMouseOver={(e) =>
                  (e.currentTarget.style.backgroundColor = '#333')
                }
                onMouseOut={(e) =>
                  (e.currentTarget.style.backgroundColor = 'black')
                }
              >
                {isCreating ? 'Creating...' : 'Create Space'}
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }
);
