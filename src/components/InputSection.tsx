import React from 'react';

interface InputSectionProps {
  input: string;
  setInput: (value: string) => void;
  handleDecode: () => void;
  isDecoding: boolean;
  isWriteSyncing: boolean;
  isReadSyncing: boolean;
  decodeError: string | null;
}

export function InputSection({
  input,
  setInput,
  handleDecode,
  isDecoding,
  isWriteSyncing,
  isReadSyncing,
  decodeError,
}: InputSectionProps) {
  const isAnySyncing = isWriteSyncing || isReadSyncing;

  return (
    <div style={{ marginBottom: '1rem' }}>
      <input
        type="text"
        placeholder="npub1... or nprofile1..."
        value={input}
        onChange={(e) => setInput(e.target.value)}
        disabled={isDecoding || isAnySyncing}
        style={{
          width: 'calc(100% - 110px)',
          padding: '0.5rem',
          fontSize: '1rem',
          marginRight: '10px',
        }}
      />
      <button
        onClick={handleDecode}
        disabled={isDecoding || isAnySyncing}
        style={{ padding: '0.5rem 1rem' }}
      >
        {isDecoding ? 'Decoding...' : 'Decode'}
      </button>
      {decodeError && (
        <div style={{ marginTop: '0.5rem', color: 'red' }}>
          Error: {decodeError}
        </div>
      )}
    </div>
  );
}