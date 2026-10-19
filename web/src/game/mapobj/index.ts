// The map-object framework and items (MoveBG/): import for their scene.bin classes to register.
import type { World } from '../engine.js';
import { AT } from '../actortypes.js';
import { mapObjGlobals, MapObjBase } from './base.js';
import type { ItemManager, Coin } from './item.js';
export * from './base.js';
export * from './general.js';
export * from './item.js';
export * from './hide.js';
export { ObjCollision, ObjCollisionManager } from './objcol.js';
// Bianco Hills' objects (and the shared map objects they use)
export * from './lib.js';
export * from './bianco.js';
export * from './cloud.js';
export * from './tree.js';
export * from './fence.js';
export * from './view.js';
export * from './town.js';
export * from './fruit.js';

/**
 * The item hooks the enemies call through World (World.newAndRegisterCoin / makeCoinAppear /
 * makeCoinAt), as gpItemManager does them: assign these to World.prototype to have enemies drop
 * real coins from the pool.
 */
export const mapObjWorldHooks = {
    /** TItemManager::newAndRegisterCoin(id) */
    newAndRegisterCoin(this: World, id: number): Coin | null {
        const im = mapObjGlobals(this).itemManager as ItemManager | null;
        return im ? im.newAndRegisterCoin(id) : null;
    },
    /** genEventCoin's: a gold coin from the pool (the stand-in), or that coin itself appears */
    makeCoinAppear(this: World, coin: MapObjBase | null): MapObjBase | null {
        if (!coin) return null;
        if (coin.isActorType(AT.COIN)) {
            const im = mapObjGlobals(this).itemManager as ItemManager | null;
            return im ? im.makeObjAppear(AT.COIN) : null;
        }
        coin.appear();
        return coin;
    },
    /** gpItemManager->makeObjAppear(x, y, z, ACTOR_TYPE_COIN, false) */
    makeCoinAt(this: World, x: number, y: number, z: number): MapObjBase | null {
        const im = mapObjGlobals(this).itemManager as ItemManager | null;
        return im ? im.makeObjAppearAt(x, y, z, AT.COIN, false) : null;
    },
};
