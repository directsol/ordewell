import {
  CLI_PROVIDERS, getProviderMeta, PROVIDER_PRIORITY, runnerForProvider,
  type AiProvider, type ModelResolver, type PlannerModelMemory,
  type RunnerInstallation, type RunnerTransport, type SettingsService,
} from '@ordewell/core';
import type { ApiProvider } from './adapters/SecretStore';
import type { VsCodeConfig } from './adapters/VsCodeConfig';
import type { ChatViewProvider, PlannerBackend } from './providers/ChatViewProvider';
import { recallPlannerModel } from './plan/PlannerModelSwitch';

export interface PlannerSelectionDeps {
  config: VsCodeConfig;
  modelResolver: ModelResolver;
  plannerModelMemory: PlannerModelMemory;
  runnerInstallation: RunnerInstallation;
  chatProvider: ChatViewProvider;
  settingsService: SettingsService;
  /** Push the chosen model and its provider label to the webview. */
  sendModelConfig: () => void;
  log: (msg: string) => void;
}

/**
 * Who plans, and with which model. The one owner of that transition, shared by
 * the webview pills and the `/planner` command, so neither can half-apply it.
 */
export class PlannerSelection {
  constructor(private readonly deps: PlannerSelectionDeps) {}

  /**
   * Every planner the user could pick, ready or not (ADR-0009). Harness
   * planners come first and are always listed — an uninstalled agent is shown
   * greyed with the reason, because discovering a missing CLI after typing a
   * goal is the failure the preflight exists to prevent. Vendor providers
   * follow, gated on a configured key exactly as `configuredProviders` defines
   * it.
   */
  async backends(): Promise<PlannerBackend[]> {
    const harness = await Promise.all(CLI_PROVIDERS.map(async (id) => {
      const runner = runnerForProvider(id)!;
      const { usable, reason } = await this.deps.runnerInstallation.plannerUsability(runner);
      return {
        id, label: getProviderMeta(id).label, kind: 'harness' as const,
        runner, usable, reason: reason ?? 'coding agent · no API key needed',
      };
    }));
    const configured = this.deps.config.configuredProviders;
    const vendors: PlannerBackend[] = PROVIDER_PRIORITY
      .filter((id) => configured.includes(id as ApiProvider))
      .map((id) => ({
        id, label: getProviderMeta(id).label, kind: 'vendor' as const,
        usable: true, reason: getProviderMeta(id).apiKeyEnvVar,
      }));
    return [...harness, ...vendors];
  }

  /** Switch who plans. */
  async apply(provider: AiProvider): Promise<void> {
    if (!getProviderMeta(provider)) return;
    await this.deps.config.update('aiProvider', provider);
    // A model id from the old backend is meaningless to the new one — an
    // OpenRouter slug handed to Claude Code, or the reverse. `recallPlannerModel`
    // restores what the user last picked *for this provider*, falling back to
    // the catalog default, or blank when discovery has nothing yet.
    const runner = runnerForProvider(provider);
    const harnessModels = runner ? ((await this.deps.modelResolver.modelsForRunners([runner]))[runner] ?? []) : undefined;
    const vendorOptions = runner ? undefined : await this.deps.modelResolver.pickerOptions();
    const { model, effort } = recallPlannerModel(this.deps.plannerModelMemory, provider, harnessModels, vendorOptions);
    await this.deps.config.update('orchestratorModel', model);
    await this.deps.config.update('plannerThinkingEffort', effort);
    this.deps.sendModelConfig();
    await this.sendState();
    this.deps.chatProvider.setSkillToggles(this.deps.settingsService.getTdd(), this.deps.settingsService.getVerification(), []);
    this.deps.log(`Planner set to ${provider}`);
  }

  async sendState(): Promise<void> {
    const provider = this.deps.config.aiProvider;
    this.deps.chatProvider.setPlannerBackends(
      await this.backends(),
      provider,
      runnerForProvider(provider) ?? undefined,
      this.deps.config.plannerThinkingEffort,
    );
  }

  async setModel(modelId: string, effort?: string): Promise<void> {
    await this.deps.config.update('orchestratorModel', modelId);
    await this.deps.config.update('plannerThinkingEffort', effort ?? '');
    this.deps.plannerModelMemory.remember(this.deps.config.aiProvider, modelId, effort);
    this.deps.sendModelConfig();
    await this.sendState();
  }

  setRunnerTransport(transport: RunnerTransport): void {
    this.deps.settingsService.setRunnerTransport(transport);
    this.deps.chatProvider.setRunnerTransport(this.deps.settingsService.getRunnerTransport());
  }

  toggleSkill(skillId: string, enabled: boolean): void {
    if (skillId === 'tdd') this.deps.settingsService.setTdd(enabled);
    else if (skillId === 'verify') this.deps.settingsService.setVerification(enabled);
    this.deps.chatProvider.setSkillToggles(this.deps.settingsService.getTdd(), this.deps.settingsService.getVerification(), []);
  }
}
