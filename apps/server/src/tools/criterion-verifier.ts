import type {
  CompletionCriterion,
  EnvironmentObservation,
  TaskDefinition,
  ToolResult,
  VerificationResult,
} from '@helm/shared';
import { browserUrlsMatch } from '@helm/shared';

import { BROWSER_RESEARCH_CRITERION_ID } from '../agent/browser-research';
import type { GuestTransport } from './guest-transport';

export type CriterionType = CompletionCriterion['type'];
export type CriterionFor<T extends CriterionType> = Extract<CompletionCriterion, { type: T }>;

export interface CriterionVerificationContext {
  guest: GuestTransport;
  observation?: EnvironmentObservation;
  lastToolResult?: ToolResult;
  /** Most recent successful page-content read, even when a later file/viewer action is last. */
  browserContentResult?: ToolResult;
}

export interface CriterionCheck {
  passed: boolean;
  message: string;
  evidence?: unknown;
}

export type CriterionVerifier<C extends CompletionCriterion = CompletionCriterion> = {
  type: C['type'];
  verify: (
    criterion: C,
    context: CriterionVerificationContext,
  ) => Promise<CriterionCheck> | CriterionCheck;
};

export type CriterionVerifierFunction<C extends CompletionCriterion> = (
  criterion: C,
  context: CriterionVerificationContext,
) => Promise<CriterionCheck> | CriterionCheck;

function criterionLabel(criterion: CompletionCriterion): string {
  switch (criterion.type) {
    case 'browser.url':
      return `browser.url=${criterion.url}`;
    case 'file.exists':
      return `file.exists=${criterion.path}`;
    case 'file.contains':
      return `file.contains=${criterion.path}`;
    case 'window.open':
      return `window.open=${criterion.application ?? '*'}:${criterion.titleIncludes ?? '*'}`;
    case 'window.focused':
      return `window.focused=${criterion.application ?? '*'}:${criterion.titleIncludes ?? '*'}`;
    case 'custom':
      return `custom=${criterion.id}`;
  }
}

function safeError(error: unknown): CriterionCheck {
  return {
    passed: false,
    message: error instanceof Error ? error.message : String(error),
  };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function matchesWindow(
  window: { application?: string; title: string },
  criterion: { application?: string; titleIncludes?: string },
): boolean {
  return (
    (!criterion.application || window.application === criterion.application) &&
    (!criterion.titleIncludes || window.title.includes(criterion.titleIncludes))
  );
}

/** Machine-checkable completion criteria backed by actual guest state. */
export class CriterionVerifierRegistry {
  private readonly verifiers = new Map<CriterionType, CriterionVerifierFunction<CompletionCriterion>>();
  private readonly guest?: GuestTransport;

  constructor(guest?: GuestTransport, registerDefaults = true) {
    this.guest = guest;
    if (registerDefaults) this.registerDefaultVerifiers();
  }

  register<T extends CriterionType>(
    type: T,
    verify: CriterionVerifierFunction<CriterionFor<T>>,
  ): this;
  register<C extends CompletionCriterion>(verifier: CriterionVerifier<C>): this;
  register<C extends CompletionCriterion>(
    typeOrVerifier: C['type'] | CriterionVerifier<C>,
    verify?: CriterionVerifierFunction<C>,
  ): this {
    const type = typeof typeOrVerifier === 'string' ? typeOrVerifier : typeOrVerifier.type;
    const functionToRegister = typeof typeOrVerifier === 'string' ? verify : typeOrVerifier.verify;
    if (!functionToRegister) throw new Error(`Verifier is required for ${type}`);
    this.verifiers.set(type, functionToRegister as unknown as CriterionVerifierFunction<CompletionCriterion>);
    return this;
  }

  has(type: CriterionType): boolean {
    return this.verifiers.has(type);
  }

  async verifyCriterion(
    criterion: CompletionCriterion,
    context: Omit<CriterionVerificationContext, 'guest'> & { guest?: GuestTransport } = {},
  ): Promise<CriterionCheck> {
    const verifier = this.verifiers.get(criterion.type);
    if (!verifier) {
      return { passed: false, message: `No verifier registered for ${criterion.type}` };
    }
    const guest = context.guest ?? this.guest;
    if (!guest) {
      return { passed: false, message: 'Criterion verification requires a guest transport' };
    }
    try {
      return await verifier(criterion, { ...context, guest });
    } catch (error) {
      return safeError(error);
    }
  }

  async verifyTask(
    task: Pick<TaskDefinition, 'criteria'>,
    context: Omit<CriterionVerificationContext, 'guest'> & { guest?: GuestTransport } = {},
  ): Promise<VerificationResult> {
    const criteria = await Promise.all(
      task.criteria.map(async criterion => {
        const check = await this.verifyCriterion(criterion, context);
        return {
          criterion,
          passed: check.passed,
          message: check.message,
          ...(check.evidence === undefined ? {} : { evidence: check.evidence }),
        };
      }),
    );
    const complete = criteria.length > 0 && criteria.every(criterion => criterion.passed);
    const passed = criteria.filter(criterion => criterion.passed).length;
    const summary = criteria.length === 0
      ? 'Task has no completion criteria.'
      : `${passed}/${criteria.length} completion criteria passed.`;
    return { complete, criteria, summary };
  }

  verifyProgress(
    task: Pick<TaskDefinition, 'criteria'>,
    _result: ToolResult,
    context: Omit<CriterionVerificationContext, 'guest'> & { guest?: GuestTransport } = {},
  ): Promise<VerificationResult> {
    return this.verifyTask(task, context);
  }

  private registerDefaultVerifiers(): void {
    this.register('browser.url', async (criterion, context) => {
      const guest = this.requireGuest();
      const state = await guest.request('browser.getState', {});
      const resultData = recordValue(context.lastToolResult?.data);
      const resultEvidence = recordValue(context.lastToolResult?.evidence);
      const receipt = recordValue(resultEvidence?.receipt);
      const effect = recordValue(receipt?.effect);
      const requestedUrl = effect?.requestedUrl;
      const finalUrl = resultData?.url;
      const followedRedirect = context.lastToolResult?.ok === true
        && typeof requestedUrl === 'string'
        && typeof finalUrl === 'string'
        && browserUrlsMatch(requestedUrl, criterion.url)
        && browserUrlsMatch(state.url, finalUrl);
      const passed = browserUrlsMatch(state.url, criterion.url) || followedRedirect;
      return {
        passed,
        message: passed
          ? followedRedirect
            ? `Browser followed the redirect from ${criterion.url} to ${state.url}.`
            : `Browser URL is ${criterion.url}.`
          : `Browser URL is not ${criterion.url}.`,
        evidence: followedRedirect ? { state, requestedUrl, finalUrl } : state,
      };
    });

    this.register('file.exists', async criterion => {
      const guest = this.requireGuest();
      const state = await guest.request('fs.stat', { path: criterion.path });
      const passed = state.exists;
      return {
        passed,
        message: passed ? `File exists: ${criterion.path}.` : `File does not exist: ${criterion.path}.`,
        evidence: state,
      };
    });

    this.register('file.contains', async criterion => {
      const guest = this.requireGuest();
      try {
        const state = await guest.request('fs.read', { path: criterion.path });
        const passed = state.content.includes(criterion.expected);
        return {
          passed,
          message: passed
            ? `File contains the expected text: ${criterion.path}.`
            : `File does not contain the expected text: ${criterion.path}.`,
          evidence: { path: state.path, size: state.size, contains: passed },
        };
      } catch (error) {
        return safeError(error);
      }
    });

    this.register('window.open', async criterion => {
      const guest = this.requireGuest();
      const state = await guest.request('desktop.getState', {});
      const matched = state.windows.find(window => matchesWindow(window, criterion));
      return {
        passed: Boolean(matched),
        message: matched ? `Matching window is open: ${matched.title}.` : 'No matching window is open.',
        evidence: { windows: state.windows },
      };
    });

    this.register('window.focused', async criterion => {
      const guest = this.requireGuest();
      const state = await guest.request('desktop.getState', {});
      const matched = state.focusedWindow && matchesWindow(state.focusedWindow, criterion)
        ? state.focusedWindow
        : undefined;
      return {
        passed: Boolean(matched),
        message: matched ? `Matching window is focused: ${matched.title}.` : 'No matching window is focused.',
        evidence: { focusedWindow: state.focusedWindow },
      };
    });

    this.register('custom', async (criterion, context) => {
      if (criterion.id === BROWSER_RESEARCH_CRITERION_ID) {
        const browserResult = context.browserContentResult ?? context.lastToolResult;
        const data = recordValue(browserResult?.data);
        const sectionText = Array.isArray(data?.sections)
          ? data.sections.flatMap(section => {
            const value = recordValue(section);
            return typeof value?.text === 'string' ? [value.text.trim()] : [];
          }).join('\n')
          : '';
        const text = typeof data?.text === 'string' ? data.text.trim() : sectionText.trim();
        const passed = browserResult?.ok === true && text.length > 0;
        return {
          passed,
          message: passed
            ? 'Readable web page content was collected.'
            : 'Readable web page content has not been collected yet.',
          evidence: data ? { url: data.url, title: data.title, textLength: text.length } : undefined,
        };
      }
      return {
        passed: false,
        message: `No custom verifier registered for ${criterion.id}: ${criterion.description}`,
      };
    });
  }

  private requireGuest(): GuestTransport {
    if (!this.guest) throw new Error('Criterion verification requires a guest transport');
    return this.guest;
  }
}

export const VerifierRegistry = CriterionVerifierRegistry;
export const createCriterionVerifierRegistry = (guest: GuestTransport): CriterionVerifierRegistry =>
  new CriterionVerifierRegistry(guest);
export { criterionLabel };
