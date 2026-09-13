alter table evaluations add column if not exists requested_decision text;
alter table evaluations add column if not exists enforced_decision text;
alter table evaluations add column if not exists enforcement_record jsonb;

alter table evaluations drop constraint if exists evaluations_requested_decision_check;
alter table evaluations add constraint evaluations_requested_decision_check
  check (requested_decision is null or requested_decision in ('allow', 'ask', 'deny', 'replace', 'record'));

alter table evaluations drop constraint if exists evaluations_enforced_decision_check;
alter table evaluations add constraint evaluations_enforced_decision_check
  check (enforced_decision is null or enforced_decision in ('allow', 'ask', 'deny', 'replace', 'record'));
