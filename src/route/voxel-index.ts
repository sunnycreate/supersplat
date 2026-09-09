import { Vec3 } from 'playcanvas';

// Sparse spatial index over the obstacle point cloud.
//
// Points are bucketed into a uniform grid (CSR layout: cellStart + cellItems).
// On top of that sits a mip pyramid of occupancy bitmaps so a nearest-neighbour
// query can discard whole regions with an AABB distance test instead of walking
// every cell inside the search radius. Queries are exact (they return the true
// distance to the closest point, truncated at the caller's maxDist).

interface Level {
    dimX: number;
    dimY: number;
    dimZ: number;
    // 1 when the cell contains at least one point (finest level) or at least
    // one occupied child (coarser levels)
    occ: Uint8Array;
}

class VoxelIndex {
    voxel = 1;
    minX = 0;
    minY = 0;
    minZ = 0;
    count = 0;

    private positions: Float32Array = null;
    private levels: Level[] = [];
    private cellStart: Int32Array = null;
    private cellItems: Int32Array = null;

    // query/insert scratch (avoids per-call allocation)
    private stack = new Int32Array(4096);
    private childOrder: { d2: number; x: number; y: number; z: number }[] = [];

    reset() {
        this.count = 0;
        this.positions = null;
        this.levels = [];
        this.cellStart = null;
        this.cellItems = null;
    }

    get built() {
        return this.levels.length > 0 && this.count > 0;
    }

    get cellSize() {
        return this.voxel;
    }

    // bucket every point and build the occupancy mips.
    // voxelSize is a target: it is grown until the grid fits inside maxCells so
    // a huge or badly scaled scene can't exhaust memory.
    build(positions: Float32Array, count: number, targetVoxel: number, maxCells: number) {
        this.reset();

        if (!positions || count === 0) {
            return;
        }

        let minX = Infinity;
        let minY = Infinity;
        let minZ = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        let maxZ = -Infinity;

        for (let i = 0; i < count; i++) {
            const x = positions[i * 3 + 0];
            const y = positions[i * 3 + 1];
            const z = positions[i * 3 + 2];
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (z < minZ) minZ = z;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
            if (z > maxZ) maxZ = z;
        }

        if (!Number.isFinite(minX)) {
            return;
        }

        let voxel = Math.max(targetVoxel, 1e-4);
        let dimX = 1;
        let dimY = 1;
        let dimZ = 1;
        for (let attempt = 0; attempt < 64; attempt++) {
            dimX = Math.max(1, Math.floor((maxX - minX) / voxel) + 1);
            dimY = Math.max(1, Math.floor((maxY - minY) / voxel) + 1);
            dimZ = Math.max(1, Math.floor((maxZ - minZ) / voxel) + 1);
            if (dimX * dimY * dimZ <= maxCells) {
                break;
            }
            voxel *= 1.5;
        }

        const numCells = dimX * dimY * dimZ;

        this.voxel = voxel;
        this.minX = minX;
        this.minY = minY;
        this.minZ = minZ;
        this.count = count;
        this.positions = positions;

        // counting sort into CSR buckets
        const cellStart = new Int32Array(numCells + 1);
        const cellOf = new Int32Array(count);

        for (let i = 0; i < count; i++) {
            const ix = Math.min(dimX - 1, Math.max(0, Math.floor((positions[i * 3 + 0] - minX) / voxel)));
            const iy = Math.min(dimY - 1, Math.max(0, Math.floor((positions[i * 3 + 1] - minY) / voxel)));
            const iz = Math.min(dimZ - 1, Math.max(0, Math.floor((positions[i * 3 + 2] - minZ) / voxel)));
            const id = (iz * dimY + iy) * dimX + ix;
            cellOf[i] = id;
            cellStart[id + 1]++;
        }

        for (let c = 0; c < numCells; c++) {
            cellStart[c + 1] += cellStart[c];
        }

        const cursor = cellStart.slice(0, numCells);
        const cellItems = new Int32Array(count);
        for (let i = 0; i < count; i++) {
            cellItems[cursor[cellOf[i]]++] = i;
        }

        this.cellStart = cellStart;
        this.cellItems = cellItems;

        // finest occupancy level
        const occ0 = new Uint8Array(numCells);
        for (let c = 0; c < numCells; c++) {
            if (cellStart[c + 1] > cellStart[c]) {
                occ0[c] = 1;
            }
        }
        this.levels = [{ dimX, dimY, dimZ, occ: occ0 }];

        // coarser levels, halving until the grid collapses to a single cell
        let cx = dimX;
        let cy = dimY;
        let cz = dimZ;
        let prev = occ0;
        while (cx > 1 || cy > 1 || cz > 1) {
            const nx = Math.max(1, Math.ceil(cx / 2));
            const ny = Math.max(1, Math.ceil(cy / 2));
            const nz = Math.max(1, Math.ceil(cz / 2));
            const occ = new Uint8Array(nx * ny * nz);

            for (let z = 0; z < cz; z++) {
                for (let y = 0; y < cy; y++) {
                    for (let x = 0; x < cx; x++) {
                        if (prev[(z * cy + y) * cx + x]) {
                            occ[((z >> 1) * ny + (y >> 1)) * nx + (x >> 1)] = 1;
                        }
                    }
                }
            }

            this.levels.push({ dimX: nx, dimY: ny, dimZ: nz, occ });
            cx = nx;
            cy = ny;
            cz = nz;
            prev = occ;
        }
    }

    // visit every stored point (world space)
    forEachPoint(cb: (x: number, y: number, z: number) => void) {
        const { positions, count } = this;
        for (let i = 0; i < count; i++) {
            cb(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
        }
    }

    // visit every point within `radius` of the query position
    forEachWithin(px: number, py: number, pz: number, radius: number, cb: (x: number, y: number, z: number) => void) {
        if (!this.built) return;

        const r2 = radius * radius;
        const levels = this.levels;
        const stack: number[] = [levels.length - 1, 0, 0, 0];

        while (stack.length > 0) {
            const iz = stack.pop();
            const iy = stack.pop();
            const ix = stack.pop();
            const lv = stack.pop();

            const level = levels[lv];
            if (!level.occ[(iz * level.dimY + iy) * level.dimX + ix]) {
                continue;
            }

            if (this.cellDist2(lv, ix, iy, iz, px, py, pz) > r2) {
                continue;
            }

            if (lv === 0) {
                const id = (iz * level.dimY + iy) * level.dimX + ix;
                const end = this.cellStart[id + 1];
                for (let k = this.cellStart[id]; k < end; k++) {
                    const p = this.cellItems[k] * 3;
                    const dx = this.positions[p] - px;
                    const dy = this.positions[p + 1] - py;
                    const dz = this.positions[p + 2] - pz;
                    if (dx * dx + dy * dy + dz * dz <= r2) {
                        cb(this.positions[p], this.positions[p + 1], this.positions[p + 2]);
                    }
                }
                continue;
            }

            const child = levels[lv - 1];
            for (let oz = 0; oz < 2; oz++) {
                for (let oy = 0; oy < 2; oy++) {
                    for (let ox = 0; ox < 2; ox++) {
                        const cx = ix * 2 + ox;
                        const cy = iy * 2 + oy;
                        const cz = iz * 2 + oz;
                        if (cx >= child.dimX || cy >= child.dimY || cz >= child.dimZ) {
                            continue;
                        }
                        stack.push(lv - 1, cx, cy, cz);
                    }
                }
            }
        }
    }

    // squared distance from the query point to a cell's AABB (0 when inside)
    private cellDist2(level: number, ix: number, iy: number, iz: number, px: number, py: number, pz: number) {
        const size = this.voxel * (1 << level);
        const x0 = this.minX + ix * size;
        const y0 = this.minY + iy * size;
        const z0 = this.minZ + iz * size;

        const dx = px < x0 ? x0 - px : (px > x0 + size ? px - (x0 + size) : 0);
        const dy = py < y0 ? y0 - py : (py > y0 + size ? py - (y0 + size) : 0);
        const dz = pz < z0 ? z0 - pz : (pz > z0 + size ? pz - (z0 + size) : 0);

        return dx * dx + dy * dy + dz * dz;
    }

    // Distance to the closest point, truncated at maxDist. Returns maxDist when
    // nothing is within that range (which is all the safety check needs).
    nearest(px: number, py: number, pz: number, maxDist: number): number {
        return this.nearestPoint(px, py, pz, maxDist, null);
    }

    // Distance to the closest point; when `out` is given it receives the
    // position of that point (left untouched when nothing is found within
    // maxDist, i.e. when the truncated maxDist is returned).
    nearestPoint(px: number, py: number, pz: number, maxDist: number, out: Vec3 | null): number {
        if (!this.built) {
            return maxDist;
        }

        let best = maxDist;
        let best2 = best * best;
        let bestX = 0;
        let bestY = 0;
        let bestZ = 0;

        const levels = this.levels;
        let sp = 0;
        this.stack[sp++] = levels.length - 1;
        this.stack[sp++] = 0;
        this.stack[sp++] = 0;
        this.stack[sp++] = 0;

        while (sp > 0) {
            let stack = this.stack;
            const iz = stack[--sp];
            const iy = stack[--sp];
            const ix = stack[--sp];
            const lv = stack[--sp];

            const level = levels[lv];
            if (!level.occ[(iz * level.dimY + iy) * level.dimX + ix]) {
                continue;
            }

            const d2 = this.cellDist2(lv, ix, iy, iz, px, py, pz);
            if (d2 >= best2) {
                continue;
            }

            if (lv === 0) {
                const id = (iz * level.dimY + iy) * level.dimX + ix;
                const end = this.cellStart[id + 1];
                for (let k = this.cellStart[id]; k < end; k++) {
                    const p = this.cellItems[k] * 3;
                    const ax = this.positions[p] - px;
                    const ay = this.positions[p + 1] - py;
                    const az = this.positions[p + 2] - pz;
                    const dd = ax * ax + ay * ay + az * az;
                    if (dd < best2) {
                        best2 = dd;
                        bestX = this.positions[p];
                        bestY = this.positions[p + 1];
                        bestZ = this.positions[p + 2];
                    }
                }
                best = Math.sqrt(best2);
                continue;
            }

            // push children nearest-last so the closest one is visited first,
            // tightening `best` as early as possible
            const child = levels[lv - 1];
            const order = this.childOrder;
            order.length = 0;

            for (let oz = 0; oz < 2; oz++) {
                for (let oy = 0; oy < 2; oy++) {
                    for (let ox = 0; ox < 2; ox++) {
                        const cx = ix * 2 + ox;
                        const cy = iy * 2 + oy;
                        const cz = iz * 2 + oz;
                        if (cx >= child.dimX || cy >= child.dimY || cz >= child.dimZ) {
                            continue;
                        }
                        order.push({
                            d2: this.cellDist2(lv - 1, cx, cy, cz, px, py, pz),
                            x: cx,
                            y: cy,
                            z: cz
                        });
                    }
                }
            }

            order.sort((a, b) => b.d2 - a.d2);

            // 8 children at 4 slots each
            if (sp + 32 > stack.length) {
                const grown = new Int32Array(stack.length * 2);
                grown.set(stack);
                this.stack = grown;
                stack = grown;
            }

            for (const c of order) {
                stack[sp++] = lv - 1;
                stack[sp++] = c.x;
                stack[sp++] = c.y;
                stack[sp++] = c.z;
            }
        }

        if (out && best < maxDist) {
            out.set(bestX, bestY, bestZ);
        }

        return best;
    }
}

export { VoxelIndex };
