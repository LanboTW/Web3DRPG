# 殘燼之劍 Web3DRPG

寫實風格的網頁 3D 動作 RPG，電腦與手機皆可遊玩。

**線上遊玩：** https://lanbotw.github.io/Web3DRPG/

## 技術
- Three.js（WebGPU 優先，自動退回 WebGL2）+ TypeScript + Vite
- 畫質自動分級（低／中／高）＋動態解析度，可在設定中手動切換
- 加 `?webgl` 到網址可強制使用 WebGL2

## 操作
- 電腦：WASD 移動、Shift 奔跑、滑鼠轉視角、滾輪縮放、左鍵攻擊、空白鍵閃避、Q/E 技能、R 奧義、Tab 鎖定
- 手機：左側虛擬搖桿、右側滑動轉視角、右下角按鈕
- 手把：標準 Gamepad 配置

## 開發
```bash
npm install
npm run dev
```
推送到 `main` 後 GitHub Actions 會自動建置並部署到 GitHub Pages。

## 進度
- [x] 第 1 階段：專案骨架、Pages 部署、場景、操作
- [x] 第 2 階段：Blender 人物生成管線與主角
- [x] 第 3 階段：戰鬥與敵人
- [x] 第 4 階段：RPG 系統、任務、UI
- [x] 第 5 階段：畫質分級調校與手機優化

素材授權見 [CREDITS.md](CREDITS.md)。
