// Host-private ownership only. Explicit external cancellation revokes; stale
// retained references may neither cancel nor release an unrelated invocation.
export class MaintenanceIO {
  #owner=null;
  acquire(lane,reference,operation){if(this.#owner)return null;return this.#owner=Object.freeze({lane,reference,operation,identity:Symbol('maintenance invocation')});}
  owns(token){return token!==null&&token===this.#owner;}
  ownerFor(lane,reference){return this.#owner?.lane===lane&&this.#owner.reference===reference?this.#owner:null;}
  release(token){if(this.owns(token))this.#owner=null;}
  revoke(){this.#owner=null;}
}
