import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GitLabClient, cleanLog, projectPath, tail, type Query } from "./gitlab.ts";

const project = z
  .union([z.string(), z.number()])
  .describe('Project ID (e.g. 42) or full path (e.g. "group/subgroup/project")');
const page = z.number().int().min(1).default(1).describe("Page number (1-based)");
const perPage = z.number().int().min(1).max(100).default(20).describe("Items per page (max 100)");

const pipelineStatus = z.enum([
  "created", "waiting_for_resource", "preparing", "pending", "running", "success",
  "failed", "canceled", "skipped", "manual", "scheduled",
]);
const jobScope = z.enum([
  "created", "pending", "running", "failed", "success", "canceled", "skipped",
  "waiting_for_resource", "manual",
]);

// Slim projections: keep what matters for debugging, drop the noise to save tokens.
const slimProject = (p: any) => ({
  id: p.id,
  path_with_namespace: p.path_with_namespace,
  name: p.name,
  default_branch: p.default_branch,
  web_url: p.web_url,
  last_activity_at: p.last_activity_at,
});

const slimPipeline = (p: any) => ({
  id: p.id,
  iid: p.iid,
  status: p.status,
  ref: p.ref,
  sha: p.sha,
  source: p.source,
  created_at: p.created_at,
  updated_at: p.updated_at,
  web_url: p.web_url,
});

const slimJob = (j: any) => ({
  id: j.id,
  name: j.name,
  stage: j.stage,
  status: j.status,
  ref: j.ref,
  allow_failure: j.allow_failure,
  failure_reason: j.failure_reason,
  duration: j.duration,
  queued_duration: j.queued_duration,
  created_at: j.created_at,
  started_at: j.started_at,
  finished_at: j.finished_at,
  pipeline_id: j.pipeline?.id,
  runner: j.runner ? { id: j.runner.id, description: j.runner.description } : null,
  web_url: j.web_url,
});

const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

function safe<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return json(await fn(args));
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
      };
    }
  };
}

export function registerTools(server: McpServer, gl: GitLabClient) {
  server.registerTool(
    "search_projects",
    {
      title: "Search projects",
      description: "Search GitLab projects by name/path. Use this to resolve a project ID or full path.",
      inputSchema: {
        search: z.string().describe("Search term matched against project name and path"),
        membership: z.boolean().default(true).describe("Only projects the token user is a member of"),
        page,
        per_page: perPage,
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ search, membership, page, per_page }) => {
      const res = await gl.getPage<any>("/projects", {
        search,
        membership,
        search_namespaces: true,
        order_by: "last_activity_at",
        simple: true,
        page,
        per_page,
      });
      return { ...res, items: res.items.map(slimProject) };
    }),
  );

  server.registerTool(
    "list_pipelines",
    {
      title: "List pipelines",
      description: "List pipelines of a project, newest first. Filter by ref/status/source to find failing runs.",
      inputSchema: {
        project,
        ref: z.string().optional().describe("Branch or tag name"),
        status: pipelineStatus.optional(),
        source: z.string().optional().describe("e.g. push, merge_request_event, schedule, web, api"),
        sha: z.string().optional().describe("Commit SHA"),
        page,
        per_page: perPage,
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ project, page, per_page, ...filters }) => {
      const res = await gl.getPage<any>(`${projectPath(project)}/pipelines`, {
        ...filters,
        order_by: "id",
        sort: "desc",
        page,
        per_page,
      });
      return { ...res, items: res.items.map(slimPipeline) };
    }),
  );

  server.registerTool(
    "get_pipeline",
    {
      title: "Get pipeline",
      description: "Fetch a single pipeline's details (status, ref, sha, duration, user, coverage...).",
      inputSchema: {
        project,
        pipeline_id: z.number().int().describe("Pipeline ID (not IID)"),
      },
      annotations: { readOnlyHint: true },
    },
    safe(({ project, pipeline_id }) =>
      gl.get(`${projectPath(project)}/pipelines/${pipeline_id}`),
    ),
  );

  server.registerTool(
    "list_jobs",
    {
      title: "List jobs",
      description:
        "List jobs of a project, or of a single pipeline when pipeline_id is given. Use scope=failed to focus on failures.",
      inputSchema: {
        project,
        pipeline_id: z.number().int().optional().describe("Restrict to this pipeline"),
        scope: z.array(jobScope).optional().describe("Job statuses to include"),
        include_retried: z.boolean().default(false).describe("Include retried jobs (pipeline mode only)"),
        page,
        per_page: perPage,
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ project, pipeline_id, scope, include_retried, page, per_page }) => {
      const base = projectPath(project);
      const path = pipeline_id ? `${base}/pipelines/${pipeline_id}/jobs` : `${base}/jobs`;
      const query: Query = { scope, page, per_page };
      if (pipeline_id) query.include_retried = include_retried;
      const res = await gl.getPage<any>(path, query);
      return { ...res, items: res.items.map(slimJob) };
    }),
  );

  server.registerTool(
    "get_job",
    {
      title: "Get job",
      description:
        "Fetch a single job's details. Set include_log=true to also get the tail of its trace (ANSI codes stripped) — the main entry point for debugging a failed job.",
      inputSchema: {
        project,
        job_id: z.number().int(),
        include_log: z.boolean().default(false),
        log_tail_lines: z.number().int().min(1).max(5000).default(200).describe("Lines kept from the end of the log"),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ project, job_id, include_log, log_tail_lines }) => {
      const base = `${projectPath(project)}/jobs/${job_id}`;
      const job = await gl.get<any>(base);
      if (!include_log) return job;
      const log = tail(cleanLog(await gl.getText(`${base}/trace`)), log_tail_lines);
      return { ...job, log };
    }),
  );
}
