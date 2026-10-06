export type ItemKind = 'weapon' | 'armor' | 'consumable';

export interface SwordLook {
  blade: number;
  guard: number;
  emissive?: number;
  scale?: number;
}

export interface ArmorLook {
  /** Tint applied to the torso garment. */
  torso: number;
  metalness: number;
  roughness: number;
  /** Shoulder guard color; omitted for no pauldrons. */
  pauldron?: number;
  pauldronMetal?: boolean;
  trim?: number;
}

export interface ItemDef {
  id: string;
  kind: ItemKind;
  /** i18n-ready display names live with the item for now (zh-TW). */
  name: string;
  desc: string;
  price: number;
  atk?: number;
  def?: number;
  hp?: number;
  crit?: number;
  heal?: number;
  sword?: SwordLook;
  armor?: ArmorLook;
}

export const ITEMS: Record<string, ItemDef> = {
  iron_sword: {
    id: 'iron_sword', kind: 'weapon', name: '鐵劍', desc: '村裡鐵匠打造的樸實單手劍。', price: 20, atk: 0,
    sword: { blade: 0xc8ccd0, guard: 0xb08d57 },
  },
  steel_sword: {
    id: 'steel_sword', kind: 'weapon', name: '精鋼長劍', desc: '經過反覆鍛打的精鋼劍，鋒利耐用。', price: 140, atk: 7, crit: 0.03,
    sword: { blade: 0xe6edf2, guard: 0x40464f, scale: 1.08 },
  },
  ember_blade: {
    id: 'ember_blade', kind: 'weapon', name: '燼火之刃', desc: '劍身殘留著不滅餘燼的古劍。', price: 0, atk: 16, crit: 0.08,
    sword: { blade: 0x3a2a24, guard: 0xd0a040, emissive: 0xff5a1a, scale: 1.12 },
  },
  cloth: {
    id: 'cloth', kind: 'armor', name: '旅人布衣', desc: '輕便但幾乎沒有防護力。', price: 10, def: 0,
    armor: { torso: 0xffffff, metalness: 0, roughness: 0.9 },
  },
  leather: {
    id: 'leather', kind: 'armor', name: '皮革胸甲', desc: '獵人縫製的硬皮甲，附護肩。', price: 90, def: 4, hp: 10,
    armor: { torso: 0x7a4a2a, metalness: 0, roughness: 0.7, pauldron: 0x5a3820 },
  },
  iron_armor: {
    id: 'iron_armor', kind: 'armor', name: '鐵製胸甲', desc: '沉重但可靠的鐵甲。', price: 280, def: 9, hp: 25,
    armor: { torso: 0x8a9096, metalness: 0.85, roughness: 0.35, pauldron: 0x9aa0a8, pauldronMetal: true },
  },
  knight_plate: {
    id: 'knight_plate', kind: 'armor', name: '亡靈騎士鎧', desc: '從亡靈騎士身上取下的黑鎧，仍透著寒氣。', price: 0, def: 15, hp: 45,
    armor: { torso: 0x2c2f36, metalness: 0.9, roughness: 0.3, pauldron: 0x24262c, pauldronMetal: true, trim: 0x5ad1ff },
  },
  potion: { id: 'potion', kind: 'consumable', name: '治療藥水', desc: '恢復 60 點生命。', price: 15, heal: 60 },
  hi_potion: { id: 'hi_potion', kind: 'consumable', name: '高級藥水', desc: '恢復 150 點生命。', price: 45, heal: 150 },
};
