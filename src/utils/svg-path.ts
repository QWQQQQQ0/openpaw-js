// SVG Path Parser & Sampler
// Parses SVG path strings into dense arrays of {x, y} waypoints
// for smooth mouse movement. Supports M, L, C, Q, Z (and relative variants).

interface Point {
  x: number;
  y: number;
}

const SAMPLE_SPACING = 2; // pixels between sample points

/**
 * Parse an SVG path string into sampled waypoints.
 * Supports: M/m, L/l, C/c, Q/q, Z/z
 */
export function parseSvgPath(path: string): Point[] {
  const segments = tokenize(path);
  const waypoints: Point[] = [];
  let cur: Point = { x: 0, y: 0 };
  let start: Point = { x: 0, y: 0 };
  let first = true;

  for (const seg of segments) {
    const rel = seg.type === seg.type.toLowerCase();
    const cmd = seg.type.toUpperCase();

    switch (cmd) {
      case 'M': {
        for (const pt of seg.points) {
          const target = rel ? add(cur, pt) : pt;
          waypoints.push(target);
          cur = target;
          if (first) {
            start = target;
            first = false;
          }
        }
        break;
      }
      case 'L': {
        for (const pt of seg.points) {
          const target = rel ? add(cur, pt) : pt;
          sampleLine(cur, target, waypoints);
          cur = target;
        }
        break;
      }
      case 'C': {
        for (let i = 0; i < seg.points.length; i += 3) {
          const cp1 = rel ? add(cur, seg.points[i]) : seg.points[i];
          const cp2 = rel ? add(cur, seg.points[i + 1]) : seg.points[i + 1];
          const end = rel ? add(cur, seg.points[i + 2]) : seg.points[i + 2];
          sampleCubic(cur, cp1, cp2, end, waypoints);
          cur = end;
        }
        break;
      }
      case 'Q': {
        for (let i = 0; i < seg.points.length; i += 2) {
          const cp = rel ? add(cur, seg.points[i]) : seg.points[i];
          const end = rel ? add(cur, seg.points[i + 1]) : seg.points[i + 1];
          sampleQuad(cur, cp, end, waypoints);
          cur = end;
        }
        break;
      }
      case 'Z': {
        if (cur.x !== start.x || cur.y !== start.y) {
          sampleLine(cur, start, waypoints);
          cur = start;
        }
        break;
      }
    }
  }

  return waypoints;
}

/** Total pixel length of a waypoint array */
export function pathLength(waypoints: Point[]): number {
  let len = 0;
  for (let i = 1; i < waypoints.length; i++) {
    len += dist(waypoints[i - 1], waypoints[i]);
  }
  return len;
}

/** Default duration from path length (~2ms/px, min 100ms) */
export function defaultDuration(waypoints: Point[]): number {
  return Math.max(100, Math.round(pathLength(waypoints) * 2));
}

// ── helpers ──

function add(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y };
}

function dist(a: Point, b: Point): number {
  return Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
}

function sampleLine(from: Point, to: Point, out: Point[]): void {
  const d = dist(from, to);
  const n = Math.max(1, Math.ceil(d / SAMPLE_SPACING));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    out.push({
      x: Math.round(from.x + (to.x - from.x) * t),
      y: Math.round(from.y + (to.y - from.y) * t),
    });
  }
}

function sampleCubic(p0: Point, p1: Point, p2: Point, p3: Point, out: Point[]): void {
  const chord = dist(p0, p1) + dist(p1, p2) + dist(p2, p3);
  const n = Math.max(1, Math.ceil(chord / SAMPLE_SPACING));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push({
      x: Math.round(u ** 3 * p0.x + 3 * u ** 2 * t * p1.x + 3 * u * t ** 2 * p2.x + t ** 3 * p3.x),
      y: Math.round(u ** 3 * p0.y + 3 * u ** 2 * t * p1.y + 3 * u * t ** 2 * p2.y + t ** 3 * p3.y),
    });
  }
}

function sampleQuad(p0: Point, cp: Point, p2: Point, out: Point[]): void {
  const chord = dist(p0, cp) + dist(cp, p2);
  const n = Math.max(1, Math.ceil(chord / SAMPLE_SPACING));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push({
      x: Math.round(u ** 2 * p0.x + 2 * u * t * cp.x + t ** 2 * p2.x),
      y: Math.round(u ** 2 * p0.y + 2 * u * t * cp.y + t ** 2 * p2.y),
    });
  }
}

// ── tokenizer ──

interface Segment {
  type: string;
  points: Point[];
}

function tokenize(path: string): Segment[] {
  const segs: Segment[] = [];
  const re = /([MLCQZmlcqz])([^MLCQZmlcqz]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path.trim())) !== null) {
    const pts = parseCoords(m[2]);
    if (pts.length > 0) {
      segs.push({ type: m[1], points: pts });
    }
  }
  return segs;
}

function parseCoords(s: string): Point[] {
  const pts: Point[] = [];
  const nums = s
    .replace(/,/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
  for (let i = 0; i + 1 < nums.length; i += 2) {
    if (!isNaN(nums[i]) && !isNaN(nums[i + 1])) {
      pts.push({ x: nums[i], y: nums[i + 1] });
    }
  }
  return pts;
}
