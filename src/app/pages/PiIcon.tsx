import { piPixels } from "../editor/logo";

/** The Pi mark (`piLogo` as a component): the agent, wherever the page shows it. */
export function PiIcon({ size = 14, className = "" }: { size?: number; className?: string }) {
  return (
    <svg className={`pi-logo ${className}`.trim()} viewBox="0 0 4 4" width={size} height={size} aria-hidden="true" shapeRendering="crispEdges">
      {piPixels.map((p) => <rect key={`${p.x}${p.y}`} x={p.x} y={p.y} width={1} height={1} fill={p.fill} />)}
    </svg>
  );
}
