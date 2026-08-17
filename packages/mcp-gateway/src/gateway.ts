import type { ApprovalSummary, InMemoryApprovalService } from "@shadeguard/approval-service";
import {
  Capability,
  Decision,
  ReasonCode,
  RiskLevel,
  createAuditEvent,
  type AuditSink,
  type CanonicalRequest,
  type DeterministicPolicyEngine,
  type PolicyResult,
  type RequesterContext,
} from "@shadeguard/core";
import {
  ProviderCapability,
  type PaymentStatus,
  type PaymentSubmission,
  type ProviderInfo,
  type ZcashProvider,
} from "@shadeguard/zcash-adapter";

import { MemorySpendLedger, type SpendLedger } from "./spend-ledger.js";

export interface SafeAlternative {
  readonly requestId: string;
  readonly capability: string;
  readonly amountZatoshi?: number;
  readonly memoRemoved: boolean;
}

export interface GatewayResult {
  readonly requestId: string;
  readonly decision: string;
  readonly risk: string;
  readonly reasonCode: string;
  readonly explanation: string;
  readonly affordable?: boolean;
  readonly payment?: PaymentSubmission;
  readonly paymentStatus?: PaymentStatus;
  readonly receiveAddress?: string;
  readonly safeAlternative?: SafeAlternative;
  readonly approval?: ApprovalSummary;
  readonly errorCode?: "PROVIDER_CAPABILITY_UNAVAILABLE" | "PROVIDER_EXECUTION_FAILED";
}

interface PendingApproval {
  readonly request: CanonicalRequest;
  readonly policy: PolicyResult;
  readonly approvalId: string;
  token?: string;
}

export class ShadeGuardGateway {
  private spentTodayZatoshi = 0;
  private spendingDay = new Date().toISOString().slice(0, 10);
  private readonly pending = new Map<string, PendingApproval>();
  private executionQueue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly policyEngine: DeterministicPolicyEngine,
    private readonly provider: ZcashProvider,
    private readonly approvals: InMemoryApprovalService,
    private readonly audit: AuditSink,
    private readonly spendLedger: SpendLedger = new MemorySpendLedger(),
  ) {}

  public async initialize(): Promise<void> {
    await this.provider.initialize();
    this.spentTodayZatoshi = await this.spendLedger.spentOn(this.spendingDay);
  }

  public async close(): Promise<void> {
    await this.provider.close?.();
  }

  public providerInfo(): ProviderInfo {
    return this.provider.info();
  }

  /** Evaluates and audits a request without approvals or downstream execution. */
  public async inspect(request: CanonicalRequest): Promise<GatewayResult> {
    return this.enqueueExecution(async () => {
      await this.rollSpendingDay();
      const policy = this.policyEngine.evaluate(request, { spentTodayZatoshi: this.spentTodayZatoshi });
      await this.audit.write(createAuditEvent(request, policy, { outcome: "POLICY_ONLY" }));
      return {
        ...this.policyFields(request.id, policy),
        ...(policy.rewrittenRequest === undefined
          ? {}
          : { safeAlternative: this.toSafeAlternative(policy.rewrittenRequest, request.memo !== undefined) }),
      };
    });
  }

  public async execute(
    request: CanonicalRequest,
    options: { readonly acceptSafeRewrite?: boolean } = {},
  ): Promise<GatewayResult> {
    return this.enqueueExecution(() => this.executeSerial(request, options));
  }

  private async executeSerial(
    request: CanonicalRequest,
    options: { readonly acceptSafeRewrite?: boolean },
  ): Promise<GatewayResult> {
    await this.rollSpendingDay();
    const policy = this.policyEngine.evaluate(request, { spentTodayZatoshi: this.spentTodayZatoshi });
    await this.audit.write(createAuditEvent(request, policy, { outcome: "POLICY_ONLY" }));

    if (policy.decision === Decision.REWRITE) {
      if (!policy.rewrittenRequest) throw new Error("Policy returned REWRITE without a rewritten request");
      if (!options.acceptSafeRewrite) {
        return {
          ...this.policyFields(request.id, policy),
          safeAlternative: this.toSafeAlternative(policy.rewrittenRequest, request.memo !== undefined),
        };
      }

      const rewrittenPolicy = this.policyEngine.evaluate(policy.rewrittenRequest, {
        spentTodayZatoshi: this.spentTodayZatoshi,
      });
      await this.audit.write(createAuditEvent(policy.rewrittenRequest, rewrittenPolicy, { outcome: "POLICY_ONLY" }));
      return this.handleEvaluated(policy.rewrittenRequest, rewrittenPolicy);
    }

    return this.handleEvaluated(request, policy);
  }

  public approve(approvalId: string): { readonly requestId: string } {
    const pending = [...this.pending.values()].find((entry) => entry.approvalId === approvalId);
    if (!pending) throw new Error("Pending approval was not found");
    pending.token = this.approvals.approve(approvalId);
    return { requestId: pending.request.id };
  }

  public async resumeApproved(requestId: string, requester: RequesterContext): Promise<GatewayResult> {
    return this.enqueueExecution(() => this.resumeApprovedSerial(requestId, requester));
  }

  private async resumeApprovedSerial(requestId: string, requester: RequesterContext): Promise<GatewayResult> {
    await this.rollSpendingDay();
    const pending = this.pending.get(requestId);
    if (!pending || !pending.token) throw new Error("Request is not approved and ready to resume");
    if (
      pending.request.requester.agentId !== requester.agentId ||
      pending.request.requester.sessionId !== requester.sessionId
    ) {
      throw new Error("Approved request belongs to a different requester");
    }

    const currentPolicy = this.policyEngine.evaluate(pending.request, { spentTodayZatoshi: this.spentTodayZatoshi });
    if (currentPolicy.decision === Decision.DENY || currentPolicy.decision === Decision.REWRITE) {
      await this.audit.write(createAuditEvent(pending.request, currentPolicy, { outcome: "POLICY_ONLY" }));
      return this.policyFields(pending.request.id, currentPolicy);
    }

    this.approvals.consume(pending.token, pending.request);
    this.pending.delete(requestId);
    const approvedPolicy: PolicyResult = {
      ...currentPolicy,
      decision: Decision.ALLOW,
      explanation: "The user approved this exact request; the one-use approval has been consumed.",
    };
    return this.executeProvider(pending.request, approvedPolicy);
  }

  public listApprovals(): readonly ApprovalSummary[] {
    return this.approvals.list();
  }

  private async handleEvaluated(request: CanonicalRequest, policy: PolicyResult): Promise<GatewayResult> {
    if (policy.decision === Decision.DENY) return this.policyFields(request.id, policy);
    if (policy.decision === Decision.REQUIRE_APPROVAL) {
      const approval = this.approvals.create(request, policy);
      this.pending.set(request.id, { request, policy, approvalId: approval.id });
      return { ...this.policyFields(request.id, policy), approval };
    }
    return this.executeProvider(request, policy);
  }

  private async executeProvider(request: CanonicalRequest, policy: PolicyResult): Promise<GatewayResult> {
    const required = this.providerCapability(request.capability);
    if (!required || !this.provider.info().capabilities.has(required)) {
      const unavailable: PolicyResult = {
        decision: Decision.DENY,
        risk: RiskLevel.HIGH,
        reasonCode: ReasonCode.PROVIDER_CAPABILITY_UNAVAILABLE,
        explanation: "The downstream provider did not advertise the required safe capability.",
      };
      await this.audit.write(
        createAuditEvent(request, unavailable, { provider: this.provider.info().name, outcome: "FAILED" }),
      );
      return {
        ...this.policyFields(request.id, unavailable),
        errorCode: "PROVIDER_CAPABILITY_UNAVAILABLE",
      };
    }

    try {
      let response: GatewayResult;
      switch (request.capability) {
        case Capability.CAN_AFFORD:
          response = {
            ...this.policyFields(request.id, policy),
            affordable: await this.provider.canAfford(this.requiredAmount(request)),
          };
          break;
        case Capability.SEND_SHIELDED: {
          const amountZatoshi = this.requiredAmount(request);
          const reserved = await this.spendLedger.reserve(this.spendingDay, request.id, amountZatoshi);
          if (reserved) this.spentTodayZatoshi += amountZatoshi;
          const payment = await this.provider.sendShielded({
            requestId: request.id,
            amountZatoshi,
            recipient: this.requiredRecipient(request),
            ...(request.memo === undefined ? {} : { memo: request.memo }),
          });
          response = { ...this.policyFields(request.id, policy), payment };
          break;
        }
        case Capability.GET_PAYMENT_STATUS:
          response = {
            ...this.policyFields(request.id, policy),
            paymentStatus: await this.provider.getPaymentStatus(this.requiredPaymentId(request)),
          };
          break;
        case Capability.GET_RECEIVE_ADDRESS:
          response = {
            ...this.policyFields(request.id, policy),
            receiveAddress: await this.provider.getReceiveAddress(),
          };
          break;
        default:
          throw new Error("Policy allowed a capability with no provider mapping");
      }
      await this.audit.write(
        createAuditEvent(request, policy, { provider: this.provider.info().name, outcome: "EXECUTED" }),
      );
      return response;
    } catch {
      const failed: PolicyResult = {
        decision: Decision.DENY,
        risk: RiskLevel.HIGH,
        reasonCode: ReasonCode.PROVIDER_EXECUTION_FAILED,
        explanation: "The downstream provider could not complete the safe operation.",
      };
      await this.audit.write(createAuditEvent(request, failed, { provider: this.provider.info().name, outcome: "FAILED" }));
      return { ...this.policyFields(request.id, failed), errorCode: "PROVIDER_EXECUTION_FAILED" };
    }
  }

  private providerCapability(capability: CanonicalRequest["capability"]): ProviderCapability | undefined {
    switch (capability) {
      case Capability.CAN_AFFORD:
        return ProviderCapability.CAN_AFFORD;
      case Capability.SEND_SHIELDED:
        return ProviderCapability.SEND_SHIELDED;
      case Capability.GET_PAYMENT_STATUS:
        return ProviderCapability.GET_PAYMENT_STATUS;
      case Capability.GET_RECEIVE_ADDRESS:
        return ProviderCapability.GET_RECEIVE_ADDRESS;
      default:
        return undefined;
    }
  }

  private policyFields(requestId: string, policy: PolicyResult): GatewayResult {
    return {
      requestId,
      decision: policy.decision,
      risk: policy.risk,
      reasonCode: policy.reasonCode,
      explanation: policy.explanation,
    };
  }

  private toSafeAlternative(request: CanonicalRequest, memoRemoved: boolean): SafeAlternative {
    return {
      requestId: request.id,
      capability: request.capability,
      memoRemoved,
      ...(request.amountZatoshi === undefined ? {} : { amountZatoshi: request.amountZatoshi }),
    };
  }

  private requiredAmount(request: CanonicalRequest): number {
    if (request.amountZatoshi === undefined) throw new Error("Canonical request has no amount");
    return request.amountZatoshi;
  }

  private requiredRecipient(request: CanonicalRequest): string {
    if (!request.recipient) throw new Error("Canonical request has no recipient");
    return request.recipient.address;
  }

  private requiredPaymentId(request: CanonicalRequest): string {
    if (!request.paymentId) throw new Error("Canonical request has no payment ID");
    return request.paymentId;
  }

  private async rollSpendingDay(): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.spendingDay) {
      this.spendingDay = today;
      this.spentTodayZatoshi = await this.spendLedger.spentOn(today);
    }
  }

  private enqueueExecution<T>(operation: () => Promise<T>): Promise<T> {
    const execution = this.executionQueue.then(operation, operation);
    this.executionQueue = execution.then(
      () => undefined,
      () => undefined,
    );
    return execution;
  }
}
