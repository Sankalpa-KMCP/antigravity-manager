import { SwitchSession, TargetId, TargetState } from '../types';
import { callConnectRpc } from '../rpc/client';
import { fetchUserStatus } from '../rpc/endpoints';
import { parseUserStatus } from '../usage/parser';

export class SwitchManager {
  private activeSession: SwitchSession | null = null;
  private verificationTimer: NodeJS.Timeout | null = null;
  private pollTriggerCallback: (() => Promise<void>) | null = null;
  private onSwitchSuccessCallback: ((targetId: TargetId, newEmail: string) => Promise<void>) | null = null;

  setPollTrigger(cb: () => Promise<void>) {
    this.pollTriggerCallback = cb;
  }

  onSwitchSuccess(cb: (targetId: TargetId, newEmail: string) => Promise<void>) {
    this.onSwitchSuccessCallback = cb;
  }

  getActiveSession(): SwitchSession | null {
    return this.activeSession;
  }

  async initiateSwitch(target: TargetState, csrfToken: string | null): Promise<SwitchSession> {
    // Cancel any previous session
    this.cancelSwitch();

    const oldEmail = target.email;
    const timeoutSeconds = 300; // 5 minutes for manual user interaction
    const expiresAt = new Date(Date.now() + timeoutSeconds * 1000).toISOString();

    let triggerMessage = '';

    if (target.id === 'antigravity2') {
      // Antigravity 2.0: Initiate supported LoginWithBrowser Connect-RPC
      try {
        if (target.port && csrfToken) {
          // Fire-and-forget or non-blocking trigger of LoginWithBrowser
          callConnectRpc({
            port: target.port,
            csrfToken,
            endpoint: 'LoginWithBrowser',
            body: { isGcpTos: false },
            timeoutMs: 5000
          }).catch(err => {
            // LoginWithBrowser opens the browser; if it hangs waiting for completion, handle gracefully
          });
          triggerMessage = 'Launched Google OAuth login in your default browser. Complete login to finish switching.';
        } else {
          triggerMessage = 'Antigravity 2.0 connection not available. Open Antigravity 2.0 and log in.';
        }
      } catch (err) {
        triggerMessage = `Initiated switch with notice: ${(err as Error).message}`;
      }
    } else {
      // Antigravity IDE: In-app user interaction is the supported mechanism
      triggerMessage = 'Antigravity IDE is IDLE and ready. In Antigravity IDE, open the Account menu / Command Palette and use "Antigravity: Log In / Sign In", then choose another authorized account.';
    }

    this.activeSession = {
      targetId: target.id,
      targetName: target.name,
      status: 'WAITING',
      oldEmail,
      currentDetectedEmail: oldEmail,
      newEmail: null,
      startedAt: new Date().toISOString(),
      expiresAt,
      elapsedSeconds: 0,
      timeoutSeconds,
      targetHealth: target.isRunning ? 'HEALTHY (RUNNING, IDLE)' : 'OFFLINE',
      message: triggerMessage
    };

    // Begin post-switch verification polling
    this.startVerificationWatcher(target, oldEmail, timeoutSeconds);

    return this.activeSession;
  }

  private startVerificationWatcher(target: TargetState, oldEmail: string | null, timeoutSeconds: number) {
    const started = Date.now();

    this.verificationTimer = setInterval(async () => {
      if (!this.activeSession || this.activeSession.status !== 'WAITING') {
        this.clearTimer();
        return;
      }

      const elapsed = Math.floor((Date.now() - started) / 1000);
      this.activeSession.elapsedSeconds = elapsed;

      // Check timeout
      if (Date.now() - started >= timeoutSeconds * 1000) {
        this.activeSession.status = 'TIMEOUT';
        this.activeSession.message = `TIMEOUT — NO IDENTITY CHANGE. No account change detected on ${target.name} within 5 minutes (${timeoutSeconds}s). Local state was not altered.`;
        this.clearTimer();
        return;
      }

      // Trigger live refresh to detect identity change
      if (this.pollTriggerCallback) {
        try {
          await this.pollTriggerCallback();
        } catch (_) {}
      }
    }, 2000);
  }

  notifyTargetStatusUpdated(targetId: TargetId, currentEmail: string | null) {
    if (!this.activeSession || this.activeSession.targetId !== targetId) {
      return;
    }

    if (this.activeSession.status !== 'WAITING') {
      return;
    }

    this.activeSession.currentDetectedEmail = currentEmail;

    const oldEmail = this.activeSession.oldEmail?.trim().toLowerCase() || null;
    const current = currentEmail?.trim().toLowerCase() || null;

    // Detect identity change: old email != new email
    if (current && current !== oldEmail) {
      this.activeSession.status = 'SUCCESS';
      this.activeSession.newEmail = currentEmail;
      this.activeSession.message = `SUCCESS: ${this.activeSession.targetName} account switched from ${this.activeSession.oldEmail || 'None'} to ${currentEmail}! Fresh telemetry loaded.`;
      this.clearTimer();

      if (this.onSwitchSuccessCallback && currentEmail) {
        this.onSwitchSuccessCallback(targetId, currentEmail).catch(() => {});
      }
    }
  }

  cancelSwitch(): void {
    if (this.activeSession && this.activeSession.status === 'WAITING') {
      this.activeSession.status = 'CANCELLED';
      this.activeSession.message = 'Account switch was cancelled by user.';
    }
    this.clearTimer();
  }

  private clearTimer() {
    if (this.verificationTimer) {
      clearInterval(this.verificationTimer);
      this.verificationTimer = null;
    }
  }
}
