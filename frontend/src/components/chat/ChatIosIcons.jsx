import React from 'react';

const STROKE = 1.65;

function SvgRoot({ children, className, size = 22, ...rest }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** SF-style: outline globe */
export function ChatIconGlobe({ className }) {
  return (
    <SvgRoot className={className}>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth={STROKE} />
      <ellipse cx="12" cy="12" rx="4.25" ry="10" stroke="currentColor" strokeWidth={STROKE} />
      <path stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" d="M2 12h20" />
    </SvgRoot>
  );
}

export function ChatIconPerson({ className }) {
  return (
    <SvgRoot className={className}>
      <circle cx="12" cy="8" r="3.75" stroke="currentColor" strokeWidth={STROKE} />
      <path
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinecap="round"
        d="M5.25 21v-2.25c0-2.625 3-4.125 6.75-4.125s6.75 1.5 6.75 4.125V21"
      />
    </SvgRoot>
  );
}

export function ChatIconPeople({ className }) {
  return (
    <SvgRoot className={className}>
      <circle cx="9" cy="7.25" r="3.2" stroke="currentColor" strokeWidth={STROKE} />
      <path
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinecap="round"
        d="M2.75 21v-2c0-2.05 2.35-3.65 6-3.95"
      />
      <circle cx="16.75" cy="7.75" r="2.85" stroke="currentColor" strokeWidth={STROKE} />
      <path
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinecap="round"
        d="M21.35 21v-1.7c-.15-1.75-2-2.9-5-3.05"
      />
    </SvgRoot>
  );
}

export function ChatIconBubbleLeft({ className }) {
  return (
    <SvgRoot className={className}>
      <path
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinejoin="round"
        d="M20 17.5v.75a2.75 2.75 0 0 1-2.75 2.75H9.5l-4.75 3V8.25A2.75 2.75 0 0 1 7.5 5.5h9.75A2.75 2.75 0 0 1 20 8.25v9.25Z"
      />
    </SvgRoot>
  );
}

export function ChatIconBubbleDouble({ className }) {
  return (
    <SvgRoot className={className}>
      <path
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinejoin="round"
        d="M16.75 17.75h-5.5l-3.25 2.65V17.75H8A2 2 0 0 1 6 15.75V10a2 2 0 0 1 2-2h8.75a2 2 0 0 1 2 2v5.75a2 2 0 0 1-2 2z"
      />
      <path
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinejoin="round"
        opacity="0.55"
        d="M9.75 13.75H17a3 3 0 0 1 3 3v4.15l-2-.75H13a3 3 0 0 1-3-3v-.4"
      />
    </SvgRoot>
  );
}

export function ChatIconPin({ className }) {
  return (
    <SvgRoot className={className}>
      <path
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 21s6.25-6.08 6.25-10.75a6.25 6.25 0 10-12.5 0C5.75 14.92 12 21 12 21z"
      />
      <circle cx="12" cy="10.25" r="2.05" stroke="currentColor" strokeWidth={STROKE} />
    </SvgRoot>
  );
}

export function ChatIconPaperclip({ className, size }) {
  return (
    <SvgRoot className={className} size={size || 21}>
      <path
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M21.44 11.05l-8.49 8.49a6 6 0 0 1-8.49-8.49l8.49-8.49a4 4 0 1 1 5.66 5.66l-8.84 8.84a2.5 2.5 0 0 1-3.54-3.54l7.78-7.78"
      />
    </SvgRoot>
  );
}

export function ChatIconFaceSmile({ className, size }) {
  return (
    <SvgRoot className={className} size={size || 21}>
      <circle cx="12" cy="12" r="9.75" stroke="currentColor" strokeWidth={STROKE} />
      <path
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinecap="round"
        d="M8.75 13.85c.9 2.15 6.05 2.05 7 .05"
      />
      <circle cx="9.25" cy="9.5" r="0.75" fill="currentColor" />
      <circle cx="14.75" cy="9.5" r="0.75" fill="currentColor" />
    </SvgRoot>
  );
}

export function ChatIconArrowUpSend({ className }) {
  return (
    <SvgRoot className={className} size={20}>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth={2.1}
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 16.5V6.25M8 10.5l4-4.35 4 4.35"
      />
    </SvgRoot>
  );
}

/** Tight × for pills (no circle) */
export function ChatIconXPlain({ className, size = 14 }) {
  return (
    <SvgRoot className={className} size={size}>
      <path stroke="currentColor" strokeWidth={2} strokeLinecap="round" d="m8.75 8.75 6.5 6.5m0-6.5-6.5 6.5" />
    </SvgRoot>
  );
}

export function ChatIconChevronRight({ className }) {
  return (
    <SvgRoot className={className} size={18}>
      <path stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" d="m9 6 6 6-6 6" />
    </SvgRoot>
  );
}

export function ChatIconChevronLeft({ className }) {
  return (
    <SvgRoot className={className} size={18}>
      <path stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" d="m15 6-6 6 6 6" />
    </SvgRoot>
  );
}

export function ChatIconPlusCircle({ className }) {
  return (
    <SvgRoot className={className} size={18}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth={STROKE} />
      <path stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" d="M12 8v8M8 12h8" />
    </SvgRoot>
  );
}

export function ConvRailGlyph({ type }) {
  const cn = 'teams-chat__apple-ico teams-chat__apple-ico--rail';
  if (type === 'global') return <ChatIconGlobe className={cn} />;
  if (type === 'dm') return <ChatIconPerson className={cn} />;
  if (type === 'group') return <ChatIconPeople className={cn} />;
  return <ChatIconBubbleLeft className={cn} />;
}
