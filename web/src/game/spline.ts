// Cubic splines through points (Enemy/spline.cpp's TSplinePath: the natural spline of each
// coordinate over a chord-length parameter t in [0, 1]) and the rails that run along one
// (Enemy/graph.cpp's TSplineRail: a graph whose name starts "S_"; a closed loop gets the last and
// the first two nodes repeated around it, so t wraps over the middle). Gooper Blooper's tentacles
// and the lifts of the secret courses ride them.

import { fr, V3, MsWrap, MsGetRotFromZaxis } from './math.js';
import { psVecMag } from './camera/lib.js';

// ---------------------------------------------------------------- TSplinePath
export class SplinePath {
    xs: Float32Array; ys: Float32Array; zs: Float32Array; t10: Float32Array; t14: Float32Array; t18: Float32Array;
    param: Float32Array; deltas: Float32Array; tmp: Float32Array; ok = false;
    constructor(public n: number) {
        const A = () => new Float32Array(n);
        this.xs = A(); this.ys = A(); this.zs = A(); this.t10 = A(); this.t14 = A(); this.t18 = A(); this.param = A(); this.deltas = A(); this.tmp = A();
        for (let i = 0; i < n; i++) this.xs[i] = this.ys[i] = this.zs[i] = i;
    }
    private makeTable(p: Float32Array, c: Float32Array, o: Float32Array) {
        const N = this.n, D = this.deltas, T = this.tmp;
        o[0] = 0; o[N - 1] = 0;
        for (let i = 0; i < N - 1; i++) {
            D[i] = p[i + 1] - p[i];
            T[i + 1] = Math.abs(D[i]) < fr(0.0001) ? 0 : fr(fr(c[i + 1] - c[i]) / D[i]);
        }
        o[1] = fr(-fr(fr(D[0] * o[0]) - fr(T[2] - T[1])));
        T[1] = fr(fr(p[2] - p[0]) * 2);
        for (let i = 1; i < N - 2; i++) {
            if (Math.abs(T[i]) < fr(0.0001)) T[i] = fr(0.0001);
            const k = fr(D[i] / T[i]);
            o[i + 1] = fr(-fr(fr(k * o[i]) - fr(T[i + 2] - T[i + 1])));
            T[i + 1] = fr(fr(fr(p[i + 2] - p[i]) * 2) - fr(k * D[i]));
        }
        o[N - 2] = fr(o[N - 2] - fr(D[N - 2] * o[N - 1]));
        for (let i = N - 2; i > 0; --i) o[i] = fr(fr(o[i] - fr(D[i] * o[i + 1])) / T[i]);
    }
    calcTable() {
        const N = this.n;
        if (N <= 2) { this.ok = true; return; }
        this.param[0] = 0;
        for (let i = 1; i < N; i++) {
            const v = new V3(fr(this.xs[i] - this.xs[i - 1]), fr(this.ys[i] - this.ys[i - 1]), fr(this.zs[i] - this.zs[i - 1]));
            this.param[i] = fr(psVecMag(v) + this.param[i - 1]);
        }
        for (let i = 1; i < N; i++) this.param[i] = fr(this.param[i] / this.param[N - 1]);
        this.makeTable(this.param, this.xs, this.t10);
        this.makeTable(this.param, this.ys, this.t14);
        this.makeTable(this.param, this.zs, this.t18);
        this.ok = true;
    }
    private calcSpline(t: number, p: Float32Array, c: Float32Array, k: Float32Array) {
        const N = this.n;
        if (N === 1) return c[0];
        if (N === 2) return fr(fr(c[0] * fr(1 - t)) + fr(c[1] * t));
        let l = 0, r = N - 1;
        while (l < r) { const mid = (l + r) >>> 1; if (p[mid] < t) l = mid + 1; else r = mid; }
        if (l > 0) --l;
        const dt = fr(t - p[l]), dp = fr(p[l + 1] - p[l]);
        const a = fr(fr(k[l] * 3) + fr(fr(dt * fr(k[l + 1] - k[l])) / dp));
        const d = fr(fr(fr(c[l + 1] - c[l]) / dp) - fr(dp * fr(fr(k[l] * 2) + k[l + 1])));
        const cc = fr(fr(dt * a) + d);
        return fr(fr(dt * cc) + c[l]);
    }
    getPoint(t: number) {
        if (!this.ok) this.calcTable();
        if (t < 0) t = 0;
        if (t > 1) t = 1;
        return new V3(this.calcSpline(t, this.param, this.xs, this.t10), this.calcSpline(t, this.param, this.ys, this.t14), this.calcSpline(t, this.param, this.zs, this.t18));
    }
    setPoint(i: number, v: V3) {
        if (i < 0 || this.n <= i) return;
        this.xs[i] = v.x; this.ys[i] = v.y; this.zs[i] = v.z;
        this.ok = false;
    }
}

// ---------------------------------------------------------------- TSplineRail
/** the nodes of a graph a spline rail is built from */
export interface SplineGraph { count: number; point(i: number): V3; startIsEnd(): boolean; }

export class SplineRail {
    path: SplinePath;
    /** the graph loops (its first and last nodes are joined) */
    closed = false;
    constructor(g: SplineGraph) {
        const n = g.count;
        if (g.startIsEnd()) {
            this.closed = true;
            this.path = new SplinePath(n + 3);
            this.path.setPoint(0, g.point(n - 1));
            for (let i = 0; i < n; i++) this.path.setPoint(i + 1, g.point(i));
            this.path.setPoint(n + 1, g.point(0));
            this.path.setPoint(n + 2, g.point(1));
        } else {
            this.path = new SplinePath(n);
            for (let i = 0; i < n; i++) this.path.setPoint(i, g.point(i));
        }
        this.path.getPoint(0);
    }
    wrapT(t: number) { return this.closed ? MsWrap(t, this.path.param[1], this.path.param[this.path.n - 2]) : t; }
    getNthT(n: number) { return this.path.param[n]; }
    getPosition(t: number) { return this.path.getPoint(this.wrapT(t)); }
    /** the point at t and the rotation (degrees) looking along the rail there */
    getPosAndRot(t: number): [V3, V3] {
        t = this.wrapT(t);
        let dt = fr(0.01);
        for (;;) {
            if (fr(t + dt) > 1) t = fr(1 - dt);
            const point = this.getPosition(t);
            const dir = this.getPosition(fr(t + dt)).sub(point);
            if (dir.squared() > 32 * 1.1920929e-7) return [point, MsGetRotFromZaxis(dir)];
            dt = fr(dt * 2);
            if (dt > 1) return [point, new V3()];
        }
    }
}
