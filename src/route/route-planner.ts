import { Vec3 } from 'playcanvas';

import { edt3d } from './edt';
import { SafetyConfig, hardClearance } from './safety-config';

// Minimal contract the planner needs from the clearance field. Structural, so
// the real ClearanceField satisfies it — and tests can provide a stub.
interface FieldAdapter {
    clearance(p: Vec3): number;
    nearestObstacle(p: Vec3, out: Vec3): number;
    segmentMinClearance(a: Vec3, b: Vec3): { clearance: number; t: number; point: Vec3 };
    forEachObstaclePoint(cb: (x: number, y: number, z: number) => void): void;
    forEachWithin(p: Vec3, radius: number, cb: (x: number, y: number, z: number) => void): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// P1: solving a safe hover point for a sample point
// ─────────────────────────────────────────────────────────────────────────────

const tmpA = new Vec3();
const tmpB = new Vec3();
const tmpC = new Vec3();
const tmpProbe = new Vec3();

const DEG_TO_RAD = Math.PI / 180;

// Smallest eigenvector of a 3x3 covariance matrix, found with power iteration on
// (trace·I − C): its dominant eigenvector is C's smallest one.
const covarianceNormal = (pts: number[], out: Vec3): boolean => {
    const n = pts.length / 3;
    if (n < 3) return false;

    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let i = 0; i < n; i++) {
        cx += pts[i * 3];
        cy += pts[i * 3 + 1];
        cz += pts[i * 3 + 2];
    }
    cx /= n;
    cy /= n;
    cz /= n;

    let xx = 0;
    let xy = 0;
    let xz = 0;
    let yy = 0;
    let yz = 0;
    let zz = 0;
    for (let i = 0; i < n; i++) {
        const dx = pts[i * 3] - cx;
        const dy = pts[i * 3 + 1] - cy;
        const dz = pts[i * 3 + 2] - cz;
        xx += dx * dx;
        xy += dx * dy;
        xz += dx * dz;
        yy += dy * dy;
        yz += dy * dz;
        zz += dz * dz;
    }
    xx /= n;
    xy /= n;
    xz /= n;
    yy /= n;
    yz /= n;
    zz /= n;

    const trace = xx + yy + zz;
    const m = [
        trace - xx, -xy, -xz,
        -xy, trace - yy, -yz,
        -xz, -yz, trace - zz
    ];

    let vx = 1;
    let vy = 0;
    let vz = 0;
    for (let iter = 0; iter < 64; iter++) {
        const nx = m[0] * vx + m[1] * vy + m[2] * vz;
        const ny = m[3] * vx + m[4] * vy + m[5] * vz;
        const nz = m[6] * vx + m[7] * vy + m[8] * vz;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (len < 1e-12) {
            vx = 0;
            vy = 1;
            vz = 0;
            continue;
        }
        vx = nx / len;
        vy = ny / len;
        vz = nz / len;
    }

    out.set(vx, vy, vz);
    return true;
};

// Estimate the surface normal at p from its gaussian neighbourhood. The radius
// grows until enough neighbours are found (sparse reconstructions).
const surfaceNormal = (field: FieldAdapter, p: Vec3, config: SafetyConfig, out: Vec3): boolean => {
    let radius = config.normalRadius;
    let best: number[] = null;

    for (let attempt = 0; attempt < 4; attempt++) {
        const pts: number[] = [];
        field.forEachWithin(p, radius, (x, y, z) => {
            pts.push(x, y, z);
        });

        if (!best || pts.length > best.length) {
            best = pts;
        }
        if (best.length / 3 >= config.normalMinPoints) {
            break;
        }
        radius *= 2;
    }

    if (!best || best.length / 3 < 3) {
        return false;
    }

    return covarianceNormal(best, out);
};

// directions evenly spread over the cap around `normal`
const capDirections = (normal: Vec3, capAngleDeg: number, count: number): Vec3[] => {
    const up = Math.abs(normal.y) < 0.9 ? new Vec3(0, 1, 0) : new Vec3(1, 0, 0);
    const tx = new Vec3().cross(up, normal).normalize();
    const ty = new Vec3().cross(normal, tx);

    const golden = Math.PI * (3 - Math.sqrt(5));
    const minCos = Math.cos(capAngleDeg * DEG_TO_RAD);
    const dirs: Vec3[] = [];

    for (let i = 0; i < count; i++) {
        const y = 1 - (i / Math.max(1, count - 1)) * 2;
        const r = Math.sqrt(Math.max(0, 1 - y * y));
        const theta = golden * i;
        const x = Math.cos(theta) * r;
        const z = Math.sin(theta) * r;

        // the last 15% of the sphere is far outside the cap — skip it
        if (y < minCos) continue;

        dirs.push(new Vec3(
            tx.x * x + ty.x * z + normal.x * y,
            tx.y * x + ty.y * z + normal.y * y,
            tx.z * x + ty.z * z + normal.z * y
        ).normalize());
    }

    return dirs;
};

// true when the drone can see the target from `from`. the last stretch stops
// short of the surface: the target itself sits on the model so its clearance is
// always ~0.
const hasLineOfSight = (field: FieldAdapter, from: Vec3, to: Vec3, minClear: number, tEnd = 0.85): boolean => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const steps = Math.max(1, Math.ceil(distance / 0.25));
    const last = Math.floor(steps * tEnd);

    for (let i = 0; i <= last; i++) {
        const t = i / steps;
        tmpProbe.set(from.x + dx * t, from.y + dy * t, from.z + dz * t);
        const c = field.clearance(tmpProbe);
        if (c >= 0 && c < minClear) {
            return false;
        }
    }

    return true;
};

// Find a safe hover point for a sample point:
//   1. real surface normal (neighbourhood PCA), oriented towards open space
//   2. search a cap of candidate directions × distances, keeping only those
//      that clear the hard constraint and can still see the target
//   3. score by clearance, angular deviation and distance to the preferred one
// Returns ok=false when nothing safe exists — the caller then skips the point
// and warns rather than emitting an unsafe waypoint.
const solveHoverPoint = (
    field: FieldAdapter,
    samplePos: Vec3,
    fallbackNormal: Vec3,
    config: SafetyConfig
): { position: Vec3; ok: boolean; clearance: number; normal: Vec3 } => {
    const normal = new Vec3();
    const surfaceNormalOk = surfaceNormal(field, samplePos, config, normal);
    if (!surfaceNormalOk) {
        normal.copy(fallbackNormal);
        if (normal.lengthSq() < 1e-8) {
            normal.set(0, 1, 0);
        }
        normal.normalize();
    }

    // fallback sign decision: compare clearance at ±d0 probes. the unsigned
    // field makes this ambiguous on thin shells (underground looks just as
    // open as the sky), so it is only used when no view-direction prior
    // exists or the PCA axis is orthogonal to it.
    const orientByProbes = () => {
        const d0 = Math.max(config.minDistance, config.hoverDistance);
        tmpA.copy(samplePos).add(tmpB.copy(normal).mulScalar(d0));
        const plusClearance = field.clearance(tmpA);
        tmpC.copy(samplePos).add(tmpB.copy(normal).mulScalar(-d0));
        if (field.clearance(tmpC) > plusClearance) {
            normal.mulScalar(-1);
        }
    };

    if (surfaceNormalOk) {
        if (fallbackNormal.lengthSq() > 1e-8) {
            // the click that placed the sample point captured the view
            // direction: the outward side always faces the camera. PCA only
            // yields an unsigned axis, so fix its sign against the view —
            // ground samples then keep pointing up instead of being flipped
            // underground by near-symmetric clearance probes.
            const dot = normal.dot(fallbackNormal);
            if (dot < -0.3) {
                normal.mulScalar(-1);
            } else if (dot <= 0.3) {
                // axis disagrees with the view (degenerate neighbourhood) —
                // keep the PCA axis and let the probes decide the sign
                orientByProbes();
            }
        } else {
            orientByProbes();
        }
    }

    const hard = hardClearance(config);
    // aim above the hard floor so freshly created waypoints don't hug the
    // safety limit — segment chords and field discretization can shave ~0.1 m
    // off the measured minimum (e.g. hard 7.0 → hover points land at ~7.5)
    const target = hard + config.hoverBuffer;
    const dirs = capDirections(normal, config.capAngleDeg, config.searchDirections);

    // cap search: candidates on the normal's cap × distance scales, scored by
    // clearance, angular deviation and distance to the preferred one
    const search = (minClearance: number): { position: Vec3; clearance: number } | null => {
        let best: Vec3 = null;
        let bestScore = -Infinity;
        let bestClearance = -1;

        for (const scale of config.distanceScales) {
            const distance = Math.min(config.maxDistance, Math.max(config.minDistance, config.hoverDistance * scale));

            for (const dir of dirs) {
                tmpA.copy(samplePos).add(tmpB.copy(dir).mulScalar(distance));

                const c = field.clearance(tmpA);
                if (c < minClearance) continue;

                const angle = Math.acos(Math.min(1, Math.max(-1, dir.dot(normal))));
                if (!hasLineOfSight(field, tmpA, samplePos, config.sightClearance)) continue;

                const score = Math.min(c, hard * 2) -
                              angle * hard * 0.5 -
                              Math.abs(distance - config.hoverDistance) * 0.5;

                if (score > bestScore) {
                    bestScore = score;
                    best = tmpA.clone();
                    bestClearance = c;
                }
            }
        }

        return best ? { position: best, clearance: bestClearance } : null;
    };

    // last resort: straight out along the normal, as far as allowed
    const straightOut = (minClearance: number): { position: Vec3; clearance: number } | null => {
        for (let d = config.minDistance; d <= config.maxDistance; d += 0.5) {
            tmpA.copy(samplePos).add(tmpB.copy(normal).mulScalar(d));
            if (field.clearance(tmpA) >= minClearance &&
                hasLineOfSight(field, tmpA, samplePos, config.sightClearance)) {
                return { position: tmpA.clone(), clearance: field.clearance(tmpA) };
            }
        }
        return null;
    };

    // prefer the buffered tier; the plain hard floor is the fallback so tight
    // spots still get a (barely legal) waypoint instead of being skipped
    const found = search(target) ?? search(hard) ?? straightOut(target) ?? straightOut(hard);

    if (!found) {
        return { position: samplePos.clone(), ok: false, clearance: -1, normal: normal.clone() };
    }

    return { position: found.position, ok: true, clearance: found.clearance, normal: normal.clone() };
};

// ─────────────────────────────────────────────────────────────────────────────
// P2: detour planning between two waypoints
// ─────────────────────────────────────────────────────────────────────────────

// binary heap over cell indices, ordered by an external score array
class CellHeap {
    private data: number[] = [];
    private score: Float32Array;

    constructor(score: Float32Array) {
        this.score = score;
    }

    get size() {
        return this.data.length;
    }

    push(index: number) {
        const { data, score } = this;
        data.push(index);
        let i = data.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (score[data[parent]] <= score[data[i]]) break;
            const t = data[parent];
            data[parent] = data[i];
            data[i] = t;
            i = parent;
        }
    }

    pop(): number {
        const { data, score } = this;
        const top = data[0];
        const last = data.pop();
        if (data.length > 0) {
            data[0] = last;
            let i = 0;
            for (;;) {
                const l = i * 2 + 1;
                const r = l + 1;
                let m = i;
                if (l < data.length && score[data[l]] < score[data[m]]) m = l;
                if (r < data.length && score[data[r]] < score[data[m]]) m = r;
                if (m === i) break;
                const t = data[m];
                data[m] = data[i];
                data[i] = t;
                i = m;
            }
        }
        return top;
    }
}

const NEIGHBOURS: number[][] = [];
for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
        for (let oz = -1; oz <= 1; oz++) {
            if (ox === 0 && oy === 0 && oz === 0) continue;
            NEIGHBOURS.push([ox, oy, oz, Math.sqrt(ox * ox + oy * oy + oz * oz)]);
        }
    }
}

// drop intermediate points that can be skipped while staying safe
const shortcut = (field: FieldAdapter, pts: Vec3[], hard: number): Vec3[] => {
    if (pts.length <= 2) return pts;

    const out: Vec3[] = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
        let j = pts.length - 1;
        for (; j > i + 1; j--) {
            if (field.segmentMinClearance(pts[i], pts[j]).clearance >= hard) break;
        }
        out.push(pts[j]);
        i = j;
    }
    return out;
};

// Deterministic detour of last resort: when the grid search finds no path
// (the detour would have to leave the search volume, or the free cells do
// not connect), push a single relay point out from the leg's worst-clearance
// spot along the away-from-obstacle direction until both resulting sub-legs
// measure safe. Cruder than the A* detour, but it resolves the common 'leg
// grazing an obstacle' case that has a clear escape direction.
const relayDetour = (field: FieldAdapter, a: Vec3, b: Vec3, hard: number): Vec3[] | null => {
    const worst = field.segmentMinClearance(a, b);
    if (worst.clearance < 0) return null;

    // away-from-obstacle direction at the worst spot
    const obstacle = new Vec3();
    field.nearestObstacle(worst.point, obstacle);
    const away = tmpA.sub2(worst.point, obstacle);
    if (away.lengthSq() < 1e-9) return null;
    away.normalize();

    // leg direction, used to tilt the relay towards either end so that the
    // sub-legs are easier to clear
    const seg = tmpB.sub2(b, a).normalize();

    const dirs: Vec3[] = [away];
    for (const k of [0.5, -0.5, 1.0, -1.0]) {
        dirs.push(new Vec3().copy(away).add(new Vec3().copy(seg).mulScalar(k)).normalize());
    }

    for (const dir of dirs) {
        for (const dist of [hard, hard * 1.5, hard * 2, hard * 3]) {
            const cand = new Vec3().copy(worst.point).add(dir.clone().mulScalar(dist));
            if (field.clearance(cand) < hard) continue;
            if (field.segmentMinClearance(a, cand).clearance < hard) continue;
            if (field.segmentMinClearance(cand, b).clearance < hard) continue;
            return [cand];
        }
    }
    return null;
};

// Plan a safe path from a to b.
//   []      — the straight leg is already safe
//   null    — no safe path could be found (caller keeps the straight leg)
//   Vec3[]  — intermediate points to insert between a and b
const planDetour = (field: FieldAdapter, a: Vec3, b: Vec3, config: SafetyConfig): Vec3[] | null => {
    const hard = hardClearance(config);

    if (field.segmentMinClearance(a, b).clearance >= hard) {
        return [];
    }

    // grid covering both endpoints plus room to manoeuvre around intervening
    // structure — the detour often has to leave the corridor between the two
    // waypoints entirely (e.g. climb over an obstacle)
    const span = Math.max(8, a.distance(b) * 0.3);
    const minX = Math.min(a.x, b.x) - span;
    const minY = Math.min(a.y, b.y) - span;
    const minZ = Math.min(a.z, b.z) - span;
    const maxX = Math.max(a.x, b.x) + span;
    const maxY = Math.max(a.y, b.y) + span;
    const maxZ = Math.max(a.z, b.z) + span;

    const volume = Math.max(1e-3, (maxX - minX) * (maxY - minY) * (maxZ - minZ));
    let cell = config.detourCell;
    if (volume / (cell * cell * cell) > config.detourMaxCells) {
        cell = Math.cbrt(volume / config.detourMaxCells);
    }

    const dimX = Math.max(3, Math.ceil((maxX - minX) / cell) + 1);
    const dimY = Math.max(3, Math.ceil((maxY - minY) / cell) + 1);
    const dimZ = Math.max(3, Math.ceil((maxZ - minZ) / cell) + 1);
    const numCells = dimX * dimY * dimZ;

    // seed cells that contain geometry
    const seed = new Uint8Array(numCells);
    field.forEachObstaclePoint((x, y, z) => {
        const ix = Math.floor((x - minX) / cell);
        const iy = Math.floor((y - minY) / cell);
        const iz = Math.floor((z - minZ) / cell);
        if (ix < 0 || iy < 0 || iz < 0 || ix >= dimX || iy >= dimY || iz >= dimZ) return;
        seed[(iz * dimY + iy) * dimX + ix] = 1;
    });

    const dist2 = edt3d(seed, dimX, dimY, dimZ);

    // a cell is usable when even its worst corner clears the constraint. the
    // clearance field is 1-lipschitz, so half a cell diagonal (√3/2 · cell) is
    // the worst-case error between a cell centre and any point inside it or on a
    // segment joining two centres.
    const bias = cell * 0.8660254;
    const threshold = hard + bias;
    const isFree = (index: number) => Math.sqrt(dist2[index]) * cell >= threshold;

    const cellOf = (p: Vec3) => {
        const ix = Math.min(dimX - 1, Math.max(0, Math.floor((p.x - minX) / cell)));
        const iy = Math.min(dimY - 1, Math.max(0, Math.floor((p.y - minY) / cell)));
        const iz = Math.min(dimZ - 1, Math.max(0, Math.floor((p.z - minZ) / cell)));
        return (iz * dimY + iy) * dimX + ix;
    };

    const startIndex = cellOf(a);
    const goalIndex = cellOf(b);

    const g = new Float32Array(numCells).fill(Infinity);
    const f = new Float32Array(numCells).fill(Infinity);
    const cameFrom = new Int32Array(numCells).fill(-1);
    const closed = new Uint8Array(numCells);

    const cellCentre = (index: number) => {
        const ix = index % dimX;
        const iy = Math.floor(index / dimX) % dimY;
        const iz = Math.floor(index / (dimX * dimY));
        return new Vec3(
            minX + (ix + 0.5) * cell,
            minY + (iy + 0.5) * cell,
            minZ + (iz + 0.5) * cell
        );
    };

    const goal = cellCentre(goalIndex);
    const heuristic = (index: number) => {
        const ix = index % dimX;
        const iy = Math.floor(index / dimX) % dimY;
        const iz = Math.floor(index / (dimX * dimY));
        const dx = (minX + (ix + 0.5) * cell) - goal.x;
        const dy = (minY + (iy + 0.5) * cell) - goal.y;
        const dz = (minZ + (iz + 0.5) * cell) - goal.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    };

    g[startIndex] = 0;
    f[startIndex] = heuristic(startIndex);

    const heap = new CellHeap(f);
    heap.push(startIndex);

    let found = startIndex === goalIndex;
    let guard = numCells * 8;

    while (heap.size > 0 && guard-- > 0) {
        const current = heap.pop();
        if (closed[current]) continue;
        closed[current] = 1;

        if (current === goalIndex) {
            found = true;
            break;
        }

        const ix = current % dimX;
        const iy = Math.floor(current / dimX) % dimY;
        const iz = Math.floor(current / (dimX * dimY));

        for (const [ox, oy, oz, weight] of NEIGHBOURS) {
            const nx = ix + ox;
            const ny = iy + oy;
            const nz = iz + oz;
            if (nx < 0 || ny < 0 || nz < 0 || nx >= dimX || ny >= dimY || nz >= dimZ) continue;

            const ni = (nz * dimY + ny) * dimX + nx;
            if (ni !== goalIndex && !isFree(ni)) continue;
            if (closed[ni]) continue;

            const tentative = g[current] + weight * cell;
            if (tentative < g[ni]) {
                g[ni] = tentative;
                f[ni] = tentative + heuristic(ni);
                cameFrom[ni] = current;
                heap.push(ni);
            }
        }
    }

    if (!found) {
        // grid search failed — try the cheap deterministic relay before
        // giving up and keeping the straight (unsafe) leg
        return relayDetour(field, a, b, hard);
    }

    // rebuild the path
    const raw: Vec3[] = [];
    let node = goalIndex;
    while (node !== -1 && node !== startIndex) {
        raw.push(cellCentre(node));
        node = cameFrom[node];
    }
    raw.push(a.clone());
    raw.reverse();

    const simplified = shortcut(field, raw, hard);

    // drop the endpoints: the caller already has them
    return simplified.slice(1, simplified.length - 1);
};

// ─────────────────────────────────────────────────────────────────────────────
// P2: snapping a dragged waypoint back into safety
// ─────────────────────────────────────────────────────────────────────────────

// Push p away from whatever it is too close to until it satisfies the hard
// constraint. Returns ok=false when that isn't possible within snapMaxDistance,
// in which case the caller should restore the previous position.
const snapToSafe = (field: FieldAdapter, p: Vec3, config: SafetyConfig): { position: Vec3; ok: boolean } => {
    const hard = hardClearance(config);
    const current = p.clone();

    if (field.clearance(current) >= hard) {
        return { position: current, ok: true };
    }

    const anchor = new Vec3();
    const iterations = Math.ceil(config.snapMaxDistance / config.snapStep);

    for (let i = 0; i < iterations; i++) {
        const d = field.nearestObstacle(current, anchor);
        if (d < 0 || d >= hard) break;

        tmpB.sub2(current, anchor);
        if (tmpB.lengthSq() < 1e-8) {
            tmpB.set(0, 1, 0);
        }
        tmpB.normalize().mulScalar(config.snapStep);
        current.add(tmpB);
    }

    if (field.clearance(current) >= hard) {
        return { position: current, ok: true };
    }

    return { position: p.clone(), ok: false };
};

export { solveHoverPoint, planDetour, snapToSafe, surfaceNormal };
