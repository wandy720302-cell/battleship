# 戰艦對決 · Battleship P2P

雙人連線戰艦遊戲。純前端，瀏覽器對瀏覽器直連（WebRTC），沒有後端要養。
開一間房，把連結丟給朋友，隔著網路互相轟。

## 功能

- 10×10 棋盤、5 艘船（5/4/3/3/2 格）
- 拖曳或點擊擺船，`R` / 右鍵 / 按鈕旋轉，一鍵隨機部署
- 輪流開火，命中 / 落空 / 擊沉即時回報 + 音效（Web Audio 合成，無音檔）
- 變體規則：命中後可以再開一槍（房主設定）
- 觀戰模式：第三人以上用同一個連結勾「觀戰」進來看
- 聊天室、戰報、終局揭曉雙方船位、再來一局
- **上班模式**：按 `Esc`（或頂欄 💼）瞬間蓋上假 VSCode，分頁標題與 favicon 一起換、自動靜音。輪到你時，狀態列的錯誤數會從 `⊗ 0` 變 `⊗ 1`；再按 `Esc` 回來

## 本機試玩

```bash
npm start          # 開在 http://localhost:8080
```

或任何靜態伺服器都行（`python -m http.server 8080`）。
`file://` 直接開不行 —— ES module 要 http。

## 部署到 GitHub Pages（免費、公開連結）

```bash
cd battleship
git init
git add .
git commit -m "battleship p2p"
gh repo create battleship --public --source=. --push
```

然後到 GitHub repo → **Settings → Pages → Source: Deploy from a branch → `main` / `(root)`** → Save。
一分鐘後網址是 `https://<你的帳號>.github.io/battleship/`。

沒裝 `gh` 的話：GitHub 網頁上建一個 repo，再 `git remote add origin ... && git push -u origin main`。

## 怎麼玩

1. 房主開頁面 → 輸代號 → **開新房間**
2. 點頂欄的房間碼 🔗 複製邀請連結，丟給朋友
3. 朋友點連結 → 房間碼自動填好 → **加入**
4. 兩邊各自擺船 → **準備完成** → 隨機決定先手 → 開打
5. 想看戲的人用同一個連結，勾「以觀戰身分進入」

## 架構

```
index.html      畫面骨架
style.css       深海雷達風
js/game.js      純規則：擺船合法性、命中判定、回合邏輯（無 DOM、可單獨測）
js/net.js       PeerJS 連線層，host 當 hub 轉發，觀戰者掛在 host 上
js/audio.js     Web Audio 合成音效
js/ui.js        DOM 渲染
js/main.js      狀態機 + 訊息路由 + 互動
```

判定方式是「各自判定自己的棋盤」：對方只知道你回報的命中/落空，看不到你的船位。
反過來說，改程式碼的人可以謊報結果 —— 這是 P2P 沒有裁判的天生限制，跟朋友玩夠用了。

## 已知限制

- 配對靠 PeerJS 公開 signaling server（`0.peerjs.com`）。它偶爾會抽風，重整再開一次房通常就好。
- 某些公司網路 / 嚴格 NAT 會擋 WebRTC 直連。PeerJS 預設有 STUN 但沒 TURN，過不去就是過不去。
- 玩家中途斷線，這局作廢。重新用連結進房會直接開新局。
- 兩位玩家以外的人只能觀戰。
