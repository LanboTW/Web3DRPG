import type { EnemyKind } from '../game/enemy';

export type QuestState = 'inactive' | 'active' | 'ready' | 'done';

export interface QuestDef {
  id: string;
  main: boolean;
  title: string;
  giver: NpcId;
  /** Objective: defeat `count` enemies of `kind`. */
  target: { kind: EnemyKind; count: number; label: string };
  reward: { xp: number; gold: number; items?: Record<string, number> };
}

export type NpcId = 'chief' | 'merchant' | 'hunter';

export const QUESTS: Record<string, QuestDef> = {
  main_knight: {
    id: 'main_knight', main: true, title: '餘燼與亡靈', giver: 'chief',
    target: { kind: 'knight', count: 1, label: '擊敗廢墟中的亡靈騎士' },
    reward: { xp: 400, gold: 250, items: { ember_blade: 1 } },
  },
  side_bandits: {
    id: 'side_bandits', main: false, title: '林間的山賊', giver: 'hunter',
    target: { kind: 'bandit', count: 5, label: '討伐山賊' },
    reward: { xp: 120, gold: 80, items: { leather: 1 } },
  },
  side_undead: {
    id: 'side_undead', main: false, title: '斷絕的商路', giver: 'merchant',
    target: { kind: 'skeleton', count: 4, label: '擊退亡者戰士' },
    reward: { xp: 150, gold: 120, items: { hi_potion: 2 } },
  },
};

export interface DialogPage {
  text: string;
  choices?: { label: string; action: DialogAction }[];
}
export type DialogAction = 'accept' | 'turnIn' | 'shop' | 'close';

export const NPC_NAMES: Record<NpcId, string> = { chief: '村長 艾德溫', merchant: '行商 羅班', hunter: '獵人 瑟拉' };

/** What an NPC says depends on the state of the quest they give. */
export function dialogFor(npc: NpcId, quest: QuestState, progress: number): DialogPage[] {
  switch (npc) {
    case 'chief':
      if (quest === 'inactive') return [
        { text: '旅人，妳來得正好。北方古堡的廢墟最近夜夜傳出鐵甲聲……' },
        { text: '傳說那是百年前背叛王國的騎士蓋爾德。他化為亡靈，召集死者，連山賊都被逼到我們的森林裡。' },
        { text: '村裡沒人能與之一戰。能否請妳前往廢墟，終結他的不死之身？', choices: [
          { label: '交給我吧', action: 'accept' }, { label: '讓我再想想', action: 'close' }] },
      ];
      if (quest === 'active') return [{ text: '亡靈騎士就在北邊廢墟的祭壇。沿著道路往北走就能看到石柱。千萬小心。' }];
      if (quest === 'ready') return [
        { text: '那股寒氣……消失了？妳真的擊敗了蓋爾德！' },
        { text: '這是村子世代守護的「燼火之刃」，據說是當年討伐他的英雄所留下。現在它屬於妳了。', choices: [{ label: '收下', action: 'turnIn' }] },
      ];
      return [{ text: '多虧了妳，村子終於能安心入眠。願餘燼永遠守護妳。' }];
    case 'hunter':
      if (quest === 'inactive') return [
        { text: '嘿，劍士。東邊林子裡的山賊越來越囂張，搶了我好幾批獸皮。' },
        { text: '幫我教訓他們五個人，我就把親手縫的皮甲送妳。', choices: [
          { label: '成交', action: 'accept' }, { label: '下次吧', action: 'close' }] },
      ];
      if (quest === 'active') return [{ text: `山賊營地在村子東邊的林中，有營火的地方。目前進度：${progress} / 5。` }];
      if (quest === 'ready') return [{ text: '乾淨俐落！這件皮甲是妳的了，比布衣耐打多了。', choices: [{ label: '收下', action: 'turnIn' }] }];
      return [{ text: '最近林子安靜多了，謝啦。' }];
    case 'merchant': {
      const shop = { label: '看看商品', action: 'shop' as const };
      if (quest === 'inactive') return [
        { text: '歡迎光臨！唉，可惜貨不多……通往廢墟的道路被亡者戰士佔據，我的貨車過不去。' },
        { text: '如果妳能擊退四個亡者，我會好好答謝妳的。', choices: [
          { label: '我來處理', action: 'accept' }, shop, { label: '再見', action: 'close' }] },
      ];
      if (quest === 'active') return [{ text: `亡者們在廢墟南側徘徊。目前進度：${progress} / 4。`, choices: [shop, { label: '再見', action: 'close' }] }];
      if (quest === 'ready') return [{ text: '路通了！這些高級藥水請收下，還有說好的謝禮。', choices: [{ label: '收下', action: 'turnIn' }] }];
      return [{ text: '恩人來了！需要什麼儘管看。', choices: [shop, { label: '再見', action: 'close' }] }];
    }
  }
}

export const SHOP_STOCK = ['potion', 'hi_potion', 'steel_sword', 'iron_armor'];
