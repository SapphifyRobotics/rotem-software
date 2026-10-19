/* On-board attitude filter: the same multiplicative EKF as the studio (09_software/rotem-studio/src/ekf.ts),
 * in single-precision float for the Cortex-M33 FPU.
 *
 * State: attitude quaternion q (body to world, [w x y z]) and gyro bias b. Error state: 3 attitude angles in
 * the body frame + 3 bias terms. The gyro drives the prediction. Corrections:
 *  - zero-rate update: while the board is still, the gyro reading is the bias (all three axes, yaw included);
 *  - hold: while still, the gyro is not integrated, so heading does not move;
 *  - gravity: roll and pitch from the accelerometer, with the correction's component along the vertical removed
 *    (gravity cannot observe heading, and must not move it);
 *  - magnetic heading, optional: the field rotated into the world frame, its horizontal part kept on world +x.
 * Measured with the studio version on the 4.3 h overnight recording: 0.004 and 0.006 deg/h still.
 * Plain C, no allocation; also compiled on the host for 07_tests/fusion_replay.c. */
#include <math.h>
#include <string.h>
#include "fusion.h"

#define N 6

static void rot_matrix(const float q[4], float R[3][3])
{
    float w = q[0], x = q[1], y = q[2], z = q[3];
    R[0][0] = 1 - 2 * (y * y + z * z); R[0][1] = 2 * (x * y - w * z);     R[0][2] = 2 * (x * z + w * y);
    R[1][0] = 2 * (x * y + w * z);     R[1][1] = 1 - 2 * (x * x + z * z); R[1][2] = 2 * (y * z - w * x);
    R[2][0] = 2 * (x * z - w * y);     R[2][1] = 2 * (y * z + w * x);     R[2][2] = 1 - 2 * (x * x + y * y);
}

static void rotate(fusion_t *f, const float d[3])
{
    float w = f->q[0], x = f->q[1], y = f->q[2], z = f->q[3];
    float a = d[0] / 2, b = d[1] / 2, c = d[2] / 2;
    float q0 = w - x * a - y * b - z * c, q1 = x + w * a + y * c - z * b;
    float q2 = y + w * b - x * c + z * a, q3 = z + w * c + x * b - y * a;
    float n = sqrtf(q0 * q0 + q1 * q1 + q2 * q2 + q3 * q3);
    f->q[0] = q0 / n; f->q[1] = q1 / n; f->q[2] = q2 / n; f->q[3] = q3 / n;
}

void fusion_init(fusion_t *f, const fusion_params_t *p)
{
    memset(f, 0, sizeof *f);
    f->p = *p;
    f->q[0] = 1;
    for (int i = 0; i < 3; ++i) { f->P[i][i] = 0.1f; f->P[3 + i][3 + i] = 1e-4f; }
}

void fusion_set_bias(fusion_t *f, const float b[3]) { for (int i = 0; i < 3; ++i) f->bias[i] = b[i]; }

/* Stillness: over the last FUSION_WINDOW samples the gyro and accelerometer barely change, the accelerometer
 * reads 1 g and the mean rate is small. Running sums, O(1) per sample. */
static int still_push(fusion_t *f, const float g[3], const float a[3])
{
    still_t *s = &f->still;
    int k = s->head;
    if (s->count == FUSION_WINDOW)
        for (int i = 0; i < 3; ++i) {
            s->gs[i] -= s->g[k][i]; s->gq[i] -= s->g[k][i] * s->g[k][i];
            s->as[i] -= s->a[k][i]; s->aq[i] -= s->a[k][i] * s->a[k][i];
        }
    else ++s->count;
    for (int i = 0; i < 3; ++i) {
        s->g[k][i] = g[i]; s->a[k][i] = a[i];
        s->gs[i] += g[i]; s->gq[i] += g[i] * g[i]; s->as[i] += a[i]; s->aq[i] += a[i] * a[i];
    }
    s->head = (k + 1) % FUSION_WINDOW;
    if (s->count < FUSION_WINDOW) return 0;
    float n = FUSION_WINDOW, gsd = 0, asd = 0, mean2 = 0;
    for (int i = 0; i < 3; ++i) {
        float gm = s->gs[i] / n, am = s->as[i] / n;
        float gv = s->gq[i] / n - gm * gm, av = s->aq[i] / n - am * am;
        if (gv > gsd) gsd = gv;
        if (av > asd) asd = av;
        mean2 += gm * gm;
    }
    float an = sqrtf(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
    return gsd < f->p.still_gyro_std * f->p.still_gyro_std && asd < f->p.still_accel_std * f->p.still_accel_std &&
           fabsf(an - 1) < 0.05f && mean2 < f->p.still_max_rate * f->p.still_max_rate;
}

/* One correction with an m-dimensional measurement (m = 1 or 3). H is m x 6, R diagonal (r per row).
 * free_axis: body-frame unit vector whose attitude correction is removed, or NULL. */
static void correct(fusion_t *f, int m, float H[3][N], const float innov[3], float r, const float *free_axis)
{
    float PHt[N][3] = { { 0 } }, S[3][3] = { { 0 } }, Si[3][3], K[N][3] = { { 0 } };
    for (int i = 0; i < N; ++i) for (int j = 0; j < m; ++j) for (int k = 0; k < N; ++k) PHt[i][j] += f->P[i][k] * H[j][k];
    for (int i = 0; i < m; ++i) {
        for (int j = 0; j < m; ++j) for (int k = 0; k < N; ++k) S[i][j] += H[i][k] * PHt[k][j];
        S[i][i] += r;
    }
    if (m == 1) Si[0][0] = 1 / S[0][0];
    else {
        float A = S[1][1] * S[2][2] - S[1][2] * S[2][1], B = -(S[1][0] * S[2][2] - S[1][2] * S[2][0]), C = S[1][0] * S[2][1] - S[1][1] * S[2][0];
        float det = S[0][0] * A + S[0][1] * B + S[0][2] * C;
        Si[0][0] = A / det; Si[0][1] = -(S[0][1] * S[2][2] - S[0][2] * S[2][1]) / det; Si[0][2] = (S[0][1] * S[1][2] - S[0][2] * S[1][1]) / det;
        Si[1][0] = B / det; Si[1][1] = (S[0][0] * S[2][2] - S[0][2] * S[2][0]) / det; Si[1][2] = -(S[0][0] * S[1][2] - S[0][2] * S[1][0]) / det;
        Si[2][0] = C / det; Si[2][1] = -(S[0][0] * S[2][1] - S[0][1] * S[2][0]) / det; Si[2][2] = (S[0][0] * S[1][1] - S[0][1] * S[1][0]) / det;
    }
    for (int i = 0; i < N; ++i) for (int j = 0; j < m; ++j) for (int k = 0; k < m; ++k) K[i][j] += PHt[i][k] * Si[k][j];
    float dx[N] = { 0 };
    for (int i = 0; i < N; ++i) for (int j = 0; j < m; ++j) dx[i] += K[i][j] * innov[j];
    if (free_axis) {
        float d = dx[0] * free_axis[0] + dx[1] * free_axis[1] + dx[2] * free_axis[2];
        for (int i = 0; i < 3; ++i) dx[i] -= d * free_axis[i];
    }
    rotate(f, dx);
    for (int i = 0; i < 3; ++i) f->bias[i] += dx[3 + i];
    /* Joseph form: P = (I-KH) P (I-KH)' + K R K' */
    float IKH[N][N], T[N][N], Pn[N][N];
    for (int i = 0; i < N; ++i) for (int j = 0; j < N; ++j) {
        float v = (i == j);
        for (int k = 0; k < m; ++k) v -= K[i][k] * H[k][j];
        IKH[i][j] = v;
    }
    for (int i = 0; i < N; ++i) for (int j = 0; j < N; ++j) { float v = 0; for (int k = 0; k < N; ++k) v += IKH[i][k] * f->P[k][j]; T[i][j] = v; }
    for (int i = 0; i < N; ++i) for (int j = 0; j < N; ++j) {
        float v = 0; for (int k = 0; k < N; ++k) v += T[i][k] * IKH[j][k];
        for (int k = 0; k < m; ++k) v += K[i][k] * r * K[j][k];
        Pn[i][j] = v;
    }
    for (int i = 0; i < N; ++i) for (int j = 0; j < N; ++j) f->P[i][j] = 0.5f * (Pn[i][j] + Pn[j][i]);
}

void fusion_update(fusion_t *f, const float gyro[3], const float accel[3], const float *mag, float dt)
{
    f->still_now = f->p.zero_rate && still_push(f, gyro, accel);
    if (f->still_now) { if (f->still_time < 1e6f) f->still_time += dt; } else f->still_time = 0;
    int hold = f->still_now && f->p.hold_still;

    float w[3];
    for (int i = 0; i < 3; ++i) w[i] = hold ? 0 : gyro[i] - f->bias[i];
    float d[3] = { w[0] * dt, w[1] * dt, w[2] * dt };
    rotate(f, d);

    /* P = F P F' + Q, F = [[I - [w]x dt, -I dt], [0, I]] */
    float F[N][N] = { { 0 } }, T[N][N], Pn[N][N];
    for (int i = 0; i < N; ++i) F[i][i] = 1;
    F[0][1] += w[2] * dt; F[0][2] -= w[1] * dt; F[1][0] -= w[2] * dt; F[1][2] += w[0] * dt; F[2][0] += w[1] * dt; F[2][1] -= w[0] * dt;
    for (int i = 0; i < 3; ++i) F[i][3 + i] = -dt;
    for (int i = 0; i < N; ++i) for (int j = 0; j < N; ++j) { float v = 0; for (int k = 0; k < N; ++k) v += F[i][k] * f->P[k][j]; T[i][j] = v; }
    for (int i = 0; i < N; ++i) for (int j = 0; j < N; ++j) { float v = 0; for (int k = 0; k < N; ++k) v += T[i][k] * F[j][k]; Pn[i][j] = v; }
    for (int i = 0; i < 3; ++i) { Pn[i][i] += f->p.gyro_noise * f->p.gyro_noise * dt; Pn[3 + i][3 + i] += f->p.bias_noise * f->p.bias_noise * dt; }
    memcpy(f->P, Pn, sizeof Pn);

    float H[3][N];
    if (f->still_now) {
        memset(H, 0, sizeof H);
        for (int i = 0; i < 3; ++i) H[i][3 + i] = 1;
        float innov[3] = { gyro[0] - f->bias[0], gyro[1] - f->bias[1], gyro[2] - f->bias[2] };
        float rz = f->p.gyro_noise * 4; rz *= rz;
        correct(f, 3, H, innov, rz, 0);
    }

    float an = sqrtf(accel[0] * accel[0] + accel[1] * accel[1] + accel[2] * accel[2]);
    if (an > 0.3f && an < 3) {
        float R[3][3]; rot_matrix(f->q, R);
        float gb[3] = { R[2][0], R[2][1], R[2][2] }; /* world up in the body frame */
        memset(H, 0, sizeof H);
        H[0][1] = -gb[2]; H[0][2] = gb[1]; H[1][0] = gb[2]; H[1][2] = -gb[0]; H[2][0] = -gb[1]; H[2][1] = gb[0];
        float innov[3] = { accel[0] / an - gb[0], accel[1] / an - gb[1], accel[2] / an - gb[2] };
        float sigma = f->p.accel_noise * (1 + 20 * fabsf(an - 1));
        correct(f, 3, H, innov, sigma * sigma, gb);
    }

    if (mag) {
        float R[3][3]; rot_matrix(f->q, R);
        float mw[3];
        for (int r = 0; r < 3; ++r) mw[r] = R[r][0] * mag[0] + R[r][1] * mag[1] + R[r][2] * mag[2];
        if (mw[0] * mw[0] + mw[1] * mw[1] > 1e-12f) {
            memset(H, 0, sizeof H);
            H[0][0] = R[2][0]; H[0][1] = R[2][1]; H[0][2] = R[2][2];
            float innov[3] = { -atan2f(mw[1], mw[0]), 0, 0 };
            correct(f, 1, H, innov, f->p.heading_noise * f->p.heading_noise, 0);
        }
    }
    f->updates++;
}

void fusion_euler(const fusion_t *f, float ypr_deg[3])
{
    const float d = 57.29577951f;
    float w = f->q[0], x = f->q[1], y = f->q[2], z = f->q[3];
    float sp = 2 * (w * y - z * x); if (sp > 1) sp = 1; if (sp < -1) sp = -1;
    ypr_deg[0] = atan2f(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) * d;  /* yaw */
    ypr_deg[1] = asinf(sp) * d;                                               /* pitch */
    ypr_deg[2] = atan2f(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)) * d;  /* roll */
}

/* Turn the heading so the present yaw reads `yaw_deg`, keeping roll and pitch: q <- Rz(delta) * q. */
void fusion_set_yaw(fusion_t *f, float yaw_deg)
{
    float ypr[3]; fusion_euler(f, ypr);
    float half = (yaw_deg - ypr[0]) * 0.00872664626f, c = cosf(half), s = sinf(half);
    float w = f->q[0], x = f->q[1], y = f->q[2], z = f->q[3];
    f->q[0] = c * w - s * z; f->q[1] = c * x - s * y; f->q[2] = c * y + s * x; f->q[3] = c * z + s * w;
}

const fusion_params_t FUSION_DEFAULTS = {
    .zero_rate = 1, .hold_still = 1,
    .gyro_noise = 0.004f, .bias_noise = 0.0002f, .accel_noise = 0.03f, .heading_noise = 0.15f,
    .still_gyro_std = 0.012f, .still_accel_std = 0.006f, .still_max_rate = 0.01f,
};
