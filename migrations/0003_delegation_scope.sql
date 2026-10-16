-- 공통(전 부서 적용) / 개별(해당 부서) delegation scope of each approval row, and the
-- department an individual row belongs to. mirror_format marks regulations written
-- before these columns existed, so the next mirror run rewrites them once.
ALTER TABLE approvals ADD COLUMN scope TEXT;
ALTER TABLE approvals ADD COLUMN department TEXT;
ALTER TABLE regulations ADD COLUMN mirror_format INTEGER;
DROP VIEW IF EXISTS current_approvals;
CREATE VIEW current_approvals AS
  SELECT a.*, r.name AS regulation_name FROM approvals a JOIN regulations r ON r.reg_id = a.reg_id AND r.generation = a.generation;
