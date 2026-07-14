-- Roadmap items can be marked as agent tasks: work an agent session pulls and
-- executes. NULL / absent = a human goal (the default). 'agent' = an agent task
-- the MCP surface (canvas_roadmap_task_list) hands to a session to complete.
alter table roadmap_items add column if not exists assignee text;
