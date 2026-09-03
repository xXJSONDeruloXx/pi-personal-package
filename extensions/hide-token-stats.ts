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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FooterComponent } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  if (typeof FooterComponent.prototype.render !== "function") {
    let warned = false;
    pi.on("session_start", async (_event, ctx) => {
      if (!warned && ctx.hasUI) {
        warned = true;
        ctx.ui.notify(
          "hide-token-stats: FooterComponent.render is unavailable; token stats will remain visible.",
          "warning",
        );
      }
    });
    return;
  }

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
