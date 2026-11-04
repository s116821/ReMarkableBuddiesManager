import {Component,ChangeDetectionStrategy,effect,input,output,signal,type OnDestroy} from '@angular/core';
import type {ServiceStopController,ServiceStopUiState} from './service-stop';
import type {ServiceStopAdapter} from './service-stop';
import type {TabletObservation} from './observation';
import type {ServiceStopRetained} from '../host/service-stop-protocol.mjs';
@Component({selector:'service-stop-panel',standalone:true,changeDetection:ChangeDetectionStrategy.OnPush,template:`
 <h2>Stop Buddy</h2>
 <p>Request a stop of the fixed Buddy service. Native recovery and saved data remain unverified. No automatic retry.</p>
 <button class="ui-button ui-button-primary" (click)="review()" [disabled]="!allowed() || state().busy">Review stopping Buddy</button>
 @if(state().busy){<button class="ui-button" (click)="stop()">Stop waiting for Buddy stop</button>}
 <p role="status" data-testid="service-stop-status">{{state().status}}</p>
 @if(state().view?.state==='ready'){
  <p>The service's qualified stop policy may escalate. Stopping this wait does not cancel the service job.</p>
  <button class="ui-button ui-button-primary" (click)="confirm()" [disabled]="!allowed() || state().busy">Stop Buddy</button>
 }
 @if(state().view?.current;as current){<p>Current service: {{current.state}}. Earlier request outcome unchanged.</p>}
 @for(row of state().retained;track row.reference){
  <p>{{row.outcome==='unknown'?'Stop request unconfirmed':'Stop request accepted'}} — shutdown and recovery unverified.</p>
  <button class="ui-button" (click)="check(row)" [disabled]="!allowed() || state().busy || row.connection_id!==tablet()?.connection_id || row.boot_id!==tablet()?.boot_id">Check service state</button>
 }
`})
export class ServiceStopPanel implements OnDestroy{
 readonly adapter=input.required<ServiceStopAdapter>();readonly tablet=input<TabletObservation|null>(null);readonly allowed=input(false);readonly epoch=input(0);readonly pause=input.required<()=>Promise<boolean>>();
 readonly busy=output<boolean>();readonly starting=output<void>();
 private controller:ServiceStopController|null=null;private generation=0;private loading=false;
 readonly state=signal<ServiceStopUiState>({status:'Buddy stop not reviewed',busy:false,view:null,retained:[]});
 constructor(){effect(()=>{this.epoch();this.clear();});}
 private clear(){this.generation++;this.loading=false;this.controller?.clear();this.state.update(s=>({...s,busy:false}));this.busy.emit(false);}
 stop(){this.generation++;this.loading=false;this.controller?.stop();this.state.update(s=>({...s,busy:false}));this.busy.emit(false);}
 private async run(action:'review'|'confirm'|'check',r?:ServiceStopRetained){
  const t=this.tablet();if(!t||!this.allowed()||this.state().busy||this.loading)return;
  const g=++this.generation;this.loading=true;this.state.update(s=>({...s,busy:true}));this.busy.emit(true);
  try{const {ServiceStopController}=await import('./service-stop');if(g!==this.generation)return;
   this.controller??=new ServiceStopController(s=>{this.state.set(s);this.busy.emit(s.busy);});
   if(action!=='confirm')this.starting.emit();
   if(action==='review')await this.controller.begin(this.adapter(),t,this.pause());
   else if(action==='confirm')await this.controller.confirm(this.adapter(),t,this.pause());
   else if(r)await this.controller.refresh(this.adapter(),t,r,this.pause());
  }catch{if(g===this.generation)this.state.update(s=>({...s,status:'Buddy stop unavailable',busy:false}));}
  finally{if(g===this.generation){this.loading=false;this.state.update(s=>({...s,busy:false}));this.busy.emit(false);}}
 }
 async review(){await this.run('review');}
 async confirm(){await this.run('confirm');}
 async check(r:ServiceStopRetained){await this.run('check',r);}
 ngOnDestroy(){this.clear();}
}
