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
