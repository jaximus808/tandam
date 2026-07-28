-- Multi-agent swarm view v1: a structural parent link on agents. An
-- orchestrator registers as role 'planner', threads its returned agent id into
-- each subagent's spawn prompt, and every subagent registers role 'executor'
-- with parent_agent_id = that id. Detection is STRUCTURAL (stamped at
-- agent_register), never narrative self-report. NULL = unparented — renders
-- flat in the presence UI exactly as before.
ALTER TABLE agents
  ADD COLUMN parent_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL;
