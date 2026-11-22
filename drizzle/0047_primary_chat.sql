ALTER TABLE `work_items` ADD `primary_session_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `work_items_primary_session_idx` ON `work_items` (`user_id`,`primary_session_id`);--> statement-breakpoint
-- Backfill: record which chat is a task's primary chat. Only the pointer is written; no chat is moved, linked or renamed.
-- A chat is promoted only where it served ONE task: every place it is filed (outside Miscellaneous), linked or named by an
-- agent run counts as an item it served. A chat that only an agent run names is promoted only when Jarvis knows the session.
-- Per task the order is: a chat filed under it, then a linked chat, then a run's chat; newest first within each.
WITH cand(user_id, item_id, sid, src, at) AS (
  SELECT c.user_id, c.parent_id, c.session_id, 0, c.created_at
    FROM work_items c JOIN work_items p ON p.id = c.parent_id
   WHERE c.kind = 'conversation' AND c.session_id IS NOT NULL AND c.archived = 0 AND p.system_key IS NULL
  UNION ALL
  SELECT i.user_id, l.item_id, l.target_id, 1, l.created_at
    FROM work_links l JOIN work_items i ON i.id = l.item_id
   WHERE l.kind = 'chat_session' AND l.target_id IS NOT NULL
  UNION ALL
  SELECT r.user_id, r.item_id, r.hermes_session_id, 2, r.started_at
    FROM agent_runs r
   WHERE r.hermes_session_id IS NOT NULL
),
served AS (
  SELECT user_id, sid FROM cand GROUP BY user_id, sid HAVING COUNT(DISTINCT item_id) = 1
),
pick AS (
  SELECT c.item_id, c.sid, ROW_NUMBER() OVER (PARTITION BY c.item_id ORDER BY c.src, c.at DESC, c.sid) AS n
    FROM cand c JOIN served s ON s.user_id = c.user_id AND s.sid = c.sid
   WHERE c.src < 2 OR EXISTS (SELECT 1 FROM session_meta m WHERE m.session_id = c.sid AND m.user_id = c.user_id)
)
UPDATE work_items
   SET primary_session_id = (SELECT p.sid FROM pick p WHERE p.item_id = work_items.id AND p.n = 1)
 WHERE parent_id IS NOT NULL
   AND kind NOT IN ('area', 'project', 'conversation', 'note')
   AND id IN (SELECT item_id FROM pick WHERE n = 1);
