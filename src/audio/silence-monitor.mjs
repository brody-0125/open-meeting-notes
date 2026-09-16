import { SilencePolicy } from './silence.mjs';

// Pure orchestration boundary. Runtime supplies actual VAD observations and
// runs tick with the same monotonic clock; no unobserved audio becomes silence.
export class SilenceMonitor {
  constructor({ onState, onStop, policy = new SilencePolicy() }) {
    this.policy = policy; this.onState = onState; this.onStop = onStop; this.closed = false;
  }
  observe(source, observation) { if (!this.closed) this.policy.observe(source, observation); }
  tick(now) {
    if (this.closed) return;
    const state = this.policy.evaluate(now);
    this.onState(state, now);
    // UI callback can extend or close synchronously. Recheck the policy token.
    if (!this.closed && state.type === 'warning' && this.policy.confirm(state.token, now)) {
      this.closed = true; this.onStop();
    }
  }
  extend(now) { if (!this.closed) this.policy.extend(now); }
  close() { this.closed = true; this.policy.pause(); }
}
