import { Color } from 'playcanvas';

// Safety configuration for drone waypoint / route obstacle avoidance.
//
// P0 scope: read-only validation. Waypoints and route segments are measured
// against this configuration and coloured by the resulting level, but their
// positions are never modified (that arrives with P1/P2).

interface SafetyConfig {
    // physical radius of the drone including propellers (metres)
    droneRadius: number;
    // additional clearance required around the obstacle (metres)
    safetyMargin: number;
    // gaussians below this opacity are considered floaters and ignored
    opacityThreshold: number;
    // target voxel edge length of the spatial index (metres)
    voxelSize: number;
    // hard cap on the number of voxels (memory guard)
    maxCells: number;
    // distance queries are truncated to this value (metres)
    maxClearance: number;
    // sampling step used when sweeping a route segment (metres)
    segmentStep: number;
    // upper bound on the samples taken per segment (guards very long legs)
    maxSegmentSamples: number;
    // preferred distance from the sample point to the hover point. P1 searches
    // around this distance instead of applying it blindly.
    hoverDistance: number;

    // ── P1: hover point search ──
    // radius used to gather surface neighbours when estimating the normal
    normalRadius: number;
    // neighbours required before the normal is trusted
    normalMinPoints: number;
    // half angle of the search cap around the surface normal (degrees)
    capAngleDeg: number;
    // distance multipliers (of hoverDistance) tried when searching
    distanceScales: number[];
    // absolute bounds applied to the searched distance
    minDistance: number;
    maxDistance: number;
    // clearance required along the line from the hover point to its target
    sightClearance: number;
    // directions sampled on the search cap
    searchDirections: number;

    // ── P2: detour planning ──
    // preferred edge length of the detour grid
    detourCell: number;
    // upper bound on detour grid cells (memory guard)
    detourMaxCells: number;
    // how far a dragged waypoint may be pushed to reach safety
    snapMaxDistance: number;
    // step used while pushing a waypoint out of danger
    snapStep: number;
}

// hardClearance is the constraint that must never be violated: the drone body
// plus the operator's safety margin.
const DEFAULT_SAFETY_CONFIG: SafetyConfig = {
    droneRadius: 0.5,
    safetyMargin: 1,
    opacityThreshold: 0.15,
    voxelSize: 0.5,
    maxCells: 4000000,
    maxClearance: 12.0,
    segmentStep: 0.25,
    maxSegmentSamples: 400,
    hoverDistance: 3.2,

    // P1
    normalRadius: 0.4,
    normalMinPoints: 12,
    capAngleDeg: 60,
    distanceScales: [0.6, 0.8, 1.0, 1.3],
    minDistance: 1.0,
    maxDistance: 20.0,
    sightClearance: 0.5,
    searchDirections: 96,

    // P2
    detourCell: 1.0,
    detourMaxCells: 250000,
    snapMaxDistance: 6.0,
    snapStep: 0.25
};

// result of measuring a point against the safety config
enum SafetyLevel {
    unknown = -1,   // obstacle field not available
    danger = 0,     // violates the hard constraint
    safe = 1
}

const SAFETY_LEVEL_COLORS: Record<SafetyLevel, Color> = {
    [SafetyLevel.unknown]: new Color(0, 0.5, 1),
    [SafetyLevel.danger]: new Color(1, 0.15, 0.1),
    [SafetyLevel.safe]: new Color(0, 0.5, 1)
};

const hardClearance = (config: SafetyConfig) => config.droneRadius + config.safetyMargin;

// negative (unknown) clearance maps to unknown so callers can tell the
// difference between 'not measured' and 'measured as zero'
const levelOf = (clearance: number, config: SafetyConfig) => {
    if (clearance < 0) return SafetyLevel.unknown;
    if (clearance < hardClearance(config)) return SafetyLevel.danger;
    return SafetyLevel.safe;
};

const levelColor = (level: SafetyLevel) => SAFETY_LEVEL_COLORS[level] ?? SAFETY_LEVEL_COLORS[SafetyLevel.unknown];

export { SafetyLevel, DEFAULT_SAFETY_CONFIG, hardClearance, levelOf, levelColor };
export type { SafetyConfig };
