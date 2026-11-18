/**
 * Powers that come out the same on every platform. V8 hands `**` and Math.pow to the C library's pow, and the MSVC
 * and glibc ones differ in the last bit on about 0.07 % of the inputs the converter meets (the Windows and Linux
 * banks differed). Math.exp and Math.log are V8's own fdlibm ports and agree everywhere, so a non-integer
 * power goes through them with the product's rounding error carried (Dekker's product).
 */

const SPLIT = 134217729;

/**
 * x ** y, the same bits on every platform. Integer powers of 2 and 10 are exact (or one division), other integer
 * powers multiply out, the rest is exp(y log x) within a few units in the last place.
 */
export function pow(x: number, y: number) {
    if (y === 2) return x * x;
    if (Number.isInteger(y)) {
        // exact results are the same in every C library
        if (x === 2 && Math.abs(y) <= 1023) return 2 ** y;
        if (x === 10 && Math.abs(y) <= 22) return y >= 0 ? 10 ** y : 1 / 10 ** -y;
        if (Math.abs(y) <= 64) {
            let r = 1;
            for (let i = 0; i < Math.abs(y); i++) r *= x;
            return y < 0 ? 1 / r : r;
        }
    }
    if (!(x > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return x ** y;
    const l = Math.log(x);
    const t = y * l;
    // the rounding error of y * l, exactly (Dekker)
    const ya = y * SPLIT - (y * SPLIT - y);
    const yb = y - ya;
    const la = l * SPLIT - (l * SPLIT - l);
    const lb = l - la;
    const te = ya * la - t + ya * lb + yb * la + yb * lb;
    const e = Math.exp(t);
    // an overflow would turn Infinity * te into NaN, ** gives Infinity there
    if (!Number.isFinite(e)) return e;
    return e + e * te;
}
