import { Entity, Vec3 } from 'playcanvas';

import { Scene } from '../scene';
import { collectObstaclePoints, obstacleVersion } from './obstacle-source';
import { DEFAULT_SAFETY_CONFIG, SafetyConfig, SafetyLevel, hardClearance, levelOf } from './safety-config';
import { VoxelIndex } from './voxel-index';

const tmpNearest = new Vec3();

// measured safety of a single waypoint
interface WaypointSafety {
    entity: Entity;
    clearance: number;
    level: SafetyLevel;
}

// measured safety of the leg between waypoint `index` and `index + 1`
interface SegmentSafety {
    index: number;
    clearance: number;
    level: SafetyLevel;
    point: Vec3;
}

interface RouteSafetyReport {
    // false when no obstacle field could be built (nothing was measured)
    ready: boolean;
    hardClearance: number;
    waypoints: WaypointSafety[];
    segments: SegmentSafety[];
    minClearance: number;
    dangerCount: number;
}

const probe = new Vec3();
const probeB = new Vec3();

// Owns the obstacle field for the current scene: builds the spatial index on
// demand and answers clearance queries against it.
class ClearanceField {
    config: SafetyConfig;

    private version = '';
    private index = new VoxelIndex();
    private buildPromise: Promise<boolean> | null = null;

    constructor(config: Partial<SafetyConfig> = {}) {
        this.config = { ...DEFAULT_SAFETY_CONFIG, ...config };
    }

    setConfig(patch: Partial<SafetyConfig>) {
        Object.assign(this.config, patch);
        this.invalidate();
    }

    get hardClearance() {
        return hardClearance(this.config);
    }

    get ready() {
        return this.index.built;
    }

    get voxelSize() {
        return this.index.cellSize;
    }

    // the field is stale as soon as the splats move, change or are deleted
    invalidate() {
        this.version = '';
        this.index.reset();
    }

    // build (or reuse) the obstacle field for the given scene
    ensureBuilt(scene: Scene): Promise<boolean> {
        if (this.buildPromise) {
            return this.buildPromise;
        }

        const promise = this.build(scene);
        this.buildPromise = promise;

        return promise.then(
            (result) => {
                this.buildPromise = null;
                return result;
            },
            (err) => {
                this.buildPromise = null;
                throw err;
            }
        );
    }

    private async build(scene: Scene): Promise<boolean> {
        const version = obstacleVersion(scene);
        if (this.index.built && version === this.version) {
            return true;
        }

        const cloud = await collectObstaclePoints(scene, this.config);
        if (!cloud) {
            this.invalidate();
            return false;
        }

        this.index.build(cloud.positions, cloud.count, this.config.voxelSize, this.config.maxCells);
        this.version = version;

        return this.index.built;
    }

    // distance to the closest obstacle, truncated at config.maxClearance.
    // returns -1 when the field isn't available
    clearance(p: Vec3): number {
        if (!this.ready) {
            return -1;
        }
        return this.index.nearest(p.x, p.y, p.z, this.config.maxClearance);
    }

    // distance to the closest obstacle, writing its position into `out`.
    // returns -1 when the field isn't available; when nothing is within
    // maxClearance the truncated distance is returned and `out` is untouched
    nearestObstacle(p: Vec3, out: Vec3): number {
        if (!this.ready) {
            return -1;
        }

        const d = this.index.nearestPoint(p.x, p.y, p.z, this.config.maxClearance, tmpNearest);
        if (d < this.config.maxClearance) {
            out.copy(tmpNearest);
        }
        return d;
    }

    levelOf(p: Vec3): SafetyLevel {
        return levelOf(this.clearance(p), this.config);
    }

    // grade a distance that has already been measured
    level(clearance: number): SafetyLevel {
        return levelOf(clearance, this.config);
    }

    // sweep the segment a→b and report the worst point on it
    segmentMinClearance(a: Vec3, b: Vec3): { clearance: number; t: number; point: Vec3 } {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dz = b.z - a.z;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);

        const steps = Math.max(1, Math.min(this.config.maxSegmentSamples, Math.ceil(len / this.config.segmentStep)));

        let min = Infinity;
        let minT = 0;
        probeB.copy(a);

        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            probe.set(a.x + dx * t, a.y + dy * t, a.z + dz * t);
            const c = this.clearance(probe);
            if (c >= 0 && c < min) {
                min = c;
                minT = t;
                probeB.copy(probe);
            }
        }

        return {
            clearance: min === Infinity ? -1 : min,
            t: minT,
            point: probeB.clone()
        };
    }

    // visit every obstacle point (used when seeding the detour grid)
    forEachObstaclePoint(cb: (x: number, y: number, z: number) => void) {
        this.index.forEachPoint(cb);
    }

    // visit every obstacle point within `radius` of p (used for surface normals)
    forEachWithin(p: Vec3, radius: number, cb: (x: number, y: number, z: number) => void) {
        this.index.forEachWithin(p.x, p.y, p.z, radius, cb);
    }

    // steepest-ascent direction of the clearance field (used by P2 snapping)
    gradient(p: Vec3, out: Vec3) {
        const h = Math.max(this.voxelSize, 0.1);

        probe.set(p.x + h, p.y, p.z);
        const px = this.clearance(probe);
        probe.set(p.x - h, p.y, p.z);
        const nx = this.clearance(probe);
        probe.set(p.x, p.y + h, p.z);
        const py = this.clearance(probe);
        probe.set(p.x, p.y - h, p.z);
        const ny = this.clearance(probe);
        probe.set(p.x, p.y, p.z + h);
        const pz = this.clearance(probe);
        probe.set(p.x, p.y, p.z - h);
        const nz = this.clearance(probe);

        out.set((px - nx) / (2 * h), (py - ny) / (2 * h), (pz - nz) / (2 * h));
        return out;
    }
}

export { ClearanceField };
export type { RouteSafetyReport, WaypointSafety, SegmentSafety };
