import type { ReactNode } from "react";

const paths: Record<string, ReactNode> = {
  home: <path d="M3.5 8.2 10 3l6.5 5.2V16a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1Z" />,
  chat: <path d="M3.5 5.5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2H9l-3.6 2.7V14a2 2 0 0 1-1.9-2Z" />,
  agents: (
    <>
      <path d="m6 7 3 3-3 3" />
      <path d="M11 13.5h3.5" />
      <rect x="2.8" y="3.5" width="14.4" height="13" rx="2.4" />
    </>
  ),
  providers: (
    <>
      <circle cx="10" cy="10" r="2.6" />
      <path d="M10 3v2.6M10 14.4V17M3 10h2.6M14.4 10H17M5 5l1.9 1.9M13.1 13.1 15 15M15 5l-1.9 1.9M6.9 13.1 5 15" />
    </>
  ),
  settings: (
    <>
      <path d="M3.5 6h7M14.5 6h2M3.5 14h2M9.5 14h7" />
      <circle cx="12.5" cy="6" r="2" />
      <circle cx="7.5" cy="14" r="2" />
    </>
  ),
  mic: (
    <>
      <rect x="7.2" y="2.8" width="5.6" height="9.4" rx="2.8" />
      <path d="M4.6 9.6a5.4 5.4 0 0 0 10.8 0M10 15v2.2" />
    </>
  ),
  stop: <rect x="5.5" y="5.5" width="9" height="9" rx="1.8" />,
  close: <path d="m5.5 5.5 9 9M14.5 5.5l-9 9" />,
  check: <path d="m4.5 10.5 3.6 3.6 7.4-8" />,
  send: <path d="M10 16V4.6M5 9.4l5-5 5 5" />,
  folder: <path d="M3 6a1.6 1.6 0 0 1 1.6-1.6h3.5l1.8 2h5.5A1.6 1.6 0 0 1 17 8v6.4a1.6 1.6 0 0 1-1.6 1.6H4.6A1.6 1.6 0 0 1 3 14.4Z" />,
  retry: <path d="M15.8 7.2A6.2 6.2 0 1 0 16.2 11M16 3.6v3.8h-3.8" />,
  plus: <path d="M10 4.5v11M4.5 10h11" />,
  chevron: <path d="m7.5 4.5 5.5 5.5-5.5 5.5" />,
  search: (
    <>
      <circle cx="9" cy="9" r="5.2" />
      <path d="m13 13 3.6 3.6" />
    </>
  ),
  play: <path d="M6.5 4.5v11l9-5.5Z" fill="currentColor" />,
  pause: <path d="M7 4.5v11M13 4.5v11" />,
  next: <path d="M5 4.8v10.4l7.5-5.2ZM14.8 4.8v10.4" />,
  previous: <path d="M15 4.8v10.4L7.5 10ZM5.2 4.8v10.4" />,
  music: (
    <>
      <path d="M7.5 15V5l8-1.6v10" />
      <circle cx="5.5" cy="15" r="2" />
      <circle cx="13.5" cy="13.4" r="2" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.2" y="4.4" width="13.6" height="12.4" rx="2.2" />
      <path d="M3.2 8.4h13.6M7 2.8v3M13 2.8v3" />
    </>
  ),
  bell: (
    <>
      <path d="M5 13.8V9.2a5 5 0 0 1 10 0v4.6l1.4 1.6H3.6Z" />
      <path d="M8.4 17.4a1.8 1.8 0 0 0 3.2 0" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 10S5.2 4.8 10 4.8 17.5 10 17.5 10 14.8 15.2 10 15.2 2.5 10 2.5 10Z" />
      <circle cx="10" cy="10" r="2.3" />
    </>
  ),
  plane: <path d="M17 3c-.8-.8-2.1-.7-3 .2l-2.8 2.8L4 3.9 2.6 5.3l5.9 3.5-2.9 2.9-2.3-.3-1 1 3 1.9 1.9 3 1-1-.3-2.3 2.9-2.9 3.5 5.9 1.4-1.4-2.1-7.2 2.8-2.8c.9-.9 1-2.2.2-3Z" fill="currentColor" stroke="none" />,
  key: (
    <>
      <circle cx="7" cy="13" r="3.4" />
      <path d="m9.4 10.6 6.8-6.8M13 7l2.2 2.2" />
    </>
  ),
};

export type IconName = keyof typeof paths;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
