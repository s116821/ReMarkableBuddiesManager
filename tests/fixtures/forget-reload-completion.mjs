// A network terminal event alone does not establish renderer consumption.
// In the captured CI case Chromium reports ERR_ABORTED after EOF and correct UI.
export function completeForgetReload({events,readerEvents,unknownRendered}){
 if(unknownRendered!==true||!Array.isArray(events)||!Array.isArray(readerEvents))return false;
 if(events.filter(x=>x.event==='startup-status-request').length!==1)return false;
 const headers=events.filter(x=>x.event==='startup-status-headers'),terminal=events.filter(x=>['startup-status-finished','startup-status-failed'].includes(x.event));
 if(headers.length!==1||headers[0].status!==200||terminal.length!==1||terminal[0].event==='startup-status-failed'&&terminal[0].reason!=='net::ERR_ABORTED')return false;
 // Require the bounded reader's entire successful lifecycle, with >=1 chunk.
 if(readerEvents[0]!=='headers'||readerEvents.at(-3)!=='eof'||readerEvents.at(-2)!=='cancel'||readerEvents.at(-1)!=='cancel-complete')return false;
 const chunks=readerEvents.slice(1,-3);return chunks.length>0&&chunks.every(x=>x==='chunk');
}
