/**
 * Hides the token-count and cost stats (↑ ↓ R W $) from the footer stats line,
 * while keeping the context-usage percentage and model/provider display.
 *
 * Works by temporarily making getEntries() return [] (so all totals stay 0)
 * and isUsingOAuth() return false (so the "(sub)" cost item is also suppressed)
 * during each footer render call, then restoring both immediately after.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { FooterComponent } from "@mariozechner/pi-coding-agent";

export default function (_pi: ExtensionAPI) {
  const orig = FooterComponent.prototype.render;

  FooterComponent.prototype.render = function (width: number) {
    const realGetEntries = this.session.sessionManager.getEntries.bind(
      this.session.sessionManager,
    );
    const realIsUsingOAuth = this.session.modelRegistry.isUsingOAuth.bind(
      this.session.modelRegistry,
    );

    this.session.sessionManager.getEntries = () => [];
    this.session.modelRegistry.isUsingOAuth = () => false;

    try {
      return orig.call(this, width);
    } finally {
      this.session.sessionManager.getEntries = realGetEntries;
      this.session.modelRegistry.isUsingOAuth = realIsUsingOAuth;
    }
  };
}
