import React, { useEffect, useMemo, useState } from 'react';
import { appleEmojiImgCandidates } from '../../utils/appleEmojiAssets';

/**
 * Renders emoji as Apple-style PNG when available from synced emoji-datasource-apple assets
 * under /emoji-vendor/apple/, falls back to native character where no file matches.
 */
export function AppleEmoji({
  emoji,
  className = '',
  imgClassName = 'teams-chat__emoji-apple-img',
  title,
}) {
  const candidates = useMemo(() => appleEmojiImgCandidates(emoji), [emoji]);
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    setIdx(0);
  }, [emoji, candidates]);

  const ch = String(emoji || '');
  if (!ch) return null;

  if (!candidates.length || idx >= candidates.length) {
    return (
      <span
        className={`teams-chat__emoji-native-fallback${className ? ` ${className}` : ''}`}
        title={title}
      >
        {ch}
      </span>
    );
  }

  return (
    <img
      src={candidates[idx]}
      alt=""
      title={title}
      className={`${imgClassName}${className ? ` ${className}` : ''}`}
      draggable={false}
      loading="lazy"
      decoding="async"
      onError={() => setIdx((x) => x + 1)}
    />
  );
}

export default AppleEmoji;
