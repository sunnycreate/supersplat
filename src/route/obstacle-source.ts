import { Vec3 } from 'playcanvas';

import { sigmoid } from '../color-grade';
import { ElementType } from '../element';
import { Scene } from '../scene';
import { Splat } from '../splat';
import { State } from '../splat-state';
import { SafetyConfig } from './safety-config';

// the obstacle cloud: gaussian centres in world space, filtered of everything
// that shouldn't be treated as solid geometry
interface ObstacleCloud {
    // xyz triples, length === count * 3
    positions: Float32Array;
    count: number;
}

const tmp = new Vec3();

// let the browser paint / process input between chunks of a long build so the
// UI never freezes
const yieldToBrowser = () => new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
});

// points are consumed in chunks of this size before yielding
const CHUNK = 1 << 18;

// A cheap fingerprint of everything the obstacle cloud depends on. Used to skip
// rebuilding the spatial index when nothing that affects it has changed.
const obstacleVersion = (scene: Scene) => {
    const splats = scene.getElementsByType(ElementType.splat) as Splat[];
    return splats.map((splat) => {
        const t = splat.entity.getWorldTransform().data;
        let transform = '';
        for (let i = 0; i < 16; i++) {
            transform += t[i].toFixed(4);
            transform += ',';
        }
        return `${splat.changedCounter}:${splat.state.numDeleted}:${splat.numSplats}:${transform}`;
    }).join('|');
};

// Collect the world-space gaussian centres of every splat in the scene.
// Deleted gaussians and low-opacity floaters are dropped: the latter are
// reconstruction noise and would otherwise turn empty air into fake obstacles.
const collectObstaclePoints = async (scene: Scene, config: SafetyConfig): Promise<ObstacleCloud | null> => {
    const splats = scene.getElementsByType(ElementType.splat) as Splat[];
    if (splats.length === 0) {
        return null;
    }

    let capacity = 0;
    for (const splat of splats) {
        capacity += splat.numSplats;
    }
    if (capacity === 0) {
        return null;
    }

    const out = new Float32Array(capacity * 3);
    let count = 0;

    for (const splat of splats) {
        const { splatData } = splat;
        const numSplats = splatData.numSplats;
        const state = splatData.getProp('state') as Uint8Array;
        const opacity = splatData.getProp('opacity') as Float32Array;
        const { centers } = splat.entity.gsplat.instance.sorter;

        if (!centers || centers.length < numSplats * 3) {
            continue;
        }

        const world = splat.entity.getWorldTransform();
        const threshold = config.opacityThreshold;

        for (let i = 0; i < numSplats; i++) {
            if (state && (state[i] & State.deleted)) {
                continue;
            }
            if (opacity && sigmoid(opacity[i]) < threshold) {
                continue;
            }

            tmp.set(centers[i * 3], centers[i * 3 + 1], centers[i * 3 + 2]);
            world.transformPoint(tmp, tmp);

            out[count * 3 + 0] = tmp.x;
            out[count * 3 + 1] = tmp.y;
            out[count * 3 + 2] = tmp.z;
            count++;

            if ((count & (CHUNK - 1)) === 0) {
                await yieldToBrowser();
            }
        }

        await yieldToBrowser();
    }

    if (count === 0) {
        return null;
    }

    return { positions: out.slice(0, count * 3), count };
};

export { collectObstaclePoints, obstacleVersion };
export type { ObstacleCloud };
