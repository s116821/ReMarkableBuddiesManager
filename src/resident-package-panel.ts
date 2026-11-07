import {Component,ChangeDetectionStrategy,effect,input,output,signal,type OnDestroy} from '@angular/core';
import type {ResidentPackageController,ResidentPackageAdapter,PackageUiState} from './resident-package';
import type {TabletObservation} from './observation';
import type {PackageOperation,PackageRetained} from '../host/resident-package-protocol.mjs';
@Component({selector:'resident-package-panel',standalone:true,changeDetection:ChangeDetectionStrategy.OnPush,template:`
 <h2>Buddy package controls</h2>
 <p>Disable startup, remove Buddy while preserving user data, or replace it with an approved release.</p>
 <button class="ui-button" (click)="review('disable')" [disabled]="!canReview()">Review disabling startup</button>
 <button class="ui-button" (click)="review('remove')" [disabled]="!canReview()">Review removing Buddy</button>
 <button class="ui-button" (click)="review('replace')" [disabled]="!canReview()">Review replacing Buddy</button>
 <button class="ui-button" (click)="retained()" [disabled]="state().busy">Show earlier package operations</button>
 @if(state().busy){<button class="ui-button" (click)="stop()">Stop waiting for package change</button>}
 <p role="status" data-testid="resident-package-status">{{state().status}}</p>
 @if(state().view?.state==='ready'){
  <p>{{consequence()}} User data is preserved. Stopping this wait does not cancel a submitted change.</p>
  @if(state().view?.current?.candidate_version;as candidate){<p>Replace {{state().view?.current?.installed_version}} with {{candidate}}. An older version may not understand newer saved data.</p>}
  <button class="ui-button ui-button-primary" (click)="confirm()" [disabled]="!allowed() || state().busy">Confirm package change</button>
 }
 @for(row of state().retained;track row.reference){
  <p>{{row.operation}}: {{row.state==='completed'?'Requested change verified':row.state==='continuable'?'Intermediate step verified — requested change unfinished':'Outcome unconfirmed'}}.</p>
  <button class="ui-button" (click)="check(row)" [disabled]="!canCheck(row)">Check original package operation</button>
  @if(row.state==='continuable'){<button class="ui-button" (click)="check(row,true)" [disabled]="!canCheck(row)">Review remaining step</button>}
 }
`})
export class ResidentPackagePanel implements OnDestroy{
 readonly adapter=input.required<ResidentPackageAdapter>();readonly tablet=input<TabletObservation|null>(null);readonly allowed=input(false);readonly epoch=input(0);readonly pause=input.required<()=>Promise<boolean>>();readonly busy=output<boolean>();readonly starting=output<void>();
 readonly state=signal<PackageUiState>({busy:false,status:'Package controls not reviewed',view:null,retained:[]});
 private controller:ResidentPackageController|null=null;private generation=0;
 private async run(action:'review'|'confirm'|'check'|'retained',operation?:PackageOperation,row?:PackageRetained,resume=false){
  if(this.state().busy)return;const t=this.tablet();if(action!=='retained'&&(!t||!this.allowed()))return;
  const g=++this.generation,deadline=performance.now()+14000;let timer:ReturnType<typeof setTimeout>|undefined;
  this.state.update(s=>({...s,busy:true}));this.busy.emit(true);
  try{const module=await Promise.race([import('./resident-package'),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Package controls unavailable')),Math.max(1,deadline-performance.now()));})]);clearTimeout(timer);if(g!==this.generation||performance.now()>=deadline)return;
   const c=this.controller??=new module.ResidentPackageController(s=>{this.state.set(s);this.busy.emit(s.busy);});
   if(action==='retained')await c.retained(this.adapter(),deadline);
   else if(action==='review'&&t&&operation)await c.begin(this.adapter(),t,operation,this.pause(),deadline);
   else if(action==='confirm'&&t)await c.confirm(this.adapter(),t,this.pause(),deadline);
   else if(t&&row)await c.check(this.adapter(),t,row,this.pause(),resume,deadline);
  }catch{if(g===this.generation){this.controller?.clear();this.state.update(s=>({...s,view:null,status:'Package controls unavailable'}));}}
  finally{clearTimeout(timer);if(g===this.generation){this.state.update(s=>({...s,busy:false}));this.busy.emit(false);}}
 }
 constructor(){effect(()=>{this.epoch();this.stop();});}
 canReview(){const t=this.tablet();return !!t&&this.allowed()&&!this.state().busy&&!this.state().retained.some(r=>r.connection_id===t.connection_id&&r.state!=='completed');}
 canCheck(r:PackageRetained){const t=this.tablet();return !!t&&this.allowed()&&!this.state().busy&&r.connection_id===t.connection_id&&r.boot_id===t.boot_id;}
 consequence(){return ({disable:'Buddy will no longer start automatically.',remove:'The owned Buddy package will be removed.',replace:'The installed Buddy package will be replaced.'})[this.state().view?.operation??'disable'];}
 async review(operation:PackageOperation){if(!this.canReview())return;this.starting.emit();await this.run('review',operation);}
 async confirm(){await this.run('confirm');}
 async check(r:PackageRetained,resume=false){if(!this.canCheck(r))return;this.starting.emit();await this.run('check',undefined,r,resume);}
 async retained(){await this.run('retained');}
 stop(){this.generation++;this.controller?.clear();this.state.update(s=>({...s,busy:false}));this.busy.emit(false);}
 ngOnDestroy(){this.generation++;this.controller?.clear();}
}
