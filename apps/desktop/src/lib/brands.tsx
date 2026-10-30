import { MARKS } from "./brand-marks";

/** A service's own logo on a tile, like an app icon. One with no logo gets its initial. */
export function Brand({ id, name, size = 38 }: { id: string; name: string; size?: number }) {
  const mark = MARKS[id];
  return (
    <span className="brand" style={{ width: size, height: size, fontSize: size * 0.46 }} aria-hidden="true">
      {mark ? <svg viewBox={`0 0 ${mark.w} ${mark.h}`} dangerouslySetInnerHTML={{ __html: mark.body }} /> : name[0]}
    </span>
  );
}
