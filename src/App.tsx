import { bytesToHex } from '@noble/hashes/utils' // already an installed dependency
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';

import { useEffect, useState } from 'react';

function App() {
  const [pubkey, setPubkey] = useState<string | null>(null);

  useEffect(() => {
    const priv = generateSecretKey();
    const privHex = bytesToHex(priv);
    console.log(privHex, 2534);
    const pub = getPublicKey(priv);
    setPubkey(pub);
  }, []);

  return (
    <div style={{ padding: '2rem', fontFamily: 'sans-serif' }}>
      <h1>nostr-tools + Bun + React</h1>
      <p>👤 Generated pubkey:</p>
      <code>{pubkey}</code>
    </div>
  );
}

export default App; 