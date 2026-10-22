-- The no-signup demo is gone: remove its guest accounts with their workspaces (bases, members and sessions cascade).
DELETE FROM workspaces WHERE id IN (SELECT m.workspace_id FROM members m JOIN users u ON u.id = m.user_id WHERE u.is_guest = 1);
DELETE FROM users WHERE is_guest = 1;
ALTER TABLE users DROP COLUMN is_guest;
