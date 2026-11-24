// Host-private ownership only. Explicit external cancellation revokes; stale
// retained references may neither cancel nor release an unrelated invocation.
export class MaintenanceIO {
  #owner = null;
  #joined = false;

  acquire(lane, reference, operation, {joined = false} = {}) {
    if (this.#owner) return null;
    this.#joined = joined;
    return this.#owner = Object.freeze({lane, reference, operation, identity: Symbol('maintenance invocation')});
  }
  owns(token){return token!==null&&token===this.#owner;}
  ownerFor(lane,reference){return this.#owner?.lane===lane&&this.#owner.reference===reference?this.#owner:null;}
  release(token) {
    if (this.owns(token)) {
      this.#owner = null;
      this.#joined = false;
    }
  }

  revoke() {
    if (this.#joined) return false;
    this.#owner = null;
    return true;
  }
}
