export interface RuntimeIdentity { report_version:1; status:'reported'|'missing'|'unsafe'|'unsupported'|'unavailable'; binary_version:string|null; running_version:null; package_owner:'unknown'; provenance:'unknown'; installation_eligible:false }
export const parseRuntimeIdentity: (value:unknown)=>RuntimeIdentity;
