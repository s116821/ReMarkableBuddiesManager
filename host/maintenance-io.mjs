// Host-private ownership only. Explicit external cancellation revokes; stale
// retained references may neither cancel nor release an unrelated invocation.
export class MaintenanceIO {
  #owner=null;#reservation=null;#submissions=new Map();
  acquire(lane,reference,operation){if(this.#owner||this.#reservation&&(this.#reservation.lane!==lane||!this.#reservation.references.has(reference)))return null;return this.#owner=Object.freeze({lane,reference,operation,identity:Symbol('maintenance invocation')});}
  reserve(lane,reference){if(this.#reservation&&this.#reservation.lane!==lane)return false;this.#reservation??={lane,references:new Set()};if(this.#reservation.references.size>=8&&!this.#reservation.references.has(reference))return false;this.#reservation.references.add(reference);return true;}
  settle(lane,reference){if(this.#reservation?.lane===lane){this.#reservation.references.delete(reference);if(!this.#reservation.references.size)this.#reservation=null;}}
  maySubmit(connection,lane,reference){const v=this.#submissions.get(connection);return !v||v.lane===lane&&(lane==='service-stop'||v.references.has(reference));}
  fence(connection,lane,reference){const v=this.#submissions.get(connection);if(v&&v.lane!==lane||!v&&this.#submissions.size>=32)return false;if(v)v.references.add(reference);else this.#submissions.set(connection,{lane,references:new Set([reference])});return true;}
  clearFence(connection,lane,reference){const v=this.#submissions.get(connection);if(v?.lane===lane){v.references.delete(reference);if(!v.references.size)this.#submissions.delete(connection);}}
  owns(token){return token!==null&&token===this.#owner;}
  ownerFor(lane,reference){return this.#owner?.lane===lane&&this.#owner.reference===reference?this.#owner:null;}
  release(token){if(this.owns(token))this.#owner=null;}
  revoke(){this.#owner=null;}
}
