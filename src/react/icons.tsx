// Inline icons (no icon package): 16px strokes that take the current text colour.
import type { SVGProps } from "react";

const base = (p: SVGProps<SVGSVGElement>) => ({ width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, ...p });
export const IconSend = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
export const IconPlus = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M12 5v14M5 12h14" /></svg>;
export const IconTrash = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></svg>;
export const IconCopy = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>;
export const IconCheck = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M5 12l5 5L20 7" /></svg>;
export const IconMenu = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M4 6h16M4 12h16M4 18h16" /></svg>;
export const IconX = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M6 6l12 12M18 6L6 18" /></svg>;
export const IconSparkle = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" /></svg>;
export const IconChat = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.3A8 8 0 1 1 21 12z" /></svg>;
export const IconArrowDown = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M12 5v14M6 13l6 6 6-6" /></svg>;
export const IconTool = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z" /></svg>;
