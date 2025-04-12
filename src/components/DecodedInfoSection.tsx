import React from 'react';

interface DecodedInfoSectionProps {
  decodedHex: string | null;
  profileRelays: string[] | null;
}

export function DecodedInfoSection({
  decodedHex,
  profileRelays,
}: DecodedInfoSectionProps) {
  // Render only if decodedHex exists
  if (!decodedHex) {
    return null;
  }

  return (
    <div style={{ marginBottom: '1rem' }}>
      <strong>🔓 HEX pubkey:</strong>
      <pre
        style={{
          background: '#f0f0f0',
          padding: '0.5rem',
          overflowX: 'auto',
          marginBottom: '0.5rem', // Added margin
        }}
      >
        {decodedHex}
      </pre>
      {profileRelays && profileRelays.length > 0 && (
        <div>
          <strong>ℹ️ Relays from nprofile:</strong>
          <ul
            style={{
              background: '#f8f8f8',
              padding: '0.5rem 1rem',
              listStyle: 'none',
              margin: '0.5rem 0',
              maxHeight: '60px',
              overflowY: 'auto',
            }}
          >
            {profileRelays.map((relay, idx) => (
              <li key={idx} style={{ wordBreak: 'break-all' }}>
                {relay}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}