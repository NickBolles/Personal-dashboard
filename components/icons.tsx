/** Inline icons (no icon font / bundle). All decorative: aria-hidden. */
type P = { className?: string };
const base = (d: React.ReactNode, className = "h-6 w-6") => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
    {d}
  </svg>
);
export const HomeIcon = ({ className }: P) => base(<><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /></>, className);
export const ChatIcon = ({ className }: P) => base(<><path d="M4 5h16v11H8l-4 4z" /></>, className);
export const BellIcon = ({ className }: P) => base(<><path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4z" /><path d="M10 20a2 2 0 0 0 4 0" /></>, className);
export const MoreIcon = ({ className }: P) => base(<><rect x="4" y="4" width="6" height="6" rx="1.5" /><rect x="14" y="4" width="6" height="6" rx="1.5" /><rect x="4" y="14" width="6" height="6" rx="1.5" /><rect x="14" y="14" width="6" height="6" rx="1.5" /></>, className);
export const TodoIcon = ({ className }: P) => base(<><path d="m4 7 2 2 4-4" /><path d="M13 7h7M13 17h7" /><rect x="4" y="14" width="6" height="6" rx="1.5" /></>, className);
export const CalendarIcon = ({ className }: P) => base(<><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>, className);
export const CompassIcon = ({ className }: P) => base(<><circle cx="12" cy="12" r="9" /><path d="m15.5 8.5-2 5-5 2 2-5z" /></>, className);
export const HouseIcon = ({ className }: P) => base(<><path d="M4 11 12 4l8 7v9H4z" /><path d="M10 20v-5h4v5" /></>, className);
export const BrainIcon = ({ className }: P) => base(<><path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 3 3V4z" /><path d="M15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-3 3V4z" /></>, className);
export const FlagIcon = ({ className }: P) => base(<><path d="M5 21V4h11l-2 4 2 4H5" /></>, className);
export const GearIcon = ({ className }: P) => base(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>, className);
export const SendIcon = ({ className }: P) => base(<><path d="M4 12 20 4l-6 16-2-7z" /></>, className);
export const StopIcon = ({ className }: P) => base(<><rect x="6" y="6" width="12" height="12" rx="2" /></>, className);
export const PlusIcon = ({ className }: P) => base(<><path d="M12 5v14M5 12h14" /></>, className);
export const ForkIcon = ({ className }: P) => base(<><circle cx="6" cy="5" r="2" /><circle cx="18" cy="5" r="2" /><circle cx="12" cy="19" r="2" /><path d="M6 7v2a4 4 0 0 0 4 4h4a4 4 0 0 0 4-4V7M12 13v4" /></>, className);
export const ToolIcon = ({ className }: P) => base(<><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-.5-.5-2.5z" /></>, className);
export const ChevronIcon = ({ className }: P) => base(<><path d="m9 6 6 6-6 6" /></>, className);
export const PanelIcon = ({ className }: P) => base(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>, className);
export const AlertIcon = ({ className }: P) => base(<><path d="M12 3 2 20h20z" /><path d="M12 10v4M12 17h.01" /></>, className);
export const CheckIcon = ({ className }: P) => base(<><path d="m5 12 5 5 9-10" /></>, className);
