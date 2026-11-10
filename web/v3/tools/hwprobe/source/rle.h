// Runs of a byte packed (as rleEncode / rleDecode in ../script.ts): a control byte c, then c + 1 bytes as they are
// (c < 128) or one byte to repeat c - 126 times.
#include <string.h>

// d must hold n + n / 128 + 2 bytes; returns the packed length
static unsigned rle_encode(const unsigned char *s, unsigned n, unsigned char *d) {
    unsigned i = 0, o = 0;
    while (i < n) {
        unsigned run = 1;
        while (i + run < n && run < 129 && s[i + run] == s[i]) run++;
        if (run >= 3) { d[o++] = (unsigned char)(run + 126); d[o++] = s[i]; i += run; continue; }
        unsigned start = i, len = 0;
        while (i < n && len < 128) {
            unsigned r = 1;
            while (i + r < n && r < 3 && s[i + r] == s[i]) r++;
            if (r >= 3) break;
            i++; len++;
        }
        d[o++] = (unsigned char)(len - 1);
        memcpy(d + o, s + start, len);
        o += len;
    }
    return o;
}

// 1 if s (n bytes) unpacks to exactly dn bytes
static int rle_decode(const unsigned char *s, unsigned n, unsigned char *d, unsigned dn) {
    unsigned i = 0, o = 0;
    while (i < n) {
        unsigned c = s[i++];
        if (c < 128) {
            unsigned k = c + 1;
            if (i + k > n || o + k > dn) return 0;
            memcpy(d + o, s + i, k); i += k; o += k;
        } else {
            unsigned k = c - 126;
            if (i >= n || o + k > dn) return 0;
            memset(d + o, s[i++], k); o += k;
        }
    }
    return o == dn;
}
