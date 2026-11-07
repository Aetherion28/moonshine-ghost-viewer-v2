// The pad rumble's output (MarioUtil/RumbleMgr.cpp): the sim's 'rumble' events (game/rumble.ts,
// one per SMSRumbleMgr->start) played as RumbleChannelMgr::update does: each a channel (at most
// RUMBLE_CHANNELS_PER_CONTROLLER = 4; a start with none free is dropped), its power the channel
// data's piecewise-linear curve at the time since its start (1/60 s a frame), times its multiplier,
// repeated repeat times; the controller's power the channels' largest. Given to the browser's
// gamepads (vibrationActuator.playEffect 'dual-rumble') as the motor's magnitude — the GameCube
// motor is only on / off (RumbleControllerMgr::update's PWM of the power); a no-op without a pad.
// Only while the replay plays at 1x, as the sound does.

import { RUMBLE_CHANNELS } from '../game/rumble.js';

interface Ch { tbl: typeof RUMBLE_CHANNELS[number]; elapsed: number; repeat: number; mult: number; }
const CHANNELS = 4;

export class PadRumble {
    private ch: (Ch | null)[] = [null, null, null, null];
    private evKey: object | null = null; private evDone = 0;
    private lastWall = 0; private on = false;

    frame(events: { t?: number; kind: string; data: any }[] | null, key: object | null, tick: number | undefined, playing: boolean) {
        const now = performance.now() / 1000, dt = this.lastWall ? Math.min(0.1, now - this.lastWall) : 0;
        this.lastWall = now;
        if (key !== this.evKey) { this.evKey = key; this.evDone = events ? events.length : 0; }
        if (events) {
            if (events.length < this.evDone) this.evDone = 0;
            for (let i = this.evDone; i < events.length; i++) {
                const e = events[i];
                if (e.kind !== 'rumble' || !playing) continue;
                if (tick !== undefined && e.t !== undefined && e.t < tick - 3) continue;
                const tbl = RUMBLE_CHANNELS[e.data.idx];
                if (!tbl) continue;
                // RumbleControllerMgr::start: the first free channel
                for (let k = 0; k < CHANNELS; k++) if (!this.ch[k]) { this.ch[k] = { tbl, elapsed: 0, repeat: e.data.repeat, mult: e.data.mult }; break; }
            }
            this.evDone = events.length;
        }
        if (!playing) { for (let k = 0; k < CHANNELS; k++) this.ch[k] = null; this.out(0); return; }
        // RumbleChannelMgr::update, in steps of 1/60 s over the time passed
        let steps = Math.max(1, Math.round(dt * 60)), max = 0;
        while (steps-- > 0) {
            max = 0;
            for (let k = 0; k < CHANNELS; k++) {
                const c = this.ch[k];
                if (!c) continue;
                const p = this.update(c);
                if (c.repeat === 0) this.ch[k] = null;
                if (p > max) max = p;
            }
        }
        this.out(max);
    }
    private update(c: Ch): number {
        let power = 0;
        if (c.repeat === 0) return 0;
        const T = c.tbl;
        c.elapsed = Math.fround(c.elapsed + Math.fround(1 / 60));
        for (let i = 0; i < T.points - 1; i++) {
            if (c.elapsed > T.frames[i]) {
                const d = T.frames[i + 1] - T.frames[i], fd = c.elapsed - T.frames[i];
                const pr = d > 0 ? fd / d : 1;
                power = (1 - pr) * T.powers[i] + pr * T.powers[i + 1];
            }
        }
        if (c.elapsed > T.frames[T.points - 1]) {
            if (c.repeat > 1) { c.elapsed = 0; c.repeat--; }
            else if (c.repeat < 0) c.elapsed = 0;
            else c.repeat = 0;
        }
        return power * c.mult;
    }
    private out(p: number) {
        if (p <= 0 && !this.on) return;
        this.on = p > 0;
        try {
            const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
            for (const g of pads) {
                const a: any = g && (g as any).vibrationActuator;
                if (!a || typeof a.playEffect !== 'function') continue;
                if (p > 0) a.playEffect('dual-rumble', { startDelay: 0, duration: 50, strongMagnitude: Math.min(1, p), weakMagnitude: Math.min(1, p) }).catch(() => { });
                else if (typeof a.reset === 'function') a.reset().catch(() => { });
            }
        } catch { }
    }
}
