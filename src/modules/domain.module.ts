export type DomainAction = string;

export interface DomainCommand {
  type: string;
  payload?: unknown;
}

export interface DomainExecutionContext {
  tenantId: string;
  userId: string;
  integrationType?: 'none' | 'external';
}

/** Module-owned snapshot; core never interprets shape beyond passing it through. */
export interface DomainContext {
  [key: string]: unknown;
}

export interface DomainModule {
  name: string;
  actions: DomainAction[];

  resolve(input: string): DomainCommand | null;

  execute(
    command: DomainCommand,
    context?: DomainExecutionContext,
    domainContext?: DomainContext,
  ): Promise<unknown>;

  getContext(context: DomainExecutionContext): Promise<DomainContext>;
}
