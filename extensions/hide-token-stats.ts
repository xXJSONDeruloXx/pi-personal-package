/**
 * Hides the token-count and cost stats (↑ ↓ R W $) from the footer stats line,
 * while keeping the context-usage percentage and model/provider display.
 *
 * Works by temporarily making getEntries() return [] (so all totals stay 0)
 * and isUsingOAuth() return false (so the "(sub)" cost item is also suppressed)
 * during each footer render call, then restoring both immediately after.
 *
 * Pi 0.80 moved isUsingOAuth() from modelRegistry to modelRuntime. Support
 * both locations so the extension also keeps working with older Pi versions.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { FooterComponent } from "@mariozechner/pi-coding-agent";

export default function (_pi: ExtensionAPI) {
  const orig = FooterComponent.prototype.render;

  FooterComponent.prototype.render = function (width: number) {
    const session = this.session as typeof this.session & {
      modelRegistry?: { isUsingOAuth: (...args: unknown[]) => boolean };
      modelRuntime?: { isUsingOAuth: (...args: unknown[]) => boolean };
    };
    const sessionManager = session.sessionManager;
    const authSource = session.modelRuntime ?? session.modelRegistry;
    const realGetEntries = sessionManager.getEntries;
    const realIsUsingOAuth = authSource?.isUsingOAuth;

    sessionManager.getEntries = () => [];
    if (authSource) authSource.isUsingOAuth = () => false;

    try {
      return orig.call(this, width);
    } finally {
      sessionManager.getEntries = realGetEntries;
      if (authSource && realIsUsingOAuth) {
        authSource.isUsingOAuth = realIsUsingOAuth;
      }
    }
  };
}
