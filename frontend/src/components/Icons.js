import React from 'react';

/** Line icons for the navigation rail. They inherit their colour from the surrounding text. */
function Icon({ children }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const InfoIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.500M12 7.500v.1" />
  </Icon>
);

export const ChevronRightIcon = () => (
  <Icon>
    <path d="m9 5 7 7-7 7" />
  </Icon>
);

export const HomeIcon = () => (
  <Icon>
    <path d="M3.5 10.5 12 3.5l8.5 7" />
    <path d="M5.5 9v11h13V9" />
    <path d="M10 20v-6h4v6" />
  </Icon>
);

export const TicketIcon = () => (
  <Icon>
    <path d="M3.5 8a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4Z" />
    <path d="M14.5 6v2.5M14.5 11v2M14.5 15.5V18" />
  </Icon>
);

export const PulseIcon = () => (
  <Icon>
    <path d="M3 12h4l2.5-7 4.5 14 2.5-7H21" />
  </Icon>
);

export const BookIcon = () => (
  <Icon>
    <path d="M12 6.5C10.5 5 8 4.5 4 4.5v14c4 0 6.500.5 8 2 1.500-1.500 4-2 8-2v-14c-4 0-6.500.5-8 2Z" />
    <path d="M12 6.500v14" />
  </Icon>
);

export const ChatIcon = () => (
  <Icon>
    <path d="M20.500 11.500a8 8 0 0 1-11.700 7.100L3.500 20l1.400-5.300a8 8 0 1 1 15.600-3.200Z" />
  </Icon>
);

export const PhoneIcon = () => (
  <Icon>
    <path d="M21 16.500v3a1.500 1.500 0 0 1-1.650 1.500A18 18 0 0 1 3 4.650 1.500 1.500 0 0 1 4.500 3h3a1 1 0 0 1 1 .800l.700 3.300a1 1 0 0 1-.300.950L7.400 9.500a15 15 0 0 0 7.100 7.100l1.450-1.500a1 1 0 0 1 .950-.300l3.300.700a1 1 0 0 1 .800 1Z" />
  </Icon>
);

export const ShieldIcon = () => (
  <Icon>
    <path d="M12 3 4.500 6v5.500c0 4.600 3.100 8 7.500 9.500 4.400-1.500 7.500-4.900 7.500-9.500V6Z" />
    <path d="m9 12 2.200 2.200L15.200 10" />
  </Icon>
);

export const MegaphoneIcon = () => (
  <Icon>
    <path d="M4 10v4a1 1 0 0 0 1 1h3l9 4V5L8 9H5a1 1 0 0 0-1 1Z" />
    <path d="m8.500 15 1.200 4.500h2.600L11 16M20 10v4" />
  </Icon>
);

export const SunIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.500v2M12 19.500v2M2.500 12h2M19.500 12h2M5.300 5.300l1.400 1.400M17.300 17.300l1.400 1.400M5.300 18.700l1.400-1.400M17.300 6.700l1.400-1.400" />
  </Icon>
);

export const MoonIcon = () => (
  <Icon>
    <path d="M20 14.500A8.500 8.500 0 0 1 9.500 4a8.500 8.500 0 1 0 10.500 10.500Z" />
  </Icon>
);

export const SignInIcon = () => (
  <Icon>
    <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" />
    <path d="M4 12h11M11 8l4 4-4 4" />
  </Icon>
);

export const SignOutIcon = () => (
  <Icon>
    <path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" />
    <path d="M9 12h11M16 8l4 4-4 4" />
  </Icon>
);

export const EditIcon = () => (
  <Icon>
    <path d="M4 20h4L19 9a2.800 2.800 0 0 0-4-4L4 16Z" />
    <path d="m13.500 6.500 4 4" />
  </Icon>
);

export const CommentIcon = () => (
  <Icon>
    <path d="M4 5.500h16v11H9.500L5 20v-3.500H4Z" />
  </Icon>
);

export const TrashIcon = () => (
  <Icon>
    <path d="M4 7h16M9.500 7V4.500h5V7M6.500 7l1 13h9l1-13M10 11v5.500M14 11v5.500" />
  </Icon>
);

export const UserIcon = () => (
  <Icon>
    <circle cx="12" cy="8" r="4" />
    <path d="M4.500 20.500c.8-4 3.700-6 7.500-6s6.700 2 7.500 6" />
  </Icon>
);
