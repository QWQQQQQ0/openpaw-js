import { TaskTreeDB } from './task-tree-db';
import { AgentRunner } from './agent-runner';
import { RecoveryService } from './recovery';
import type { AgentRunResult } from './agent-runner';
import type { SplitDecision, AgentType } from './types';
import type { TaskTreeRow } from '@/db/types';
import type { IModelService } from '@/interfaces/model-service';
import type { ProviderConfig } from '@/types/provider';

// ---------------------------------------------------------------------------
// Orchestrator — top-level entry point for complex code generation tasks
// ---------------------------------------------------------------------------

export class Orchestrator {
  private taskDB = new TaskTreeDB();
  private runner = new AgentRunner();
  private recovery = new RecoveryService();
  private modelService: IModelService | null = null;
  private provider: ProviderConfig | null = null;
  private apiKey: string | null = null;

  // ---- Anti-hallucination constraints ------------------------------------

  /**
   * Maximum tree depth allowed.
   * Level 0 = root (project), level 3 = deepest leaf.
   * Total: 4 levels.
   */
  private readonly MAX_DEPTH = 3;

  /**
   * Minimum architect confidence score (0-10) required to split.
   * Anything below this threshold means "do not split".
   */
  private readonly SPLIT_SCORE_THRESHOLD = 7;

  // ---- Public API ---------------------------------------------------------

  /**
   * Configure ModelService for unified LLM access.
   * When set, llmCallFn parameters become optional.
   */
  setModelService(modelService: IModelService, provider: ProviderConfig, apiKey: string): void {
    this.modelService = modelService;
    this.provider = provider;
    this.apiKey = apiKey;
  }

  /**
   * Resolve LLM caller: prefer modelService, fallback to llmCallFn.
   */
  private resolveLlmCallFn(
    llmCallFn?: (messages: unknown[], tools: unknown[]) => AsyncGenerator<string>,
  ): (messages: unknown[], tools: unknown[]) => AsyncGenerator<string> {
    if (llmCallFn) return llmCallFn;

    if (this.modelService && this.provider && this.apiKey) {
      const { modelService, provider, apiKey } = this;
      return async function* (messages: unknown[], tools: unknown[]) {
        const { ModelScenario } = await import('@/services/llm-gateway/gateway');
        const stream = modelService.chatStream({
          scenario: ModelScenario.codeGeneration,
          messages: messages as Parameters<typeof modelService.chatStream>[0]['messages'],
          provider,
          apiKey,
          tools: tools as Record<string, unknown>[] | undefined,
        });

        for await (const chunk of stream) {
          if (chunk.startsWith('__ERROR__:')) {
            throw new Error(chunk.substring(10));
          }
          if (chunk.startsWith('__REASONING__:')) continue;
          if (chunk.startsWith('__TOOLS__:')) continue;
          yield chunk;
        }
      };
    }

    throw new Error('No LLM caller configured: provide llmCallFn or call setModelService() first');
  }

  /**
   * Start a new project or resume an existing one.
   *
   * 1. Creates a root task node in the task tree.
   * 2. Stores the full requirement as the root contract.
   * 3. Executes the full 4-phase pipeline.
   */
  async startProject(params: {
    projectName: string;
    requirement: string;
    llmCallFn?: (messages: unknown[], tools: unknown[]) => AsyncGenerator<string>;
  }): Promise<AgentRunResult> {
    const agentId = this.runner.generateAgentId('orchestrator');
    const rootTaskId = await this.taskDB.createRoot(params.projectName, agentId);

    // Store the plain-text requirement as the root contract
    await this.taskDB.updateContract(
      rootTaskId,
      JSON.stringify({ requirement: params.requirement }),
    );

    const llmCallFn = this.resolveLlmCallFn(params.llmCallFn);
    return this.executePipeline(params.projectName, params.requirement, llmCallFn);
  }

  /**
   * Resume a previously started project.
   *
   * Loads the project from the task tree, recovers the requirement from the
   * root task's contract, then re-enters the pipeline.  Phases and tasks that
   * are already complete are skipped automatically.
   */
  async resumeProject(
    projectName: string,
    llmCallFn?: (messages: unknown[], tools: unknown[]) => AsyncGenerator<string>,
  ): Promise<AgentRunResult> {
    const allTasks = await this.taskDB.getByProject(projectName);
    if (allTasks.length === 0) {
      throw new Error(`No project found with name "${projectName}". Use startProject() to create one.`);
    }

    const rootTask = allTasks.find((t) => t.depth === 0);
    if (!rootTask) {
      throw new Error(`Project "${projectName}" exists but has no root task — tree is corrupt.`);
    }

    // Recover the requirement from the root contract
    let requirement = rootTask.module_name;
    if (rootTask.contract_json) {
      try {
        const parsed = JSON.parse(rootTask.contract_json);
        if (typeof parsed.requirement === 'string') {
          requirement = parsed.requirement;
        }
      } catch {
        // fall through to module_name
      }
    }

    const resolvedFn = this.resolveLlmCallFn(llmCallFn);
    return this.executePipeline(projectName, requirement, resolvedFn);
  }

  /**
   * Compatibility method called by CodeGateway.
   *
   * Maps the code-gateway's parameter names to startProject and adapts the
   * return type to GatewayResult.
   */
  async runGenerationTask(params: {
    userRequest: string;
    projectName: string;
    llmCallFn?: (messages: unknown[], tools?: unknown[]) => AsyncGenerator<string>;
  }): Promise<{ success: boolean; result?: unknown; error?: string }> {
    // Resolve LLM caller
    const resolvedFn = this.resolveLlmCallFn(params.llmCallFn);

    const agentResult = await this.startProject({
      projectName: params.projectName,
      requirement: params.userRequest,
      llmCallFn: resolvedFn,
    });

    return {
      success: agentResult.success,
      result: agentResult.outputFiles.length > 0 ? agentResult.outputFiles : undefined,
      error: agentResult.error,
    };
  }

  // ---- Pipeline ----------------------------------------------------------

  /**
   * Execute the full 4-phase pipeline:
   *
   * Phase 1 — Architect:  Recursive decomposition (anti-hallucination enforced)
   * Phase 2 — Developer:   Parallel code generation for leaf modules
   * Phase 3 — Reviewer:    Quality review of generated code
   * Phase 4 — Integrator:  Final assembly and cross-module wiring
   */
  private async executePipeline(
    projectName: string,
    _requirement: string,
    llmCallFn: (messages: unknown[], tools: unknown[]) => AsyncGenerator<string>,
  ): Promise<AgentRunResult> {
    // ---- Phase 1: Architect decomposition ---------------------------------
    const rootTasks = await this.taskDB.getByProject(projectName);
    const rootTask = rootTasks.find((t) => t.depth === 0);
    if (!rootTask) {
      return { success: false, taskId: '', agentId: '', outputFiles: [], error: 'Root task not found.' };
    }

    await this.runArchitectPhase(rootTask.id, projectName, llmCallFn);

    // ---- Phase 2: Developer -----------------------------------------------
    await this.runDeveloperPhase(projectName, llmCallFn);

    // ---- Phase 3: Reviewer ------------------------------------------------
    await this.runReviewerPhase(projectName, llmCallFn);

    // ---- Phase 4: Integrator ----------------------------------------------
    return this.runIntegratorPhase(projectName, llmCallFn);
  }

  // ---- Phase 1: Architect (recursive decomposition) -----------------------

  /**
   * Recursively decompose a task node.
   *
   * Anti-hallucination constraints:
   *  - Hard depth limit (MAX_DEPTH = 3)
   *  - Score threshold (SPLIT_SCORE_THRESHOLD = 7)
   *  - "不拆分是正常的" baked into the context prompt
   */
  private async runArchitectPhase(
    taskId: string,
    projectName: string,
    llmCallFn: (messages: unknown[], tools: unknown[]) => AsyncGenerator<string>,
  ): Promise<void> {
    const task = await this.taskDB.getById(taskId);
    if (!task) return;

    // Anti-hallucination: depth limit
    if (task.depth >= this.MAX_DEPTH) return;

    // If the task already has children (from a previous run), recurse into them
    const existingChildren = await this.taskDB.getChildren(taskId);
    if (existingChildren.length > 0) {
      for (const child of existingChildren) {
        await this.runArchitectPhase(child.id, projectName, llmCallFn);
      }
      return;
    }

    // If the task is already done (e.g. a leaf that was developed in a
    // previous session), skip.
    if (task.status === 'done' || task.status === 'failed') return;

    // Run the architect agent
    const result = await this.runner.runAgent({
      taskId,
      agentType: 'architect',
      projectName,
      llmCallFn,
      maxTurns: 5,
    });

    if (!result.success) {
      // Architect failed — mark as leaf (don't split) and move on
      await this.taskDB.updateStatus(taskId, 'done', 'Architect agent encountered an error; treating as leaf.');
      return;
    }

    // Read the decision the architect stored in decision_json
    const updated = await this.taskDB.getById(taskId);
    if (!updated?.decision_json) return; // No decision made — treat as leaf

    let decision: SplitDecision;
    try {
      decision = JSON.parse(updated.decision_json) as SplitDecision;
    } catch {
      return; // Corrupt decision — treat as leaf
    }

    // Anti-hallucination: score threshold
    if (!decision.should_split || decision.score < this.SPLIT_SCORE_THRESHOLD) {
      return; // Legitimate leaf node — ready for development
    }

    // Guard against empty / hallucinated sub_module lists
    if (!decision.sub_modules || decision.sub_modules.length === 0) {
      return;
    }

    // Create child tasks for each sub-module and recurse
    for (const sub of decision.sub_modules) {
      const childId = await this.taskDB.createChild(
        taskId,
        sub.name,
        `${task.module_path}/${sub.name}`,
        'architect',       // Each child starts as "architect" type; will be re-assigned
        task.depth + 1,
        JSON.stringify(sub),  // Store sub-module info as the child's initial contract
      );

      await this.runArchitectPhase(childId, projectName, llmCallFn);
    }
  }

  // ---- Phase 2: Developer ------------------------------------------------

  /**
   * Run developer agents for every leaf module that hasn't been developed yet.
   */
  private async runDeveloperPhase(
    projectName: string,
    llmCallFn: (messages: unknown[], tools: unknown[]) => AsyncGenerator<string>,
  ): Promise<void> {
    const leafTasks = await this._getLeafTasks(projectName);

    for (const task of leafTasks) {
      // Skip tasks already developed (status 'done' with output files)
      if (await this._isAlreadyDeveloped(task)) continue;
      if (task.status === 'failed') continue;

      await this.runner.runAgent({
        taskId: task.id,
        agentType: 'developer',
        projectName,
        llmCallFn,
        maxTurns: 15,
      });
    }
  }

  // ---- Phase 3: Reviewer -------------------------------------------------

  /**
   * Run reviewer agents for every developed leaf module.
   */
  private async runReviewerPhase(
    projectName: string,
    llmCallFn: (messages: unknown[], tools: unknown[]) => AsyncGenerator<string>,
  ): Promise<void> {
    const leafTasks = await this._getLeafTasks(projectName);

    for (const task of leafTasks) {
      // Only review tasks that were actually developed
      if (task.status !== 'done' && task.status !== 'reviewing') continue;
      if (!task.output_files_json) continue;

      // Parse output files — skip if none were generated
      let files: string[];
      try {
        files = JSON.parse(task.output_files_json) as string[];
      } catch {
        continue;
      }
      if (files.length === 0) continue;

      // Skip if already reviewed (agent_type was changed to 'reviewer')
      if (task.agent_type === 'reviewer' && task.status === 'done') continue;

      await this.runner.runAgent({
        taskId: task.id,
        agentType: 'reviewer',
        projectName,
        llmCallFn,
        maxTurns: 5,
      });
    }
  }

  // ---- Phase 4: Integrator -----------------------------------------------

  /**
   * Run the integrator agent to assemble the final system.
   *
   * Before running, collects all output files from all leaf tasks and
   * registers them on the root task so the integrator has full context.
   */
  private async runIntegratorPhase(
    projectName: string,
    llmCallFn: (messages: unknown[], tools: unknown[]) => AsyncGenerator<string>,
  ): Promise<AgentRunResult> {
    const allTasks = await this.taskDB.getByProject(projectName);
    const rootTask = allTasks.find((t) => t.depth === 0);
    if (!rootTask) {
      return { success: false, taskId: '', agentId: '', outputFiles: [], error: 'Root task not found for integration.' };
    }

    // Collect all output files from the entire tree so the integrator sees everything
    const allFiles = this._collectAllOutputFiles(allTasks);
    const rootAgentId = rootTask.agent_id ?? this.runner.generateAgentId('orchestrator');

    if (allFiles.length === 0) {
      // Nothing to integrate
      return {
        success: true,
        taskId: rootTask.id,
        agentId: rootAgentId,
        outputFiles: [],
      };
    }

    // Update root task with the full file list so ContextBuilder loads them
    await this.taskDB.updateOutputFiles(rootTask.id, JSON.stringify(allFiles));

    // Check if integration was already done
    if (rootTask.status === 'done' && rootTask.agent_type === 'integrator') {
      return {
        success: true,
        taskId: rootTask.id,
        agentId: rootAgentId,
        outputFiles: allFiles,
      };
    }

    const result = await this.runner.runAgent({
      taskId: rootTask.id,
      agentType: 'integrator',
      projectName,
      llmCallFn,
      maxTurns: 10,
    });

    return {
      ...result,
      outputFiles: result.outputFiles.length > 0 ? result.outputFiles : allFiles,
    };
  }

  // ---- Private: Helpers --------------------------------------------------

  /**
   * Return all leaf tasks (tasks with no children) for a project.
   */
  private async _getLeafTasks(projectName: string): Promise<TaskTreeRow[]> {
    const allTasks = await this.taskDB.getByProject(projectName);

    // Build a set of all task IDs that are parents of at least one child
    const parentIds = new Set<string>();
    for (const t of allTasks) {
      if (t.parent_module_id) {
        parentIds.add(t.parent_module_id);
      }
    }

    return allTasks.filter((t) => !parentIds.has(t.id));
  }

  /**
   * Check whether a leaf task has already been developed (has output files
   * from a previous developer run).
   */
  private async _isAlreadyDeveloped(task: TaskTreeRow): Promise<boolean> {
    if (task.status !== 'done') return false;
    if (!task.output_files_json) return false;
    try {
      const files = JSON.parse(task.output_files_json) as string[];
      return files.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Collect every output file path from every task in the tree.
   */
  private _collectAllOutputFiles(tasks: TaskTreeRow[]): string[] {
    const all = new Set<string>();
    for (const t of tasks) {
      if (t.output_files_json) {
        try {
          const files = JSON.parse(t.output_files_json) as string[];
          for (const f of files) all.add(f);
        } catch {
          // skip corrupt entries
        }
      }
    }
    return [...all];
  }
}
