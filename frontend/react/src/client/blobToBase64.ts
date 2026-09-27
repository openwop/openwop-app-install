/**
 * Blob → base64 payload (no data-URL prefix). Split out of
 * `chat/hooks/useAudioRecorder.ts` (entry-chunk structural split): the profiles + media clients
 * needed this one helper and were dragging the whole recorder hook into the
 * entry chunk through `chrome/PinnedAgentsNav`. The hook re-exports it.
 */
export async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') { reject(new Error('FileReader returned non-string for blob')); return; }
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}
