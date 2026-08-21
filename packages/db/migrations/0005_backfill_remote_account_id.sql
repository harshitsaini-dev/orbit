-- Connections made before remote_account_id existed carry NULL, so the very
-- next reconnection would duplicate them - the exact failure the column was
-- added to prevent. Google Drive accounts were already labelled with the
-- address the provider reported, which is the same value the column holds, so
-- they can be filled in without asking the provider again.
UPDATE `accounts`
SET `remote_account_id` = `nickname`
WHERE `remote_account_id` IS NULL
  AND `provider` = 'google_drive'
  AND `nickname` LIKE '%_@_%.__%';
