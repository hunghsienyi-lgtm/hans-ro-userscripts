# HANS RO 專用 Tampermonkey 腳本

此儲存庫只維護 [HANS RO](https://ro.hans-webgametw.com/) 專用使用者腳本，與原版《RO Survivors》不同。

## 固定安裝網址

| 腳本 | 版本 | Tampermonkey 安裝來源 |
| --- | --- | --- |
| 二轉巫師：優先暴風雪、補五核心再加目標／尋寶寶箱 | 1.19 | [HANS_Wizard_AutoSkill.user.js](https://raw.githubusercontent.com/hunghsienyi-lgtm/hans-ro-userscripts/main/HANS_Wizard_AutoSkill.user.js) |
| 斐揚森林：首次 1:00、之後每分鐘採集 | 1.9.2 | [HANS_Forest_Magnet_Loot.user.js](https://raw.githubusercontent.com/hunghsienyi-lgtm/hans-ro-userscripts/main/HANS_Forest_Magnet_Loot.user.js) |
| 斐揚森林／洞穴：自動重進 | 1.8.0 | [HANS_Payon_Auto_Reenter.user.js](https://raw.githubusercontent.com/hunghsienyi-lgtm/hans-ro-userscripts/main/HANS_Payon_Auto_Reenter.user.js) |
| 戰利品全紀錄／Discord 通知 | 0.5.2 | [HANS_Loot_Journal.user.js](https://raw.githubusercontent.com/hunghsienyi-lgtm/hans-ro-userscripts/main/HANS_Loot_Journal.user.js) |

安裝前，先在 Tampermonkey 停用重複用途的舊版腳本。從固定網址各安裝一次。後續更新時保留檔名與網址，增加腳本 `@version`，上傳覆寫到 `main`，Tampermonkey 依設定定期檢查 `@updateURL` 並取得 `@downloadURL`。更新頻率依瀏覽器與 Tampermonkey 設定而異；如需即時更新，可在 Tampermonkey 手動檢查更新。

## 安全與已知問題

- 本公開儲存庫**不得**放置 Discord Webhook、密碼、Token、遊戲帳號或 Cookies。
- 戰利品 v0.5.2 **不含私人 Webhook**。安裝後在腳本介面點選「設定 DC Webhook」，資料存於 Tampermonkey 本機設定。
- 戰利品紀錄器尚未解決 HANS「精簡掉落」模式下無法完整讀取裝備的問題；請勿將此版本視為已修復。
- 四支腳本已通過 JavaScript 語法檢查，但仍需在當前 HANS 網站實際測試。
- 這裡只提供腳本發布與版本更新，不會自行變更遊戲設定。

## 後續發布原則

版本上升時只更新對應的 `.user.js` 檔案；**不要只提交 ZIP**。提交前檢查腳本中沒有私人資料、四支腳本之間不會重複操控相同功能，並保留固定 `@updateURL` / `@downloadURL`。
