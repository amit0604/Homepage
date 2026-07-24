import React, { useMemo } from 'react';
import AppleEmoji from './AppleEmoji';

/** @returns {boolean} */
function graphemeIsEmojiSegment(g) {
  if (!g) return false;
  if (/\p{Extended_Pictographic}/u.test(g)) return true;
  // Regional indicators (national flags): two symbols in one grapheme cluster
  if (/^[\u{1F1E6}-\u{1F1FF}]{2}$/u.test(g)) return true;
  return false;
}

/**
 * Split plain text into runs of Unicode text vs emoji grapheme clusters,
 * so emoji can render as synced Apple PNG assets (not OS font glyphs).
 *
 * @param {string|null|undefined} text
 * @returns {{ kind: 'text' | 'emoji'; value: string }[]}
 */
export function segmentMessageIntoEmojiParts(text) {
  const raw = text == null ? '' : String(text);
  const Seg = typeof Intl !== 'undefined' && Intl.Segmenter;
  if (!Seg || raw.length === 0) {
    return raw.length ? [{ kind: 'text', value: raw }] : [];
  }
  const out = [];
  let buf = '';
  const flush = () => {
    if (buf.length) {
      out.push({ kind: 'text', value: buf });
      buf = '';
    }
  };

  try {
    for (const { segment } of new Seg(undefined, { granularity: 'grapheme' }).segment(raw)) {
      if (graphemeIsEmojiSegment(segment)) {
        flush();
        out.push({ kind: 'emoji', value: segment });
      } else {
        buf += segment;
      }
    }
    flush();
  } catch {
    return [{ kind: 'text', value: raw }];
  }

  return out;
}

/**
 * @param {{
 *   as?: 'div' | 'span',
 *   text: string|null|undefined,
 *   className?: string,
 *   emojiImgSizeClassName?: string,
 * }} props
 */
export default function MessageBodyAppleText({
  as: Comp = 'div',
  text,
  className = '',
  emojiImgSizeClassName = 'teams-chat__emoji-apple-img--msg-inline',
}) {
  const parts = useMemo(() => segmentMessageIntoEmojiParts(text), [text]);
  if (parts.length === 0) return null;

  const imgCls = `teams-chat__emoji-apple-img ${emojiImgSizeClassName}`;

  return (
    <Comp className={className} dir="auto">
      {parts.map((p, i) =>
        p.kind === 'emoji' ? (
          <AppleEmoji key={i} emoji={p.value} imgClassName={imgCls} />
        ) : (
          <span key={i}>{p.value}</span>
        ),
      )}
    </Comp>
  );
}
