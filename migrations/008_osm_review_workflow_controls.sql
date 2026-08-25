ALTER TABLE osmchange.review_queue ADD COLUMN IF NOT EXISTS admin_note TEXT;
ALTER TABLE osmchange.review_queue DROP CONSTRAINT IF EXISTS review_queue_review_status_check;
ALTER TABLE osmchange.review_queue ADD CONSTRAINT review_queue_review_status_check
  CHECK(review_status IN ('pending','held','approved','rejected','merge_failed','merged'));
