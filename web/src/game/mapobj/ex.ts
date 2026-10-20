// The secret courses' nail (MoveBG/MapObjEx.cpp's TMapObjNail): ground-pounded, it sinks 50 units
// into the floor, three times, and its hidden object (a coin) comes out on the third. The courses'
// other objects are lifts and blocks named for their looks, registered in railblock.ts.

import { fr } from '../math.js';
import { World, HitActor, MSG } from '../engine.js';
import { AT } from '../actortypes.js';
import { SE } from '../soundids.js';
import { register } from '../scene.js';
import { MapObjBase, mapObjGlobals } from './base.js';
import { HideObjBase } from './hide.js';
import { ItemManager } from './item.js';

export class MapObjNail extends HideObjBase {
    static mDownHeight = 50;
    /** unk150 times hit */
    unk150 = 0;
    constructor(w: World, name = 'くぎ') { super(w, name); }
    receiveMessage(sender: HitActor, msg: number): boolean {
        if (msg === MSG.HIP_DROP && !this.isStateTimerEngaged() && this.unk150 < 3) {
            this.pos.y = fr(this.pos.y - MapObjNail.mDownHeight);
            this.removeMapCollision();
            this.setUpCurrentMapCollision();
            this.world.sound(SE.OBJ_KUGI_IMPACT, this.pos);
            this.stateTimer = 120;
            ++this.unk150;
            if (this.unk150 === 3 && this.hidden) {
                let o: MapObjBase | null = this.hidden;
                if (o.isActorType(AT.COIN)) { const im = mapObjGlobals(this.world).itemManager as ItemManager | null; o = im ? im.makeObjAppear(AT.COIN) : null; }
                if (o) this.throwObjToFront(o, 200, this.appearSpeed, this.appearYSpeed);
            }
            return true;
        }
        return false;
    }
}

register('MapObjNail', (w, n) => new MapObjNail(w, n));
