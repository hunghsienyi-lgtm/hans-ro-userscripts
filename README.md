# HANS RO 專用 Tampermonkey 腳本

此儲存庫只維護 [HANS RO](https://ro.hans-webgametw.com/) 專用使用者腳本，與原版《RO Survivors》不同。

## 固定安裝網址

| 腳本 | 版本 | Tampermonkey 安裝來源 |
| --- | --- | --- |
| 二轉巫師：優先暴風雪、補五核心再加目標／尋寶寶箱 | 1.19 | [HANS_Wizard_AutoSkill.user.js](https://raw.githubusercontent.com/hunghsienyi-lgtm/hans-ro-userscripts/main/HANS_Wizard_AutoSkill.user.js) |
| 斐揚森林：首次 1:00、之後每分鐘採集 | 1.9.2 | [HANS_Forest_Magnet_Loot.user.js](https://raw.githubusercontent.com/hunghsienyi-lgtm/hans-ro-userscripts/main/HANS_Forest_Magnet_Loot.user.js) |
| 舊版斐揚森林／洞穴自動重進（**已退役，不再自動點擊**） | 1.8.1 | [HANS_Payon_Auto_Reenter.user.js](https://raw.githubusercontent.com/hunghsienyi-lgtm/hans-ro-userscripts/main/HANS_Payon_Auto_Reenter.user.js) |
| **選關＋戰利品整合版**：結算至少停留 5.2 秒、等縮圖與戰績穩定再返回，紀錄難度／倍率，場次 CSV，Discord | **0.6.0** | [HANS_Loot_Journal.user.js](https://raw.githubusercontent.com/hunghsienyi-lgtm/hans-ro-userscripts/main/HANS_Loot_Journal.user.js) |

**2026-11-16 起，選關與戰利品已整合為同一支腳本。** 請在 Tampermonkey 將戰利品更新到 v0.6.0；舊選關更新到 v1.8.1 後不再執行，自動重進改由戰利品腳本上方的「聯動重進」控制。其餘巫師選技及森林採集維持獨立。安裝前先停用重複用途舊版腳本。後續更新時保留檔名與網址，增加腳本 `@version`，上傳覆寫到 `main`，Tampermonkey 依設定定期檢查 `@updateURL` 並取得 `@downloadURL`。更新頻率依瀏覽器與 Tampermonkey 設定而異；如需即時更新，可在 Tampermonkey 手動檢查更新。

## 安全與已知問題

- 本公開儲存庫**不得**放置 Discord Webhook、密碼、Token、遊戲帳號或 Cookies。
- 戰利品 v0.5.2 **不含私人 Webhook**。安裝後在腳本介面點選「設定 DC Webhook」，資料存於 Tampermonkey 本機設定。
- 整合版會統計結算的「獲得的掉落／卡片」圖示數與可讀名稱；**若遊戲只渲染圖片卻沒有文字／屬性，仍無法可靠確認金裝、TIER 或還原被自動販售的裝備**。結算若無法辨識，等待最多 15.5 秒後留下警告並放行，避免掛機永久卡住。
- 整合版通過 JavaScript 語法檢查與基於 HANS 截圖數據的模擬測試，仍需在當前 HANS 網站實際測試。
- 這裡只提供腳本發布與版本更新，不會自行變更遊戲設定。

## 後續發布原則

版本上升時只更新對應的 `.user.js` 檔案；**不要只提交 ZIP**。提交前檢查腳本中沒有私人資料、四支腳本之間不會重複操控相同功能，並保留固定 `@updateURL` / `@downloadURL`。

## 整合版操作

1. 篡改猴檢查更新，確認「戰利品」v0.6.0 與「舊自動重進」v1.8.1 已更新。
2. 重新整理 HANS，展開右下「📦 HANS 選關＋戰利品」確認紀錄啟用、Discord Webhook 仍在本機；右上選斐揚森林／洞穴並開啟「重進」。
3. 選關畫面會記下六項難度與獎勵倍率，不改動難度滑桿；結算時先記錄縮圖與戰績、封存本場，再按「返回角色」。
4. 右下「場次 CSV」可匯出每局強度、可見縮圖數與有名稱的掉寶紀錄。Discord 發送在本機佇列排隊，不會因網路超時阻塞選關。

