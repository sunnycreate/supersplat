// Exact euclidean distance transform over a 3D grid (Felzenszwalb & Huttenlocher).
//
// Used by the detour planner to turn occupied cells into a clearance field:
// each cell ends up with the squared distance (in cell units) to the closest
// occupied cell. Cost is O(cells) with three separable passes.

const INF = 1e20;

// 1D squared distance transform along a single axis.
// `f` holds the input values, `d` receives the transformed ones. They must be
// distinct arrays: the second loop writes d[q] while still reading f[v[k]].
const dt1d = (f: Float32Array, d: Float32Array, v: Int32Array, z: Float32Array, n: number) => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;

    for (let q = 1; q < n; q++) {
        let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        while (s <= z[k]) {
            k--;
            s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        }
        k++;
        v[k] = q;
        z[k] = s;
        z[k + 1] = INF;
    }

    k = 0;
    for (let q = 0; q < n; q++) {
        while (z[k + 1] < q) k++;
        const dq = q - v[k];
        d[q] = dq * dq + f[v[k]];
    }
};

// `seed` marks the occupied cells (non-zero). Returns squared distances in cell
// units (the caller owns the returned buffer).
const edt3d = (seed: Uint8Array, dimX: number, dimY: number, dimZ: number): Float32Array => {
    const num = dimX * dimY * dimZ;
    const f = new Float32Array(num);
    for (let i = 0; i < num; i++) {
        f[i] = seed[i] ? 0 : INF;
    }

    const maxDim = Math.max(dimX, dimY, dimZ);
    const src = new Float32Array(maxDim);
    const dst = new Float32Array(maxDim);
    const v = new Int32Array(maxDim + 1);
    const z = new Float32Array(maxDim + 2);

    // x pass
    for (let iz = 0; iz < dimZ; iz++) {
        for (let iy = 0; iy < dimY; iy++) {
            const base = (iz * dimY + iy) * dimX;
            for (let ix = 0; ix < dimX; ix++) src[ix] = f[base + ix];
            dt1d(src, dst, v, z, dimX);
            for (let ix = 0; ix < dimX; ix++) f[base + ix] = dst[ix];
        }
    }

    // y pass
    for (let iz = 0; iz < dimZ; iz++) {
        for (let ix = 0; ix < dimX; ix++) {
            for (let iy = 0; iy < dimY; iy++) src[iy] = f[(iz * dimY + iy) * dimX + ix];
            dt1d(src, dst, v, z, dimY);
            for (let iy = 0; iy < dimY; iy++) f[(iz * dimY + iy) * dimX + ix] = dst[iy];
        }
    }

    // z pass
    for (let iy = 0; iy < dimY; iy++) {
        for (let ix = 0; ix < dimX; ix++) {
            for (let iz = 0; iz < dimZ; iz++) src[iz] = f[(iz * dimY + iy) * dimX + ix];
            dt1d(src, dst, v, z, dimZ);
            for (let iz = 0; iz < dimZ; iz++) f[(iz * dimY + iy) * dimX + ix] = dst[iz];
        }
    }

    return f;
};

export { edt3d };
