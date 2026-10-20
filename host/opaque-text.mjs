// Shared exact raw-text/textarea offset mapping; refusal preserves ambiguity.
export const displayModelText=(raw)=>raw.replace(/\r\n?/g,'\n');
function rawOffset(raw,position){
 const display=displayModelText(raw);if(!Number.isSafeInteger(position)||position<0||position>display.length)throw Error('Replacement edit refused');
 let index=0;for(let n=0;n<position;n++){index+=raw[index]==='\r'&&raw[index+1]==='\n'?2:1;}return index;
}
export function spliceModelText(raw,start,end,text){if(end<start)throw Error('Replacement edit refused');return raw.slice(0,rawOffset(raw,start))+text+raw.slice(rawOffset(raw,end));}
export function reconcileModelText(raw,next){
 const before=displayModelText(raw);if(next!==displayModelText(next))throw Error('Replacement edit refused');if(before===next)return raw;
 // Equal displayed spans can contain different raw CRLF/LF/CR. Without an
 // event anchor, accept only when every minimal splice produces identical raw text.
 if(!raw.includes('\r'))return next;
 let prefix=0;while(prefix<before.length&&prefix<next.length&&before[prefix]===next[prefix])prefix++;
 let suffix=0;while(suffix<before.length&&suffix<next.length&&before[before.length-1-suffix]===next[next.length-1-suffix])suffix++;
 const matched=Math.min(before.length,next.length,prefix+suffix);let result=null;
 for(let start=Math.max(0,matched-suffix);start<=Math.min(prefix,matched);start++){
  const tail=matched-start,oldEnd=before.length-tail,insertion=next.slice(start,next.length-tail);
  if(raw.slice(rawOffset(raw,start),rawOffset(raw,oldEnd)).includes('\r')&&insertion.includes('\n'))throw Error('Replacement edit ambiguous');
  const candidate=spliceModelText(raw,start,oldEnd,insertion);
  if(result!==null&&result!==candidate)throw Error('Replacement edit ambiguous');result=candidate;
 }
 if(result===null||displayModelText(result)!==next)throw Error('Replacement edit refused');return result;
}
